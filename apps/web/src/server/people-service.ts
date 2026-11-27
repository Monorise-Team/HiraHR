import "server-only";
import { scopeOf } from "@monorise-team/permissions";
import {
  contractViolations,
  CreateContractInput,
  CursorQuery,
  HIRAHR_PERMISSIONS,
  PeopleListQuery,
  Salary,
  UpdateContractInput,
  UpdateProfileInput,
  UpdateSensitiveInput,
  type Address,
  type ContractType,
  type EmergencyContact,
  type EmploymentContract,
  type PaginatedResult,
  type PersonCard,
  type PersonListItem,
  type SensitiveAccessLogEntry,
  type SensitiveData,
  type SensitiveField,
  type Unit,
} from "@hirahr/contracts";
import { Prisma, uuidv7, withUser, type Tx } from "@hirahr/db";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getOrganizationDirectory, listUnits as listCoreUnits } from "./core-directory";
import { getDb } from "./db";
import { decryptField, encryptField } from "./field-encryption";
import {
  isVisibleStatus,
  loadPersonContext,
  PERSON_NOT_FOUND_MESSAGE,
  scopeCoversPerson,
  type PersonContext,
} from "./people-access";
import { pageByOffset } from "./pagination";
import { assertProductAccess, getPermissionSnapshot } from "./permissions";

// ── Pomocnicze ──────────────────────────────────────────────────────────────

const CONTRACT_NOT_FOUND_MESSAGE = "Nie znaleziono umowy";

export function toIsoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function fromIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Dzisiejsza data kalendarzowa w Polsce (umowa „obecna” liczy się według polskiego dnia). */
export function todayInPoland(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseFte(value: string | null | undefined): { numerator: number | null; denominator: number | null } {
  if (!value) return { numerator: null, denominator: null };
  const [numerator, denominator] = value.split("/").map(Number) as [number, number];
  return { numerator, denominator };
}

function fteToString(numerator: number | null, denominator: number | null): string | null {
  return numerator && denominator ? `${numerator}/${denominator}` : null;
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor<T>(cursor: string | undefined, guard: (value: unknown) => value is T): T | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (guard(value)) return value;
  } catch {
    // niżej wspólny błąd
  }
  throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawny kursor stronicowania", [
    { field: "cursor", message: "Niepoprawny kursor" },
  ]);
}

/** Wyszukiwanie bez polskich znaków: „zolkiewski” znajduje „Żółkiewski” („ł” nie rozkłada się w NFD). */
export function normalizeForSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ł/g, "l");
}

function queryRecord(searchParams: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) record[key] = value;
  return record;
}

function isContractCurrent(startDate: Date, endDate: Date | null, today: string): boolean {
  const start = toIsoDate(startDate)!;
  const end = toIsoDate(endDate);
  return start <= today && (end === null || end >= today);
}

async function appendAccessLog(
  tx: Tx,
  caller: Caller,
  employeeId: string,
  action: "READ" | "UPDATE",
  fields: readonly SensitiveField[],
): Promise<void> {
  if (fields.length === 0) return;
  await tx.sensitiveAccessLog.create({
    data: {
      id: uuidv7(),
      organizationId: caller.organizationId,
      actorAccountId: caller.accountId,
      employeeId,
      action,
      fields: [...fields],
    },
  });
}

// ── Widoki ──────────────────────────────────────────────────────────────────

type ContractRow = {
  id: string;
  type: ContractType;
  startDate: Date;
  endDate: Date | null;
  fteNumerator: number | null;
  fteDenominator: number | null;
  notes: string | null;
  salaryEncrypted: string | null;
  createdAt: Date;
  updatedAt: Date;
  position: { id: string; name: string } | null;
};

