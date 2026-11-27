import "server-only";
import { can, scopeOf, type PermissionSnapshot } from "@monorise-team/permissions";
import {
  CreateLeaveRequestInput,
  DecideLeaveRequestInput,
  EMPLOYMENT_CONTRACT_TYPES,
  HIRAHR_PERMISSIONS,
  HR_ONLY_LEAVE_TYPES,
  LeaveBalanceQuery,
  LeaveCalendarQuery,
  LeaveRequestsQuery,
  ON_DEMAND_YEARLY_LIMIT,
  UpdateLeaveEntitlementInput,
  VACATION_POOL_TYPES,
  WorkingDaysQuery,
  type CalendarAbsence,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveType,
  type PaginatedResult,
  type VacationBaseDays,
} from "@hirahr/contracts";
import { uuidv7, withUser, type Tx } from "@hirahr/db";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getOrganizationDirectory, type DirectoryPerson, type OrganizationDirectory } from "./core-directory";
import { getDb } from "./db";
import { pageByOffset } from "./pagination";
import { isVisibleStatus, PERSON_NOT_FOUND_MESSAGE, scopeCoversPerson } from "./people-access";
import {
  decodeCursor,
  encodeCursor,
  fromIsoDate,
  isContractCurrent,
  queryRecord,
  toIsoDate,
  todayInPoland,
} from "./people-service";
import { assertProductAccess, canOrganizationWide, getPermissionSnapshot } from "./permissions";
import { countWorkingDays } from "@/lib/polish-calendar";

/**
 * Urlopy i nieobecności HiraHR (etap 2, ADR-0104).
 *
 * Kto co widzi i robi:
 * - sama osoba widzi swoje saldo i wnioski bez ról, a składa wnioski z `hirahr.leave.request`,
 * - `hirahr.leave.approve` obejmujące osobę (jednostki z katalogu Core) pozwala zobaczyć i rozpatrzyć jej wnioski,
 *   nigdy własnych,
 * - `hirahr.leave.manage` obejmujące osobę to kadry: salda, wpisy za kogoś (od razu zaakceptowane), wycofanie,
 * - zwolnienie lekarskie (dana o zdrowiu) wpisują i widzą tylko kadry z `leave.manage` w zakresie całej firmy
 *   oraz sama osoba; inni widzą je jako „nieobecność” bez rodzaju i uwag,
 * - w kalendarzu zespołu osoby z tych samych jednostek i z `employees.read` widzą tylko zaakceptowane nieobecności,
 *   bez rodzaju.
 * Saldo i nakładanie się nieobecności sprawdzamy pod blokadą transakcji jednej osoby; dodatkowo baza ma
 * ograniczenie EXCLUDE na nakładające się aktywne wpisy.
 */

export const LEAVE_REQUEST_NOT_FOUND_MESSAGE = "Nie znaleziono wniosku";

const ACTIVE_STATUSES: LeaveStatus[] = ["PENDING", "APPROVED"];
/** Górna granica wierszy liczonych w pamięci (kalendarz, wnioski do akceptacji). */
const MAX_ROWS_IN_MEMORY = 5_000;

function days(value: number): string {
  return value === 1 ? "1 dzień" : `${value} dni`;
}

function yearBounds(year: number): { start: Date; end: Date } {
  return { start: fromIsoDate(`${year}-01-01`), end: fromIsoDate(`${year}-12-31`) };
}

// ── Dostęp ──────────────────────────────────────────────────────────────────

export interface LeaveAccess {
  readonly self: boolean;
  /** Widzi saldo i wnioski osoby. */
  readonly canView: boolean;
  /** Rozpatruje oczekujące wnioski osoby (nigdy własne). */
  readonly canDecide: boolean;
  /** Kadry: saldo, wpisy za osobę, wycofanie dowolnego aktywnego wpisu. */
  readonly canManage: boolean;
  /** Widzi rodzaj „zwolnienie lekarskie” i uwagi do niego. */
  readonly canSeeSick: boolean;
}

