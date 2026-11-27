import "server-only";
import { scopeOf, type AccessScope, type PermissionSnapshot } from "@monorise-team/permissions";
import { HIRAHR_PERMISSIONS, type PersonAccess } from "@hirahr/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getOrganizationDirectory, type DirectoryPerson, type OrganizationDirectory } from "./core-directory";
import { assertProductAccess, canOrganizationWide, getPermissionSnapshot } from "./permissions";

/**
 * Kto widzi czyją kartotekę (ADR-0104):
 * - sama osoba zawsze widzi swoją (samoobsługa),
 * - `hirahr.employees.read` w zakresie firmy daje wszystkich, w zakresie jednostek tylko ich członków
 *   (z poddrzewem, ADR-0033), a w zakresie `RESOURCE` pojedyncze osoby (`resourceId` = `employeeId`),
 * - osoba spoza zasięgu dostaje `404`, żeby nie ujawniać, że istnieje (404 przed 403).
 * Członkostwa w jednostkach pochodzą z katalogu Core; przy jego awarii odmawiamy (`503`).
 */

export const PERSON_NOT_FOUND_MESSAGE = "Nie znaleziono osoby";

/** Statusy pracownika Core, których kartoteki nie pokazujemy (dane zanonimizowane). */
const HIDDEN_STATUSES = new Set(["ANONYMIZED"]);

export function scopeCoversPerson(scope: AccessScope, employeeId: string, unitIds: readonly string[]): boolean {
  if (scope.type === "ORGANIZATION") return true;
  if (scope.type === "NONE") return false;
  return scope.unitIds.some((unitId) => unitIds.includes(unitId)) || scope.resourceIds.includes(employeeId);
}

export function isVisibleStatus(status: string): boolean {
  return !HIDDEN_STATUSES.has(status);
}

export interface PersonContext {
  readonly snapshot: PermissionSnapshot;
  readonly directory: OrganizationDirectory;
  readonly person: DirectoryPerson;
  readonly unitIds: readonly string[];
  readonly access: PersonAccess;
}

/** Wylicza dostęp zalogowanej osoby do kartoteki wskazanego pracownika (bez sprawdzania widoczności). */
export function personAccessFor(
  caller: Pick<Caller, "employeeId">,
  snapshot: PermissionSnapshot,
  employeeId: string,
  unitIds: readonly string[],
): PersonAccess & { canRead: boolean } {
  const keys = HIRAHR_PERMISSIONS.keys;
  const self = caller.employeeId === employeeId;
  const canUpdateInScope = scopeCoversPerson(scopeOf(snapshot, keys["employees.update"]), employeeId, unitIds);
  return {
    canRead: self || scopeCoversPerson(scopeOf(snapshot, keys["employees.read"]), employeeId, unitIds),
    self,
    canUpdateProfile: self || canUpdateInScope,
    canManageContracts: canUpdateInScope,
    canReadSensitive: self || canOrganizationWide(snapshot, keys["sensitive.read"]),
    canUpdateSensitive: canOrganizationWide(snapshot, keys["sensitive.update"]),
  };
}

/**
 * Ładuje kontekst kartoteki: migawkę uprawnień, katalog Core i dostęp. Osoba nieistniejąca, zanonimizowana
 * albo spoza zasięgu daje `404 NOT_FOUND`.
 */
export async function loadPersonContext(caller: Caller, employeeId: string): Promise<PersonContext> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const directory = await getOrganizationDirectory(caller.organizationId);
  const person = directory.people.get(employeeId);
  if (!person || !isVisibleStatus(person.status)) {
    throw new ApiFailure(404, "NOT_FOUND", PERSON_NOT_FOUND_MESSAGE);
  }
  const unitIds = directory.unitsByEmployee.get(employeeId) ?? [];
  const { canRead, ...access } = personAccessFor(caller, snapshot, employeeId, unitIds);
  if (!canRead) {
    throw new ApiFailure(404, "NOT_FOUND", PERSON_NOT_FOUND_MESSAGE);
  }
  return { snapshot, directory, person, unitIds, access };
}