function toContractView(row: ContractRow, today: string): EmploymentContract {
  return {
    id: row.id,
    type: row.type,
    startDate: toIsoDate(row.startDate)!,
    endDate: toIsoDate(row.endDate),
    fte: fteToString(row.fteNumerator, row.fteDenominator),
    position: row.position ? { id: row.position.id, name: row.position.name } : null,
    notes: row.notes,
    current: isContractCurrent(row.startDate, row.endDate, today),
    hasSalary: row.salaryEncrypted !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const contractSelect = {
  id: true,
  type: true,
  startDate: true,
  endDate: true,
  fteNumerator: true,
  fteDenominator: true,
  notes: true,
  salaryEncrypted: true,
  createdAt: true,
  updatedAt: true,
  position: { select: { id: true, name: true } },
} as const;

// ── Ludzie ──────────────────────────────────────────────────────────────────

/**
 * Lista ludzi widocznych dla osoby z `hirahr.employees.read` (zakres firmy albo jednostek), z obecną umową
 * i stanowiskiem z HiraHR. Bez tego uprawnienia `403` (własna kartoteka jest w `GET /people/{id}`).
 */
export async function listPeople(
  caller: Caller,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<PersonListItem>> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const scope = scopeOf(snapshot, HIRAHR_PERMISSIONS.keys["employees.read"]);
  if (scope.type === "NONE") {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do przeglądania kartotek");
  }
  const query = PeopleListQuery.parse(queryRecord(searchParams));
  const cursor = decodeCursor(
    query.cursor,
    (value): value is { o: number } =>
      typeof value === "object" &&
      value !== null &&
      Number.isSafeInteger((value as { o?: unknown }).o) &&
      (value as { o: number }).o >= 0,
  );
  const directory = await getOrganizationDirectory(caller.organizationId);
  const needle = query.search ? normalizeForSearch(query.search) : null;

  const visible = [...directory.people.values()]
    .filter((person) => isVisibleStatus(person.status))
    .filter((person) => {
      const unitIds = directory.unitsByEmployee.get(person.employeeId) ?? [];
      if (!scopeCoversPerson(scope, person.employeeId, unitIds)) return false;
      if (query.unitId && !unitIds.includes(query.unitId)) return false;
      if (needle) {
        const haystack = normalizeForSearch(
          `${person.firstName} ${person.lastName} ${person.lastName} ${person.firstName}`,
        );
        if (!haystack.includes(needle)) return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName, "pl") ||
        a.firstName.localeCompare(b.firstName, "pl") ||
        a.employeeId.localeCompare(b.employeeId),
    );

  const offset = cursor?.o ?? 0;
  const page = visible.slice(offset, offset + query.limit);
  const nextCursor = offset + query.limit < visible.length ? encodeCursor({ o: offset + query.limit }) : null;

  const today = todayInPoland();
  const ids = page.map((person) => person.employeeId);
  const contracts = ids.length
    ? await withUser(getDb(), caller, (tx) =>
        tx.employmentContract.findMany({
          where: {
            employeeId: { in: ids },
            startDate: { lte: fromIsoDate(today) },
            OR: [{ endDate: null }, { endDate: { gte: fromIsoDate(today) } }],
          },
          orderBy: [{ startDate: "desc" }, { id: "desc" }],
          select: { employeeId: true, type: true, position: { select: { id: true, name: true } } },
        }),
      )
    : [];
  const currentByEmployee = new Map<string, (typeof contracts)[number]>();
  for (const contract of contracts) {
    if (!currentByEmployee.has(contract.employeeId)) currentByEmployee.set(contract.employeeId, contract);
  }

  return {
    items: page.map((person) => {
      const current = currentByEmployee.get(person.employeeId);
      return {
        employeeId: person.employeeId,
        firstName: person.firstName,
        lastName: person.lastName,
        fullName: person.fullName,
        status: person.status,
        unitIds: [...(directory.unitsByEmployee.get(person.employeeId) ?? [])],
        currentContractType: current?.type ?? null,
        currentPosition: current?.position ?? null,
      };
    }),
    nextCursor,
  };
}

async function buildCard(caller: Caller, context: PersonContext): Promise<PersonCard> {
  const employeeId = context.person.employeeId;
  const { profile, contracts } = await withUser(getDb(), caller, async (tx) => ({
    profile: await tx.employeeProfile.findUnique({
      where: { organizationId_employeeId: { organizationId: caller.organizationId, employeeId } },
    }),
    contracts: await tx.employmentContract.findMany({
      where: { employeeId },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      select: contractSelect,
    }),
  }));
  const today = todayInPoland();
  return {
    employeeId,
    firstName: context.person.firstName,
    lastName: context.person.lastName,
    fullName: context.person.fullName,
    status: context.person.status,
    unitIds: [...context.unitIds],
    profile: {
      dateOfBirth: toIsoDate(profile?.dateOfBirth ?? null),
      personalEmail: profile?.personalEmail ?? null,
      personalPhone: profile?.personalPhone ?? null,
      homeAddress: (profile?.homeAddress as Address | null | undefined) ?? null,
      mailingAddress: (profile?.mailingAddress as Address | null | undefined) ?? null,
      emergencyContact: (profile?.emergencyContact as EmergencyContact | null | undefined) ?? null,
      updatedAt: profile?.updatedAt.toISOString() ?? null,
    },
    contracts: contracts.map((row) => toContractView(row, today)),
    sensitive: {
      pesel: Boolean(profile?.peselEncrypted),
      bankAccount: Boolean(profile?.bankAccountEncrypted),
      idDocumentNumber: Boolean(profile?.idDocumentEncrypted),
    },
    access: context.access,
  };
}

/** Karta osoby: dane z Core, kartoteka, umowy (bez wynagrodzeń) i informacja, które dane wrażliwe są wpisane. */
export async function getPersonCard(caller: Caller, employeeId: string): Promise<PersonCard> {
  return buildCard(caller, await loadPersonContext(caller, employeeId));
}

/** Zmiana kartoteki (bez danych wrażliwych): sama osoba albo `employees.update` w zasięgu. */
export async function updatePersonProfile(caller: Caller, employeeId: string, raw: unknown): Promise<PersonCard> {
  const context = await loadPersonContext(caller, employeeId);
  if (!context.access.canUpdateProfile) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do zmiany tej kartoteki");
  }
  const input = UpdateProfileInput.parse(raw);
  const data = {
    ...(input.dateOfBirth !== undefined
      ? { dateOfBirth: input.dateOfBirth ? fromIsoDate(input.dateOfBirth) : null }
      : {}),
    ...(input.personalEmail !== undefined ? { personalEmail: input.personalEmail } : {}),
    ...(input.personalPhone !== undefined ? { personalPhone: input.personalPhone || null } : {}),
    ...(input.homeAddress !== undefined ? { homeAddress: input.homeAddress ?? dbNull() } : {}),
    ...(input.mailingAddress !== undefined ? { mailingAddress: input.mailingAddress ?? dbNull() } : {}),
    ...(input.emergencyContact !== undefined ? { emergencyContact: input.emergencyContact ?? dbNull() } : {}),
    updatedByAccountId: caller.accountId,
  };
  await withUser(getDb(), caller, (tx) =>
    tx.employeeProfile.upsert({
      where: { organizationId_employeeId: { organizationId: caller.organizationId, employeeId } },
      create: { organizationId: caller.organizationId, employeeId, ...data },
      update: data,
    }),
  );
  return buildCard(caller, context);
}

/** `Prisma.DbNull` bez importu całego klienta w typach widoku (czyści kolumnę JSONB). */
function dbNull() {
  return Prisma.DbNull;
}

// ── Dane wrażliwe ───────────────────────────────────────────────────────────

const PROFILE_SENSITIVE_COLUMNS = {
  pesel: "peselEncrypted",
  bankAccount: "bankAccountEncrypted",
  idDocumentNumber: "idDocumentEncrypted",
} as const;

/**
 * Odczyt danych wrażliwych na wyraźne żądanie: sama osoba albo `hirahr.sensitive.read` w zakresie całej firmy.
 * Każdy odczyt trafia do dziennika (kto, czyje dane, które pola), bez samych wartości.
 */
export async function getSensitiveData(caller: Caller, employeeId: string): Promise<SensitiveData> {
  const context = await loadPersonContext(caller, employeeId);
  if (!context.access.canReadSensitive) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do danych wrażliwych");
  }
  return withUser(getDb(), caller, async (tx) => {
    const profile = await tx.employeeProfile.findUnique({
      where: { organizationId_employeeId: { organizationId: caller.organizationId, employeeId } },
      select: { peselEncrypted: true, bankAccountEncrypted: true, idDocumentEncrypted: true },
    });
    const contracts = await tx.employmentContract.findMany({
      where: { employeeId },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      select: { id: true, salaryEncrypted: true },
    });
    const decrypt = (field: keyof typeof PROFILE_SENSITIVE_COLUMNS) => {
      const stored = profile?.[PROFILE_SENSITIVE_COLUMNS[field]];
      return stored
        ? decryptField(stored, { organizationId: caller.organizationId, recordId: employeeId, field })
        : null;
    };
    const data: SensitiveData = {
      pesel: decrypt("pesel"),
      bankAccount: decrypt("bankAccount"),
      idDocumentNumber: decrypt("idDocumentNumber"),
      salaries: contracts.map((contract) => ({
        contractId: contract.id,
        salary: contract.salaryEncrypted
          ? Salary.parse(
              JSON.parse(
                decryptField(contract.salaryEncrypted, {
                  organizationId: caller.organizationId,
                  recordId: contract.id,
                  field: "salary",
                }),
              ),
            )
          : null,
      })),
    };
    await appendAccessLog(tx, caller, employeeId, "READ", ["pesel", "bankAccount", "idDocumentNumber", "salary"]);
    return data;
  });
}

/** Zmiana PESEL-u, rachunku i numeru dokumentu: tylko `hirahr.sensitive.update` w zakresie całej firmy. */
export async function updateSensitiveData(caller: Caller, employeeId: string, raw: unknown): Promise<PersonCard> {
  const context = await loadPersonContext(caller, employeeId);
  if (!context.access.canUpdateSensitive) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do zmiany danych wrażliwych");
  }
  const input = UpdateSensitiveInput.parse(raw);
  const changed: SensitiveField[] = [];
  const data: Record<string, string | null> = {};
  for (const field of ["pesel", "bankAccount", "idDocumentNumber"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    changed.push(field);
    data[PROFILE_SENSITIVE_COLUMNS[field]] =
      value === null
        ? null
        : encryptField(value, { organizationId: caller.organizationId, recordId: employeeId, field });
  }
  await withUser(getDb(), caller, async (tx) => {
    await tx.employeeProfile.upsert({
      where: { organizationId_employeeId: { organizationId: caller.organizationId, employeeId } },
      create: { organizationId: caller.organizationId, employeeId, ...data, updatedByAccountId: caller.accountId },
      update: { ...data, updatedByAccountId: caller.accountId },
    });
    await appendAccessLog(tx, caller, employeeId, "UPDATE", changed);
  });
  return buildCard(caller, context);
}

/** Dziennik dostępu do danych wrażliwych osoby: sama osoba albo `hirahr.sensitive.read` w zakresie firmy. */
export async function listSensitiveAccessLog(
  caller: Caller,
  employeeId: string,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<SensitiveAccessLogEntry>> {
  const context = await loadPersonContext(caller, employeeId);
  if (!context.access.canReadSensitive) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do dziennika danych wrażliwych");
  }
  const query = CursorQuery.parse(queryRecord(searchParams));
  const cursor = decodeCursor(query.cursor, (value): value is { t: string; id: string } => {
    const candidate = value as { t?: unknown; id?: unknown };
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.t === "string" &&
      !Number.isNaN(Date.parse(candidate.t)) &&
      typeof candidate.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(candidate.id)
    );
  });
  const rows = await withUser(getDb(), caller, (tx) =>
    tx.sensitiveAccessLog.findMany({
      where: {
        employeeId,
        ...(cursor
          ? {
              OR: [{ createdAt: { lt: new Date(cursor.t) } }, { createdAt: new Date(cursor.t), id: { lt: cursor.id } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    }),
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      actor: {
        accountId: row.actorAccountId,
        name: context.directory.peopleByAccount.get(row.actorAccountId)?.fullName ?? "Nieznana osoba",
      },
      action: row.action,
      fields: row.fields as SensitiveField[],
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > query.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
  };
}

// ── Umowy ───────────────────────────────────────────────────────────────────

async function assertActivePosition(tx: Tx, positionId: string | null | undefined): Promise<void> {
  if (!positionId) return;
  const position = await tx.position.findFirst({ where: { id: positionId, archivedAt: null }, select: { id: true } });
  if (!position) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "positionId", message: "Nie ma takiego aktywnego stanowiska" },
    ]);
  }
}

function assertSalaryAllowed(context: PersonContext, salaryProvided: boolean): void {
  if (salaryProvided && !context.access.canUpdateSensitive) {
    throw new ApiFailure(
      403,
      "PERMISSION_DENIED",
      "Wynagrodzenie może wpisać tylko osoba z dostępem do danych wrażliwych w całej firmie",
    );
  }
}

/** Nowa umowa: `employees.update` w zasięgu; wynagrodzenie dodatkowo `sensitive.update` w zakresie firmy. */
export async function createContract(caller: Caller, employeeId: string, raw: unknown): Promise<EmploymentContract> {
  const context = await loadPersonContext(caller, employeeId);
  if (!context.access.canManageContracts) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do umów tej osoby");
  }
  const input = CreateContractInput.parse(raw);
  assertSalaryAllowed(context, input.salary !== undefined && input.salary !== null);
  const id = uuidv7();
  const fte = parseFte(input.fte);
  const salaryEncrypted = input.salary
    ? encryptField(JSON.stringify(input.salary), {
        organizationId: caller.organizationId,
        recordId: id,
        field: "salary",
      })
    : null;
  const row = await withUser(getDb(), caller, async (tx) => {
    await assertActivePosition(tx, input.positionId);
    const created = await tx.employmentContract.create({
      data: {
        id,
        organizationId: caller.organizationId,
        employeeId,
        type: input.type,
        startDate: fromIsoDate(input.startDate),
        endDate: input.endDate ? fromIsoDate(input.endDate) : null,
        fteNumerator: fte.numerator,
        fteDenominator: fte.denominator,
        positionId: input.positionId ?? null,
        notes: input.notes || null,
        salaryEncrypted,
        createdByAccountId: caller.accountId,
      },
      select: contractSelect,
    });
    if (salaryEncrypted) await appendAccessLog(tx, caller, employeeId, "UPDATE", ["salary"]);
    return created;
  });
  return toContractView(row, todayInPoland());
}