export function leaveAccessFor(
  caller: Pick<Caller, "employeeId">,
  snapshot: PermissionSnapshot,
  employeeId: string,
  unitIds: readonly string[],
): LeaveAccess {
  const keys = HIRAHR_PERMISSIONS.keys;
  const self = caller.employeeId === employeeId;
  const approve = scopeCoversPerson(scopeOf(snapshot, keys["leave.approve"]), employeeId, unitIds);
  const manage = scopeCoversPerson(scopeOf(snapshot, keys["leave.manage"]), employeeId, unitIds);
  return {
    self,
    canView: self || approve || manage,
    canDecide: !self && (approve || manage),
    canManage: manage,
    canSeeSick: self || canOrganizationWide(snapshot, keys["leave.manage"]),
  };
}

interface LeaveContext {
  readonly snapshot: PermissionSnapshot;
  readonly directory: OrganizationDirectory;
  readonly person: DirectoryPerson;
  readonly unitIds: readonly string[];
  readonly access: LeaveAccess;
}

/**
 * Kontekst urlopów osoby. Osoba nieistniejąca, zanonimizowana albo całkiem spoza zasięgu daje `404`;
 * osoba, której kartotekę widać (`employees.read`), ale bez praw do urlopów, daje `403`.
 * `hideForbidden` zamienia `403` na `404` (np. gdy żądanie wskazuje wniosek, a nie osobę).
 */
async function loadLeaveContext(
  caller: Caller,
  employeeId: string,
  { hideForbidden = false, notFoundMessage = PERSON_NOT_FOUND_MESSAGE } = {},
): Promise<LeaveContext> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const directory = await getOrganizationDirectory(caller.organizationId);
  const person = directory.people.get(employeeId);
  if (!person || !isVisibleStatus(person.status)) {
    throw new ApiFailure(404, "NOT_FOUND", notFoundMessage);
  }
  const unitIds = directory.unitsByEmployee.get(employeeId) ?? [];
  const access = leaveAccessFor(caller, snapshot, employeeId, unitIds);
  if (!access.canView) {
    const canReadCard = scopeCoversPerson(
      scopeOf(snapshot, HIRAHR_PERMISSIONS.keys["employees.read"]),
      employeeId,
      unitIds,
    );
    if (canReadCard && !hideForbidden) {
      throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do urlopów tej osoby");
    }
    throw new ApiFailure(404, "NOT_FOUND", notFoundMessage);
  }
  return { snapshot, directory, person, unitIds, access };
}

// ── Widoki ──────────────────────────────────────────────────────────────────

type LeaveRequestRow = {
  id: string;
  employeeId: string;
  type: LeaveType;
  startDate: Date;
  endDate: Date;
  workingDays: number;
  status: LeaveStatus;
  note: string | null;
  decisionNote: string | null;
  decidedByAccountId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

const requestSelect = {
  id: true,
  employeeId: true,
  type: true,
  startDate: true,
  endDate: true,
  workingDays: true,
  status: true,
  note: true,
  decisionNote: true,
  decidedByAccountId: true,
  decidedAt: true,
  createdAt: true,
} as const;

function canCancel(row: Pick<LeaveRequestRow, "status" | "startDate">, access: LeaveAccess, today: string): boolean {
  if (row.status === "PENDING") return access.self || access.canManage;
  if (row.status === "APPROVED") return access.canManage || (access.self && toIsoDate(row.startDate)! > today);
  return false;
}

function toRequestView(
  row: LeaveRequestRow,
  directory: OrganizationDirectory,
  access: LeaveAccess,
  today: string,
): LeaveRequest {
  const masked = row.type === "SICK" && !access.canSeeSick;
  const decider = row.decidedByAccountId ? directory.peopleByAccount.get(row.decidedByAccountId) : undefined;
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: directory.people.get(row.employeeId)?.fullName ?? "Nieznana osoba",
    type: masked ? null : row.type,
    startDate: toIsoDate(row.startDate)!,
    endDate: toIsoDate(row.endDate)!,
    workingDays: row.workingDays,
    status: row.status,
    note: masked ? null : row.note,
    decisionNote: masked ? null : row.decisionNote,
    decidedBy: row.decidedByAccountId
      ? { accountId: row.decidedByAccountId, name: decider?.fullName ?? "Nieznana osoba" }
      : null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    access: {
      canCancel: canCancel(row, access, today),
      canDecide: row.status === "PENDING" && access.canDecide,
    },
  };
}

// ── Saldo ───────────────────────────────────────────────────────────────────

