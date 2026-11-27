/**
 * Kontrakt urlopów i nieobecności HiraHR (etap 2, ADR-0104): rodzaje, roczne salda, wnioski z akceptacją
 * i kalendarz nieobecności. Dni liczone w dniach pracy według wymiaru pracy z Core i polskich świąt.
 */
import { z } from "zod";
import { IsoDate, PageCursor, PageLimit } from "./people.js";

export const LEAVE_TYPES = ["VACATION", "ON_DEMAND", "OCCASIONAL", "CHILDCARE", "SICK", "UNPAID", "OTHER"] as const;
export const LeaveType = z.enum(LEAVE_TYPES);
export type LeaveType = (typeof LEAVE_TYPES)[number];

/** Rodzaje zużywające pulę urlopu wypoczynkowego (urlop na żądanie jest jego częścią, art. 167² KP). */
export const VACATION_POOL_TYPES: readonly LeaveType[] = ["VACATION", "ON_DEMAND"];

/** Rodzaje, które wpisują tylko kadry (np. zwolnienie lekarskie z e-ZLA), a nie sam pracownik. */
export const HR_ONLY_LEAVE_TYPES: readonly LeaveType[] = ["SICK"];

/** Najwyżej 4 dni urlopu na żądanie w roku kalendarzowym. */
export const ON_DEMAND_YEARLY_LIMIT = 4;

export const LEAVE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export const LeaveStatus = z.enum(LEAVE_STATUSES);
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Wymiar urlopu z Kodeksu pracy: 20 dni przy stażu poniżej 10 lat, 26 dni przy co najmniej 10 latach. */
export const VacationBaseDays = z.union([z.literal(20), z.literal(26)]);
export type VacationBaseDays = z.infer<typeof VacationBaseDays>;

const Uuid = z.string().uuid();
const Days = z.number().int().min(0).max(100);
/** Znaki sterujące poza tabulatorem i końcami wierszy (bez wyrażenia regularnego, reguła no-control-regex). */
function hasDisallowedControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

/** Liczba dni kalendarzowych między datami `RRRR-MM-DD` (bez dnia początku). */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** Najdłuższa nieobecność w jednym wpisie (dłuższą wpisuje się jako kilka). */
export const MAX_LEAVE_SPAN_DAYS = 366;

const note = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !hasDisallowedControl(value), "Pole zawiera niedozwolone znaki");

// ── Odpowiedzi ─────────────────────────────────────────────────────────────

export const LeaveBalance = z.object({
  employeeId: Uuid,
  year: z.number().int(),
  /** Czy kadry ustaliły saldo na ten rok (bez niego nie da się złożyć wniosku o urlop wypoczynkowy). */
  configured: z.boolean(),
  baseDays: VacationBaseDays.nullable(),
  /** Wymiar z podstawy i etatu obecnej umowy (zaokrąglony w górę), podpowiedź dla kadr. */
  suggestedEntitledDays: z.number().int().nullable(),
  /** Etat obecnej umowy o pracę (np. `3/4`), z którego interfejs liczy podpowiedź dla 20 albo 26 dni. */
  currentContractFte: z.string().nullable(),
  entitledDays: z.number().int(),
  carriedOverDays: z.number().int(),
  usedDays: z.number().int(),
  pendingDays: z.number().int(),
  remainingDays: z.number().int(),
  onDemandUsedDays: z.number().int(),
  onDemandLimit: z.number().int(),
  notes: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Co zalogowana osoba może zrobić z urlopami tej osoby (przyciski w interfejsie). */
  access: z.object({
    /** Własny wniosek (`hirahr.leave.request`). */
    canRequest: z.boolean(),
    /** Saldo i wpisy kadr (`hirahr.leave.manage` obejmujące osobę). */
    canManage: z.boolean(),
    /** Wpis zwolnienia lekarskiego (`hirahr.leave.manage` w zakresie firmy). */
    canEnterSick: z.boolean(),
  }),
});
export type LeaveBalance = z.infer<typeof LeaveBalance>;

export const LeaveRequestAccess = z.object({
  canCancel: z.boolean(),
  canDecide: z.boolean(),
});
export type LeaveRequestAccess = z.infer<typeof LeaveRequestAccess>;