async function loadContractContext(caller: Caller, contractId: string) {
  const contract = await withUser(getDb(), caller, (tx) =>
    tx.employmentContract.findUnique({
      where: { id: contractId },
      select: { ...contractSelect, employeeId: true, positionId: true },
    }),
  );
  if (!contract) throw new ApiFailure(404, "NOT_FOUND", CONTRACT_NOT_FOUND_MESSAGE);
  let context: PersonContext;
  try {
    context = await loadPersonContext(caller, contract.employeeId);
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) {
      throw new ApiFailure(404, "NOT_FOUND", CONTRACT_NOT_FOUND_MESSAGE);
    }
    throw error;
  }
  if (!context.access.canManageContracts) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do umów tej osoby");
  }
  return { contract, context };
}

/** Zmiana umowy; reguły sprawdzane na rekordzie po scaleniu (np. umowa na czas określony wymaga daty końca). */
export async function updateContract(caller: Caller, contractId: string, raw: unknown): Promise<EmploymentContract> {
  const { contract, context } = await loadContractContext(caller, contractId);
  const input = UpdateContractInput.parse(raw);
  assertSalaryAllowed(context, input.salary !== undefined);

  const merged = {
    type: input.type ?? contract.type,
    startDate: input.startDate ?? toIsoDate(contract.startDate)!,
    endDate: input.endDate !== undefined ? input.endDate : toIsoDate(contract.endDate),
    fte: input.fte !== undefined ? input.fte : fteToString(contract.fteNumerator, contract.fteDenominator),
  };
  const violations = contractViolations(merged, true);
  if (violations.length > 0) {
    throw new ApiFailure(
      422,
      "VALIDATION_FAILED",
      "Niepoprawne dane",
      violations.map((issue) => ({ field: issue.path, message: issue.message })),
    );
  }
  const fte = parseFte(merged.fte);
  const salaryEncrypted =
    input.salary === undefined
      ? undefined
      : input.salary === null
        ? null
        : encryptField(JSON.stringify(input.salary), {
            organizationId: caller.organizationId,
            recordId: contract.id,
            field: "salary",
          });

  const row = await withUser(getDb(), caller, async (tx) => {
    if (input.positionId !== undefined) await assertActivePosition(tx, input.positionId);
    const updated = await tx.employmentContract.update({
      where: { id: contract.id },
      data: {
        type: merged.type,
        startDate: fromIsoDate(merged.startDate),
        endDate: merged.endDate ? fromIsoDate(merged.endDate) : null,
        fteNumerator: fte.numerator,
        fteDenominator: fte.denominator,
        ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
        ...(salaryEncrypted !== undefined ? { salaryEncrypted } : {}),
      },
      select: contractSelect,
    });
    if (salaryEncrypted !== undefined) await appendAccessLog(tx, caller, contract.employeeId, "UPDATE", ["salary"]);
    return updated;
  });
  return toContractView(row, todayInPoland());
}

/** Usunięcie umowy wpisanej przez pomyłkę (historia zatrudnienia to kolejne umowy, nie zmiany jednej). */
export async function deleteContract(caller: Caller, contractId: string): Promise<void> {
  const { contract } = await loadContractContext(caller, contractId);
  await withUser(getDb(), caller, async (tx) => {
    await tx.employmentContract.delete({ where: { id: contract.id } });
    if (contract.salaryEncrypted) await appendAccessLog(tx, caller, contract.employeeId, "UPDATE", ["salary"]);
  });
}

// ── Jednostki ───────────────────────────────────────────────────────────────

/** Aktywne jednostki firmy z Core (nazwy do filtrów i kart); wymaga dostępu do produktu. */
export async function listUnits(caller: Caller, searchParams: URLSearchParams): Promise<PaginatedResult<Unit>> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const query = CursorQuery.parse(queryRecord(searchParams));
  return pageByOffset(await listCoreUnits(caller), query.cursor, query.limit);
}

export { PERSON_NOT_FOUND_MESSAGE };
