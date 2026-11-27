import "server-only";
import { paginate, type CoreClient } from "@monorise-team/sdk";
import { HIRAHR_PERMISSIONS, type Unit } from "@hirahr/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { createUserCoreClient, getMachineCoreClient } from "./core";

/**
 * Katalog firmy z MonoriseCore dla HiraHR: pracownicy (imię, nazwisko, konto, status) i ich członkostwa
 * w jednostkach. Od członkostw zależy, czyje kartoteki widzi osoba z uprawnieniem ograniczonym do jednostek,
 * więc przy awarii Core odpowiadamy `503` (fail-closed) i nigdy nie zapamiętujemy błędu.
 * HiraHR nie kopiuje struktury firmy do swojej bazy (spec §9.6); dane trzymamy krótko w pamięci procesu.
 */

export const DIRECTORY_TTL_MS = 60 * 1_000;
export const DIRECTORY_MAX_ORGS = 500;
/** Limit stron po 100 rekordów (5000 pracowników i członkostw) przy jednym odświeżeniu. */
export const DIRECTORY_MAX_PAGES = 50;

export const DIRECTORY_UNAVAILABLE_MESSAGE = "Katalog pracowników MonoriseCore jest chwilowo niedostępny";

export interface DirectoryPerson {
  readonly employeeId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly accountId: string | null;
  readonly status: string;
}

export interface OrganizationDirectory {
  readonly people: ReadonlyMap<string, DirectoryPerson>;
  readonly unitsByEmployee: ReadonlyMap<string, readonly string[]>;
  readonly peopleByAccount: ReadonlyMap<string, DirectoryPerson>;
}

interface CacheEntry {
  readonly directory: OrganizationDirectory;
  readonly expiresAt: number;
}

const processGlobal = globalThis as typeof globalThis & {
  __hirahrDirectoryCache?: Map<string, CacheEntry>;
  __hirahrDirectoryInFlight?: Map<string, Promise<OrganizationDirectory>>;
};
const cache = (processGlobal.__hirahrDirectoryCache ??= new Map());
const inFlight = (processGlobal.__hirahrDirectoryInFlight ??= new Map());

/** Czyści pamięć katalogu (całą albo jednej firmy), np. w testach albo po zdarzeniu zmiany struktury. */
export function invalidateDirectoryCache(organizationId?: string): void {
  if (organizationId) {
    cache.delete(organizationId);
    inFlight.delete(organizationId);
  } else {
    cache.clear();
    inFlight.clear();
  }
}

async function loadDirectory(
  organizationId: string,
  core: Pick<CoreClient, "listProductDirectoryEmployees" | "listProductDirectoryUnitMembers">,
): Promise<OrganizationDirectory> {
  const people = new Map<string, DirectoryPerson>();
  const peopleByAccount = new Map<string, DirectoryPerson>();
  const units = new Map<string, string[]>();

  for await (const employee of paginate(core.listProductDirectoryEmployees, {
    path: { productKey: HIRAHR_PERMISSIONS.product },
    query: { organizationId, limit: 100 },
  })) {
    const person: DirectoryPerson = {
      employeeId: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      fullName: `${employee.firstName} ${employee.lastName}`.trim(),
      accountId: employee.accountId,
      status: employee.status,
    };
    people.set(employee.id, person);
    if (employee.accountId) peopleByAccount.set(employee.accountId, person);
    if (people.size >= DIRECTORY_MAX_PAGES * 100) {
      console.warn("[hirahr.directory] Katalog firmy przekracza limit pracowników; lista jest niepełna");
      break;
    }
  }

  let memberships = 0;
  for await (const member of paginate(core.listProductDirectoryUnitMembers, {
    path: { productKey: HIRAHR_PERMISSIONS.product },
    query: { organizationId, limit: 100 },
  })) {
    const list = units.get(member.employeeId) ?? [];
    if (!list.includes(member.unitId)) list.push(member.unitId);
    units.set(member.employeeId, list);
    if (++memberships >= DIRECTORY_MAX_PAGES * 100 * 4) {
      console.warn("[hirahr.directory] Katalog firmy przekracza limit członkostw; lista jest niepełna");
      break;
    }
  }

  return { people, unitsByEmployee: units, peopleByAccount };
}

/**
 * Katalog firmy z pamięci (60 s, jedno pobranie naraz na firmę). Błąd Core kończy się `503`
 * i nie trafia do pamięci, więc kolejne żądanie spróbuje ponownie.
 */
export async function getOrganizationDirectory(
  organizationId: string,
  options: {
    core?: Pick<CoreClient, "listProductDirectoryEmployees" | "listProductDirectoryUnitMembers">;
    now?: () => number;
  } = {},
): Promise<OrganizationDirectory> {
  const now = options.now ?? Date.now;
  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > now()) {
    return cached.directory;
  }
  const pending = inFlight.get(organizationId);
  if (pending) return pending;

  const promise = loadDirectory(organizationId, options.core ?? getMachineCoreClient())
    .then((directory) => {
      if (cache.size >= DIRECTORY_MAX_ORGS && !cache.has(organizationId)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(organizationId, { directory, expiresAt: now() + DIRECTORY_TTL_MS });
      return directory;
    })
    .catch((error: unknown) => {
      if (error instanceof ApiFailure && error.status !== 503) throw error;
      console.warn(
        `[hirahr.directory] Nie udało się pobrać katalogu firmy (${error instanceof Error ? error.name : "błąd"})`,
      );
      throw new ApiFailure(503, "INTERNAL_ERROR", DIRECTORY_UNAVAILABLE_MESSAGE);
    })
    .finally(() => {
      inFlight.delete(organizationId);
    });
  inFlight.set(organizationId, promise);
  return promise;
}

/**
 * Jednostki firmy z MonoriseCore (`GET /core/v1/units`) w imieniu zalogowanej osoby; tylko sesja przeglądarki
 * (token Bearer ma odbiorcę HiraHR API, nie Core API). Używane do nazw jednostek w filtrach i na kartach.
 */
export async function listUnits(caller: Caller): Promise<Unit[]> {
  if (!caller.session) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Lista jednostek jest dostępna tylko w sesji przeglądarki");
  }
  const core = createUserCoreClient(caller.session);
  const units: Unit[] = [];
  try {
    for await (const unit of paginate(core.listUnits, { query: { limit: 100 } })) {
      if (unit.status !== "ACTIVE") continue;
      units.push({ id: unit.id, name: unit.name, type: unit.type, parentId: unit.parentId });
      if (units.length >= 5_000) break;
    }
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    console.warn(`[hirahr.directory] Nie udało się pobrać jednostek (${error instanceof Error ? error.name : "błąd"})`);
    throw new ApiFailure(503, "INTERNAL_ERROR", DIRECTORY_UNAVAILABLE_MESSAGE);
  }
  return units.sort((a, b) => a.name.localeCompare(b.name, "pl"));
}