/** Wymiar z podstawy (20/26) i etatu obecnej umowy o pracę, zaokrąglony w górę (art. 154 § 2 KP). */
export function suggestEntitledDays(
  baseDays: number | null,
  contract: { fteNumerator: number | null; fteDenominator: number | null } | null,
): number | null {
  if (!baseDays || !contract) return null;
  if (!contract.fteNumerator || !contract.fteDenominator) return baseDays;
  return Math.ceil((baseDays * contract.fteNumerator) / contract.fteDenominator);
}

/** Co zalogowana osoba może zrobić z urlopami osoby (przyciski w interfejsie; serwer sprawdza to ponownie). */
function balanceAccess(context: Pick<LeaveContext, "access" | "snapshot">): LeaveBalance["access"] {
  const keys = HIRAHR_PERMISSIONS.keys;
  return {
    canRequest: context.access.self && can(context.snapshot, keys["leave.request"]),
    canManage: context.access.canManage,
    canEnterSick: canOrganizationWide(context.snapshot, keys["leave.manage"]),
  };
}

async function computeBalance(
  tx: Tx,
  caller: Caller,
  employeeId: string,
  year: number,
  access: LeaveBalance["access"],
): Promise<LeaveBalance> {
  const { start, end } = yearBounds(year);
  const today = todayInPoland();
  const [entitlement, sums, contracts] = await Promise.all([
    tx.leaveEntitlement.findUnique({
      where: { organizationId_employeeId_year: { organizationId: caller.organizationId, employeeId, year } },
    }),
    tx.leaveRequest.groupBy({
      by: ["type", "status"],
      where: {
        employeeId,
        type: { in: [...VACATION_POOL_TYPES] },
        status: { in: ACTIVE_STATUSES },
        startDate: { gte: start, lte: end },
      },
      _sum: { workingDays: true },
    }),
    tx.employmentContract.findMany({
      where: { employeeId, type: { in: [...EMPLOYMENT_CONTRACT_TYPES] } },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      select: { startDate: true, endDate: true, fteNumerator: true, fteDenominator: true },
    }),
  ]);
  let usedDays = 0;
  let pendingDays = 0;
  let onDemandUsedDays = 0;
  for (const sum of sums) {
    const value = sum._sum.workingDays ?? 0;
    if (sum.status === "APPROVED") usedDays += value;
    else pendingDays += value;
    if (sum.type === "ON_DEMAND") onDemandUsedDays += value;
  }
  const current = contracts.find((contract) => isContractCurrent(contract.startDate, contract.endDate, today));
  const entitledDays = entitlement?.entitledDays ?? 0;
  const carriedOverDays = entitlement?.carriedOverDays ?? 0;
  const baseDays = (entitlement?.baseDays ?? null) as VacationBaseDays | null;
  return {
    employeeId,
    year,
    configured: Boolean(entitlement),
    baseDays,
    suggestedEntitledDays: suggestEntitledDays(baseDays, current ?? null),
    currentContractFte: current
      ? current.fteNumerator && current.fteDenominator
        ? `${current.fteNumerator}/${current.fteDenominator}`
        : "1/1"
      : null,
    entitledDays,
    carriedOverDays,
    usedDays,
    pendingDays,
    remainingDays: entitledDays + carriedOverDays - usedDays - pendingDays,
    onDemandUsedDays,
    onDemandLimit: ON_DEMAND_YEARLY_LIMIT,
    notes: entitlement?.notes ?? null,
    updatedAt: entitlement?.updatedAt.toISOString() ?? null,
    access,
  };
}

function parseYear(value: string | number | undefined): number {
  if (value === undefined) return Number(todayInPoland().slice(0, 4));
  const year = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || (typeof value === "string" && !/^\d{4}$/.test(value))) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "year", message: "Rok musi być liczbą od 2000 do 2100" },
    ]);
  }
  return year;
}

/** Saldo urlopu wypoczynkowego osoby w roku (domyślnie bieżącym w Polsce). */
export async function getLeaveBalance(
  caller: Caller,
  employeeId: string,
  searchParams: URLSearchParams,
): Promise<LeaveBalance> {
  const query = LeaveBalanceQuery.parse(queryRecord(searchParams));
  const year = parseYear(query.year);
  const context = await loadLeaveContext(caller, employeeId);
  return withUser(getDb(), caller, (tx) => computeBalance(tx, caller, employeeId, year, balanceAccess(context)));
}