export const LeaveRequest = z.object({
  id: Uuid,
  employeeId: Uuid,
  employeeName: z.string(),
  /** `null`, gdy rodzaj jest ukryty przed oglądającym (np. zwolnienie lekarskie). */
  type: LeaveType.nullable(),
  startDate: IsoDate,
  endDate: IsoDate,
  workingDays: z.number().int(),
  status: LeaveStatus,
  note: z.string().nullable(),
  decisionNote: z.string().nullable(),
  decidedBy: z.object({ accountId: Uuid, name: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  access: LeaveRequestAccess,
});
export type LeaveRequest = z.infer<typeof LeaveRequest>;

export const CalendarAbsence = z.object({
  requestId: Uuid,
  employeeId: Uuid,
  employeeName: z.string(),
  type: LeaveType.nullable(),
  status: LeaveStatus,
  startDate: IsoDate,
  endDate: IsoDate,
});
export type CalendarAbsence = z.infer<typeof CalendarAbsence>;

export const WorkingDays = z.object({
  workingDays: z.number().int(),
  holidays: z.array(IsoDate),
});
export type WorkingDays = z.infer<typeof WorkingDays>;

// ── Żądania ────────────────────────────────────────────────────────────────

export const CreateLeaveRequestInput = z
  .object({
    /** Domyślnie sama osoba; wpis za kogoś innego tylko z `hirahr.leave.manage` (od razu zaakceptowany). */
    employeeId: Uuid.optional(),
    type: LeaveType,
    startDate: IsoDate,
    endDate: IsoDate,
    note: note(500).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endDate < value.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "Koniec nie może być przed początkiem" });
    }
    if (daysBetween(value.startDate, value.endDate) >= MAX_LEAVE_SPAN_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "Jedna nieobecność może trwać najwyżej rok; dłuższą wpisz jako kilka",
      });
    }
    if (VACATION_POOL_TYPES.includes(value.type) && value.startDate.slice(0, 4) !== value.endDate.slice(0, 4)) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "Urlop na przełomie lat złóż jako dwa wnioski (osobno dla każdego roku)",
      });
    }
  });
export type CreateLeaveRequestInput = z.input<typeof CreateLeaveRequestInput>;

export const DecideLeaveRequestInput = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: note(500).nullable().optional(),
  })
  .strict();
export type DecideLeaveRequestInput = z.input<typeof DecideLeaveRequestInput>;

export const UpdateLeaveEntitlementInput = z
  .object({
    baseDays: VacationBaseDays.nullable().optional(),
    entitledDays: Days,
    carriedOverDays: Days.default(0),
    notes: note(500).nullable().optional(),
  })
  .strict();
export type UpdateLeaveEntitlementInput = z.input<typeof UpdateLeaveEntitlementInput>;

export const LeaveRequestsQuery = z.object({
  /** Wnioski jednej osoby; bez parametru własne. */
  employeeId: Uuid.optional(),
  /** `true`: oczekujące wnioski osób, które zalogowana osoba może zaakceptować. */
  approvals: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  status: LeaveStatus.optional(),
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type LeaveRequestsQuery = z.input<typeof LeaveRequestsQuery>;

export const LeaveCalendarQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    unitId: Uuid.optional(),
    limit: PageLimit,
    cursor: PageCursor.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.to < value.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Koniec nie może być przed początkiem" });
    }
    if (daysBetween(value.from, value.to) > 62) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Kalendarz obejmuje najwyżej 62 dni" });
    }
  });
export type LeaveCalendarQuery = z.input<typeof LeaveCalendarQuery>;

export const WorkingDaysQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    employeeId: Uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.to < value.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Koniec nie może być przed początkiem" });
    }
    if (daysBetween(value.from, value.to) >= MAX_LEAVE_SPAN_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Okres może trwać najwyżej rok" });
    }
  });
export type WorkingDaysQuery = z.input<typeof WorkingDaysQuery>;

export const LeaveBalanceQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type LeaveBalanceQuery = z.input<typeof LeaveBalanceQuery>;