/** Ustalenie salda na rok (kadry, `leave.manage` obejmujące osobę). Zwraca saldo po zmianie. */
export async function updateLeaveEntitlement(
  caller: Caller,
  employeeId: string,
  yearParam: string,
  raw: unknown,
): Promise<LeaveBalance> {
  const year = parseYear(yearParam);
  const context = await loadLeaveContext(caller, employeeId);
  if (!context.access.canManage) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Saldo urlopu ustalają kadry");
  }
  const input = UpdateLeaveEntitlementInput.parse(raw);
  const data = {
    ...(input.baseDays !== undefined ? { baseDays: input.baseDays } : {}),
    entitledDays: input.entitledDays,
    carriedOverDays: input.carriedOverDays ?? 0,
    ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    updatedByAccountId: caller.accountId,
  };
  return withUser(getDb(), caller, async (tx) => {
    await lockPerson(tx, caller, employeeId);
    await tx.leaveEntitlement.upsert({
      where: { organizationId_employeeId_year: { organizationId: caller.organizationId, employeeId, year } },
      create: { organizationId: caller.organizationId, employeeId, year, ...data },
      update: data,
    });
    return computeBalance(tx, caller, employeeId, year, balanceAccess(context));
  });
}

// ── Wnioski ─────────────────────────────────────────────────────────────────

/** Blokada transakcji na urlopy jednej osoby: saldo i nakładanie się sprawdzamy bez wyścigu. */
async function lockPerson(tx: Tx, caller: Caller, employeeId: string): Promise<void> {
  const key = `hirahr:leave:${caller.organizationId}:${employeeId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Naruszenie ograniczenia EXCLUDE `leave_requests_no_overlap` (kod PostgreSQL 23P01). */
export function isOverlapViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["code", "originalCode", "constraint", "message"]) {
      const field = record[key];
      if (typeof field === "string" && (field === "23P01" || field.includes("leave_requests_no_overlap"))) {
        return true;
      }
    }
    return ["meta", "cause", "driverAdapterError", "kind"].some((key) => visit(record[key], depth + 1));
  };
  return visit(error, 0);
}

const OVERLAP_MESSAGE = "W tym okresie jest już inna nieobecność albo oczekujący wniosek";

async function assertPoolAvailable(
  tx: Tx,
  caller: Caller,
  employeeId: string,
  type: LeaveType,
  year: number,
  additionalDays: number,
): Promise<void> {
  if (!VACATION_POOL_TYPES.includes(type)) return;
  const balance = await computeBalance(tx, caller, employeeId, year, {
    canRequest: false,
    canManage: false,
    canEnterSick: false,
  });
  if (!balance.configured) {
    throw new ApiFailure(
      422,
      "VALIDATION_FAILED",
      `Kadry nie ustaliły jeszcze puli urlopu na ${year} rok. Poproś kadry o uzupełnienie salda.`,
    );
  }
  if (balance.remainingDays - additionalDays < 0) {
    throw new ApiFailure(
      409,
      "CONFLICT",
      additionalDays > 0
        ? `Za mało dni urlopu: zostało ${days(Math.max(balance.remainingDays, 0))}, a wniosek obejmuje ${days(additionalDays)}`
        : `Saldo urlopu nie wystarcza już na ten wniosek (brakuje ${days(-balance.remainingDays)}); poproś kadry o sprawdzenie salda`,
    );
  }
  if (type === "ON_DEMAND" && balance.onDemandUsedDays + additionalDays > ON_DEMAND_YEARLY_LIMIT) {
    throw new ApiFailure(
      409,
      "CONFLICT",
      `Urlop na żądanie to najwyżej ${days(ON_DEMAND_YEARLY_LIMIT)} w roku; ` +
        `wykorzystane albo zaplanowane: ${days(balance.onDemandUsedDays)}`,
    );
  }
}

/**
 * Nowy wniosek albo wpis nieobecności.
 * - za siebie: `leave.request`, status „oczekuje” (poza zwolnieniem lekarskim kadr),
 * - za kogoś: `leave.manage` obejmujące osobę, od razu „zaakceptowany”,
 * - zwolnienie lekarskie: tylko `leave.manage` w zakresie całej firmy, od razu „zaakceptowane”.
 */
export async function createLeaveRequest(caller: Caller, raw: unknown): Promise<LeaveRequest> {
  const input = CreateLeaveRequestInput.parse(raw);
  const employeeId = input.employeeId ?? caller.employeeId;
  const context = await loadLeaveContext(caller, employeeId);
  const { access, snapshot } = context;
  const keys = HIRAHR_PERMISSIONS.keys;

  let status: "PENDING" | "APPROVED";
  if (HR_ONLY_LEAVE_TYPES.includes(input.type)) {
    if (!canOrganizationWide(snapshot, keys["leave.manage"])) {
      throw new ApiFailure(403, "PERMISSION_DENIED", "Zwolnienie lekarskie wpisują kadry");
    }
    status = "APPROVED";
  } else if (access.self) {
    if (!can(snapshot, keys["leave.request"])) {
      throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do składania wniosków urlopowych");
    }
    status = "PENDING";
  } else {
    if (!access.canManage) {
      throw new ApiFailure(403, "PERMISSION_DENIED", "Nieobecność za inną osobę wpisują kadry");
    }
    status = "APPROVED";
  }

  const { workingDays } = countWorkingDays(
    input.startDate,
    input.endDate,
    context.directory.scheduleByEmployee.get(employeeId) ?? null,
  );
  if (workingDays === 0) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Wybrany okres nie obejmuje żadnego dnia pracy");
  }

  const start = fromIsoDate(input.startDate);
  const end = fromIsoDate(input.endDate);
  const id = uuidv7();
  const now = new Date();
  const row = await withUser(getDb(), caller, async (tx) => {
    await lockPerson(tx, caller, employeeId);
    const overlap = await tx.leaveRequest.findFirst({
      where: { employeeId, status: { in: ACTIVE_STATUSES }, startDate: { lte: end }, endDate: { gte: start } },
      select: { id: true },
    });
    if (overlap) throw new ApiFailure(409, "CONFLICT", OVERLAP_MESSAGE);
    await assertPoolAvailable(tx, caller, employeeId, input.type, Number(input.startDate.slice(0, 4)), workingDays);
    try {
      return await tx.leaveRequest.create({
        data: {
          id,
          organizationId: caller.organizationId,
          employeeId,
          type: input.type,
          startDate: start,
          endDate: end,
          workingDays,
          status,
          note: input.note || null,
          requestedByAccountId: caller.accountId,
          ...(status === "APPROVED" ? { decidedByAccountId: caller.accountId, decidedAt: now } : {}),
        },
        select: requestSelect,
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw new ApiFailure(409, "CONFLICT", OVERLAP_MESSAGE);
      throw error;
    }
  });
  return toRequestView(row, context.directory, access, todayInPoland());
}

async function loadRequest(
  caller: Caller,
  requestId: string,
): Promise<{ row: LeaveRequestRow; context: LeaveContext }> {
  const row = await withUser(getDb(), caller, (tx) =>
    tx.leaveRequest.findUnique({ where: { id: requestId }, select: requestSelect }),
  );
  if (!row) throw new ApiFailure(404, "NOT_FOUND", LEAVE_REQUEST_NOT_FOUND_MESSAGE);
  const context = await loadLeaveContext(caller, row.employeeId, {
    hideForbidden: true,
    notFoundMessage: LEAVE_REQUEST_NOT_FOUND_MESSAGE,
  });
  // Zwolnienie lekarskie innej osoby bez prawa do jego rodzaju traktujemy jak nieistniejące.
  if (row.type === "SICK" && !context.access.canSeeSick) {
    throw new ApiFailure(404, "NOT_FOUND", LEAVE_REQUEST_NOT_FOUND_MESSAGE);
  }
  return { row, context };
}

/** Akceptacja albo odrzucenie oczekującego wniosku (`leave.approve` albo `leave.manage`, nigdy własnego). */
export async function decideLeaveRequest(caller: Caller, requestId: string, raw: unknown): Promise<LeaveRequest> {
  const { row, context } = await loadRequest(caller, requestId);
  if (context.access.self) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Własny wniosek rozpatruje inna osoba");
  }
  if (!context.access.canDecide) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do rozpatrzenia tego wniosku");
  }
  const input = DecideLeaveRequestInput.parse(raw);
  const updated = await withUser(getDb(), caller, async (tx) => {
    await lockPerson(tx, caller, row.employeeId);
    if (input.decision === "APPROVE") {
      // Kadry mogły w międzyczasie zmniejszyć saldo: oczekujący wniosek jest już w nim policzony.
      await assertPoolAvailable(tx, caller, row.employeeId, row.type, row.startDate.getUTCFullYear(), 0);
    }
    const result = await tx.leaveRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decisionNote: input.note || null,
        decidedByAccountId: caller.accountId,
        decidedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new ApiFailure(409, "CONFLICT", "Wniosek został już rozpatrzony albo wycofany");
    }
    return tx.leaveRequest.findUniqueOrThrow({ where: { id: requestId }, select: requestSelect });
  });
  return toRequestView(updated, context.directory, context.access, todayInPoland());
}

/**
 * Wycofanie: oczekujący wniosek wycofuje sama osoba albo kadry; zaakceptowany sama osoba przed jego początkiem,
 * a kadry zawsze (korekta). Wycofany wpis zostaje w historii.
 */
export async function cancelLeaveRequest(caller: Caller, requestId: string): Promise<LeaveRequest> {
  const { row, context } = await loadRequest(caller, requestId);
  const today = todayInPoland();
  if (!ACTIVE_STATUSES.includes(row.status)) {
    throw new ApiFailure(409, "CONFLICT", "Wniosek jest już zamknięty");
  }
  if (!canCancel(row, context.access, today)) {
    throw new ApiFailure(
      403,
      "PERMISSION_DENIED",
      context.access.self
        ? "Rozpoczętego urlopu nie można wycofać samodzielnie; skontaktuj się z kadrami"
        : "Brak uprawnienia do wycofania tego wniosku",
    );
  }
  const updated = await withUser(getDb(), caller, async (tx) => {
    const result = await tx.leaveRequest.updateMany({
      where: { id: requestId, status: row.status },
      data: { status: "CANCELLED" },
    });
    if (result.count === 0) {
      throw new ApiFailure(409, "CONFLICT", "Wniosek został w międzyczasie zmieniony; odśwież widok");
    }
    return tx.leaveRequest.findUniqueOrThrow({ where: { id: requestId }, select: requestSelect });
  });
  return toRequestView(updated, context.directory, context.access, today);
}

function isRequestCursor(value: unknown): value is { d: string; id: string } {
  const candidate = value as { d?: unknown; id?: unknown };
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(candidate.d) &&
    typeof candidate.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(candidate.id)
  );
}

/**
 * Wnioski: bez parametrów własne, z `employeeId` jednej osoby (od najnowszych), a z `approvals=true`
 * oczekujące wnioski osób, które zalogowana osoba może rozpatrzyć (od najbliższych).
 */
export async function listLeaveRequests(
  caller: Caller,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<LeaveRequest>> {
  const query = LeaveRequestsQuery.parse(queryRecord(searchParams));
  const today = todayInPoland();

  if (query.approvals) {
    const snapshot = await getPermissionSnapshot(caller);
    assertProductAccess(snapshot);
    const keys = HIRAHR_PERMISSIONS.keys;
    if (
      scopeOf(snapshot, keys["leave.approve"]).type === "NONE" &&
      scopeOf(snapshot, keys["leave.manage"]).type === "NONE"
    ) {
      throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do akceptacji wniosków");
    }
    const directory = await getOrganizationDirectory(caller.organizationId);
    const rows = await withUser(getDb(), caller, (tx) =>
      tx.leaveRequest.findMany({
        where: { status: "PENDING", employeeId: { not: caller.employeeId } },
        orderBy: [{ startDate: "asc" }, { id: "asc" }],
        take: MAX_ROWS_IN_MEMORY,
        select: requestSelect,
      }),
    );
    const items: LeaveRequest[] = [];
    for (const row of rows) {
      const person = directory.people.get(row.employeeId);
      if (!person || !isVisibleStatus(person.status)) continue;
      const access = leaveAccessFor(
        caller,
        snapshot,
        row.employeeId,
        directory.unitsByEmployee.get(row.employeeId) ?? [],
      );
      if (!access.canDecide) continue;
      items.push(toRequestView(row, directory, access, today));
    }
    return pageByOffset(items, query.cursor, query.limit);
  }

  const employeeId = query.employeeId ?? caller.employeeId;
  const context = await loadLeaveContext(caller, employeeId);
  const cursor = decodeCursor(query.cursor, isRequestCursor);
  const rows = await withUser(getDb(), caller, (tx) =>
    tx.leaveRequest.findMany({
      where: {
        employeeId,
        ...(query.status ? { status: query.status } : {}),
        ...(context.access.canSeeSick ? {} : { type: { not: "SICK" as const } }),
        ...(cursor
          ? {
              OR: [
                { startDate: { lt: fromIsoDate(cursor.d) } },
                { startDate: fromIsoDate(cursor.d), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: requestSelect,
    }),
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toRequestView(row, context.directory, context.access, today)),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ d: toIsoDate(last.startDate), id: last.id }) : null,
  };
}

// ── Kalendarz i dni pracy ───────────────────────────────────────────────────

type CalendarLevel = "full" | "busy";

/**
 * Kalendarz nieobecności zespołu w okresie do 62 dni. Pełny wgląd (rodzaj, także oczekujące): sama osoba,
 * rozpatrujący i kadry. Osoby z tych samych jednostek i z `employees.read` widzą tylko zaakceptowane
 * nieobecności bez rodzaju („nieobecność”).
 */
export async function getLeaveCalendar(
  caller: Caller,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<CalendarAbsence>> {
  const query = LeaveCalendarQuery.parse(queryRecord(searchParams));
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const directory = await getOrganizationDirectory(caller.organizationId);
  const ownUnits = directory.unitsByEmployee.get(caller.employeeId) ?? [];
  const readScope = scopeOf(snapshot, HIRAHR_PERMISSIONS.keys["employees.read"]);

  const levels = new Map<string, { level: CalendarLevel; access: LeaveAccess }>();
  for (const person of directory.people.values()) {
    if (!isVisibleStatus(person.status)) continue;
    const unitIds = directory.unitsByEmployee.get(person.employeeId) ?? [];
    if (query.unitId && !unitIds.includes(query.unitId)) continue;
    const access = leaveAccessFor(caller, snapshot, person.employeeId, unitIds);
    if (access.canView) {
      levels.set(person.employeeId, { level: "full", access });
    } else if (
      scopeCoversPerson(readScope, person.employeeId, unitIds) ||
      unitIds.some((unitId) => ownUnits.includes(unitId))
    ) {
      levels.set(person.employeeId, { level: "busy", access });
    }
  }
  if (levels.size === 0) return { items: [], nextCursor: null };

  const rows = await withUser(getDb(), caller, (tx) =>
    tx.leaveRequest.findMany({
      where: {
        employeeId: { in: [...levels.keys()] },
        status: { in: ACTIVE_STATUSES },
        startDate: { lte: fromIsoDate(query.to) },
        endDate: { gte: fromIsoDate(query.from) },
      },
      orderBy: [{ startDate: "asc" }, { id: "asc" }],
      take: MAX_ROWS_IN_MEMORY,
      select: { id: true, employeeId: true, type: true, status: true, startDate: true, endDate: true },
    }),
  );
  const items: CalendarAbsence[] = [];
  for (const row of rows) {
    const entry = levels.get(row.employeeId);
    if (!entry) continue;
    if (entry.level === "busy" && row.status !== "APPROVED") continue;
    const showType = entry.level === "full" && (row.type !== "SICK" || entry.access.canSeeSick);
    items.push({
      requestId: row.id,
      employeeId: row.employeeId,
      employeeName: directory.people.get(row.employeeId)?.fullName ?? "Nieznana osoba",
      type: showType ? row.type : null,
      status: row.status,
      startDate: toIsoDate(row.startDate)!,
      endDate: toIsoDate(row.endDate)!,
    });
  }
  return pageByOffset(items, query.cursor, query.limit);
}

/** Podgląd liczby dni pracy w okresie (wymiar pracy osoby z Core i polskie święta). */
export async function previewWorkingDays(
  caller: Caller,
  searchParams: URLSearchParams,
): Promise<{ workingDays: number; holidays: string[] }> {
  const query = WorkingDaysQuery.parse(queryRecord(searchParams));
  const employeeId = query.employeeId ?? caller.employeeId;
  const context = await loadLeaveContext(caller, employeeId);
  if (!context.access.self && !context.access.canManage) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Dni pracy innej osoby liczą kadry");
  }
  const result = countWorkingDays(query.from, query.to, context.directory.scheduleByEmployee.get(employeeId) ?? null);
  return { workingDays: result.workingDays, holidays: [...result.holidays] };
}
