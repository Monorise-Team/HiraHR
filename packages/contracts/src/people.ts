/**
 * Kontrakt kartoteki HiraHR (etap 1, ADR-0104): ludzie, karta osoby, umowy, stanowiska, dane wrażliwe
 * i dziennik dostępu do nich. Dane tożsamości i struktury (imię, nazwisko, jednostki) pochodzą z MonoriseCore;
 * HiraHR przechowuje tylko dane kadrowe powiązane z pracownikiem Core (`employeeId`).
 */
import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export const PageLimit = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT);
export const PageCursor = z.string().min(1).max(256);

const Uuid = z.string().uuid();

/** Data kalendarzowa `RRRR-MM-DD` (bez czasu i strefy). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data musi mieć format RRRR-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Niepoprawna data");

/** Znaki sterujące C0 i DEL (bez wyrażenia regularnego, którego zabrania reguła no-control-regex). */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !hasControlCharacters(value), "Pole nie może zawierać znaków sterujących");

// ── Walidacja polskich danych ───────────────────────────────────────────────

/** Sprawdza PESEL: 11 cyfr, suma kontrolna i poprawna data urodzenia zakodowana w numerze. */
export function isValidPesel(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = weights.reduce((total, weight, index) => total + weight * digits[index]!, 0);
  if ((10 - (sum % 10)) % 10 !== digits[10]) return false;
  return peselBirthDate(value) !== null;
}

/** Data urodzenia zapisana w numerze PESEL (`RRRR-MM-DD`) albo `null`, gdy niepoprawna. */
export function peselBirthDate(value: string): string | null {
  if (!/^\d{11}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  let mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  let century: number;
  if (mm >= 81 && mm <= 92) {
    century = 1800;
    mm -= 80;
  } else if (mm >= 1 && mm <= 12) {
    century = 1900;
  } else if (mm >= 21 && mm <= 32) {
    century = 2000;
    mm -= 20;
  } else if (mm >= 41 && mm <= 52) {
    century = 2100;
    mm -= 40;
  } else if (mm >= 61 && mm <= 72) {
    century = 2200;
    mm -= 60;
  } else {
    return null;
  }
  const iso = `${century + yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Usuwa spacje i myślniki oraz zamienia litery na wielkie; same 26 cyfr traktuje jak polski rachunek (`PL`). */
export function normalizeIban(value: string): string {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  return /^\d{26}$/.test(compact) ? `PL${compact}` : compact;
}

/** Sprawdza numer rachunku IBAN (format i suma kontrolna mod 97); polski rachunek ma 28 znaków. */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith("PL") && iban.length !== 28) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const code = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

// ── Słowniki ────────────────────────────────────────────────────────────────

export const CONTRACT_TYPES = ["PROBATION", "FIXED_TERM", "INDEFINITE", "MANDATE", "SPECIFIC_TASK", "B2B"] as const;
export const ContractType = z.enum(CONTRACT_TYPES);
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** Umowy o pracę (Kodeks pracy) mają wymiar etatu; zlecenie, dzieło i B2B go nie mają. */
export const EMPLOYMENT_CONTRACT_TYPES: readonly ContractType[] = ["PROBATION", "FIXED_TERM", "INDEFINITE"];

/** Umowy, które z definicji mają datę końca. */
export const CONTRACT_TYPES_WITH_END_DATE: readonly ContractType[] = ["PROBATION", "FIXED_TERM"];

export const SALARY_PERIODS = ["MONTH", "HOUR"] as const;
export const SalaryPeriod = z.enum(SALARY_PERIODS);
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const SENSITIVE_FIELDS = ["pesel", "bankAccount", "idDocumentNumber", "salary"] as const;
export const SensitiveField = z.enum(SENSITIVE_FIELDS);
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

export const SENSITIVE_ACCESS_ACTIONS = ["READ", "UPDATE"] as const;
export const SensitiveAccessAction = z.enum(SENSITIVE_ACCESS_ACTIONS);
export type SensitiveAccessAction = (typeof SENSITIVE_ACCESS_ACTIONS)[number];

export const EMPLOYEE_STATUSES = ["ACTIVE", "INVITED", "DEACTIVATED"] as const;
export const PersonStatus = z.string();

// ── Wartości złożone ───────────────────────────────────────────────────────

/** Wymiar etatu jako ułamek `licznik/mianownik`, np. `1/1`, `1/2`, `3/4` (0 < etat ≤ 1). */
export const Fte = z
  .string()
  .trim()
  .regex(/^\d{1,2}\/\d{1,2}$/, "Wymiar etatu podaj jako ułamek, np. 1/1 albo 3/4")
  .refine((value) => {
    const [numerator, denominator] = value.split("/").map(Number) as [number, number];
    return numerator > 0 && denominator > 0 && numerator <= denominator;
  }, "Wymiar etatu musi być większy od zera i nie większy niż 1");

export const Address = z.object({
  street: trimmed(200).min(1, "Podaj ulicę i numer"),
  postalCode: trimmed(20).min(1, "Podaj kod pocztowy"),
  city: trimmed(120).min(1, "Podaj miejscowość"),
  country: trimmed(80).default("Polska"),
});
export type Address = z.infer<typeof Address>;

export const EmergencyContact = z.object({
  name: trimmed(160).min(1, "Podaj imię i nazwisko"),
  relation: trimmed(80).default(""),
  phone: trimmed(40).min(3, "Podaj numer telefonu"),
});
export type EmergencyContact = z.infer<typeof EmergencyContact>;

export const Salary = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, "Kwota musi być liczbą z najwyżej dwoma miejscami po przecinku (np. 8500.00)"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Waluta to trzy wielkie litery, np. PLN")
    .default("PLN"),
  period: SalaryPeriod.default("MONTH"),
});
export type Salary = z.infer<typeof Salary>;

// ── Odpowiedzi ─────────────────────────────────────────────────────────────

export const Position = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Position = z.infer<typeof Position>;

export const PositionSummary = z.object({ id: Uuid, name: z.string() });
export type PositionSummary = z.infer<typeof PositionSummary>;

export const Unit = z.object({
  id: Uuid,
  name: z.string(),
  type: z.string(),
  parentId: Uuid.nullable(),
});
export type Unit = z.infer<typeof Unit>;

export const PersonListItem = z.object({
  employeeId: Uuid,
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  status: PersonStatus,
  unitIds: z.array(Uuid),
  currentContractType: ContractType.nullable(),
  currentPosition: PositionSummary.nullable(),
});
export type PersonListItem = z.infer<typeof PersonListItem>;

export const EmployeeProfile = z.object({
  dateOfBirth: IsoDate.nullable(),
  personalEmail: z.string().nullable(),
  personalPhone: z.string().nullable(),
  homeAddress: Address.nullable(),
  mailingAddress: Address.nullable(),
  emergencyContact: EmergencyContact.nullable(),
  updatedAt: z.string().nullable(),
});
export type EmployeeProfile = z.infer<typeof EmployeeProfile>;

export const EmploymentContract = z.object({
  id: Uuid,
  type: ContractType,
  startDate: IsoDate,
  endDate: IsoDate.nullable(),
  fte: z.string().nullable(),
  position: PositionSummary.nullable(),
  notes: z.string().nullable(),
  current: z.boolean(),
  hasSalary: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmploymentContract = z.infer<typeof EmploymentContract>;

export const PersonAccess = z.object({
  self: z.boolean(),
  canUpdateProfile: z.boolean(),
  canManageContracts: z.boolean(),
  canReadSensitive: z.boolean(),
  canUpdateSensitive: z.boolean(),
});
export type PersonAccess = z.infer<typeof PersonAccess>;

export const SensitivePresence = z.object({
  pesel: z.boolean(),
  bankAccount: z.boolean(),
  idDocumentNumber: z.boolean(),
});
export type SensitivePresence = z.infer<typeof SensitivePresence>;

export const PersonCard = z.object({
  employeeId: Uuid,
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  status: PersonStatus,
  unitIds: z.array(Uuid),
  profile: EmployeeProfile,
  contracts: z.array(EmploymentContract),
  sensitive: SensitivePresence,
  access: PersonAccess,
});
export type PersonCard = z.infer<typeof PersonCard>;

export const ContractSalary = z.object({
  contractId: Uuid,
  salary: Salary.nullable(),
});
export type ContractSalary = z.infer<typeof ContractSalary>;

export const SensitiveData = z.object({
  pesel: z.string().nullable(),
  bankAccount: z.string().nullable(),
  idDocumentNumber: z.string().nullable(),
  salaries: z.array(ContractSalary),
});
export type SensitiveData = z.infer<typeof SensitiveData>;

export const SensitiveAccessLogEntry = z.object({
  id: Uuid,
  actor: z.object({ accountId: Uuid, name: z.string() }),
  action: SensitiveAccessAction,
  fields: z.array(SensitiveField),
  createdAt: z.string(),
});
export type SensitiveAccessLogEntry = z.infer<typeof SensitiveAccessLogEntry>;

// ── Żądania ────────────────────────────────────────────────────────────────

export const PeopleListQuery = z.object({
  search: trimmed(120).optional(),
  unitId: Uuid.optional(),
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type PeopleListQuery = z.input<typeof PeopleListQuery>;

export const CursorQuery = z.object({
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type CursorQuery = z.input<typeof CursorQuery>;

const optionalEmail = z.string().trim().max(254).email("Niepoprawny adres e-mail").nullable().optional();

/** Zmiana kartoteki (bez danych wrażliwych); pominięte pole zostaje bez zmian, `null` czyści wartość. */
export const UpdateProfileInput = z
  .object({
    dateOfBirth: IsoDate.nullable().optional(),
    personalEmail: optionalEmail,
    personalPhone: trimmed(40).nullable().optional(),
    homeAddress: Address.nullable().optional(),
    mailingAddress: Address.nullable().optional(),
    emergencyContact: EmergencyContact.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Podaj co najmniej jedno pole do zmiany");
export type UpdateProfileInput = z.input<typeof UpdateProfileInput>;

/** Zmiana danych wrażliwych; pominięte pole zostaje bez zmian, `null` usuwa wartość. */
export const UpdateSensitiveInput = z
  .object({
    pesel: z.string().trim().refine(isValidPesel, "Niepoprawny numer PESEL").nullable().optional(),
    bankAccount: z
      .string()
      .trim()
      .refine(isValidIban, "Niepoprawny numer rachunku (IBAN)")
      .transform(normalizeIban)
      .nullable()
      .optional(),
    idDocumentNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9 ]{5,20}$/, "Numer dokumentu ma 5–20 liter i cyfr")
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Podaj co najmniej jedno pole do zmiany");
export type UpdateSensitiveInput = z.input<typeof UpdateSensitiveInput>;

const contractShape = {
  type: ContractType,
  startDate: IsoDate,
  endDate: IsoDate.nullable().optional(),
  fte: Fte.nullable().optional(),
  positionId: Uuid.nullable().optional(),
  notes: trimmed(1000).nullable().optional(),
  salary: Salary.nullable().optional(),
};

interface ContractFields {
  type?: ContractType | undefined;
  startDate?: string | undefined;
  endDate?: string | null | undefined;
  fte?: string | null | undefined;
}

/**
 * Reguły spójności umowy. `complete` = rekord po scaleniu zmian (wszystkie pola znane), wtedy brak
 * daty końca albo etatu też jest błędem.
 */
export function contractViolations(value: ContractFields, complete: boolean): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    issues.push({ path: "endDate", message: "Data końca nie może być wcześniejsza niż początek" });
  }
  if (
    value.type &&
    CONTRACT_TYPES_WITH_END_DATE.includes(value.type) &&
    (complete ? !value.endDate : value.endDate === null)
  ) {
    issues.push({ path: "endDate", message: "Ta umowa wymaga daty końca" });
  }
  if (value.type && EMPLOYMENT_CONTRACT_TYPES.includes(value.type) && complete && !value.fte) {
    issues.push({ path: "fte", message: "Podaj wymiar etatu, np. 1/1" });
  }
  if (value.type && !EMPLOYMENT_CONTRACT_TYPES.includes(value.type) && value.fte) {
    issues.push({ path: "fte", message: "Wymiar etatu dotyczy tylko umów o pracę" });
  }
  return issues;
}

export const CreateContractInput = z
  .object(contractShape)
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of contractViolations(value, true)) {
      ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
    }
  });
export type CreateContractInput = z.input<typeof CreateContractInput>;

export const UpdateContractInput = z
  .object({
    type: ContractType.optional(),
    startDate: IsoDate.optional(),
    endDate: contractShape.endDate,
    fte: contractShape.fte,
    positionId: contractShape.positionId,
    notes: contractShape.notes,
    salary: contractShape.salary,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Podaj co najmniej jedno pole do zmiany")
  .superRefine((value, ctx) => {
    for (const issue of contractViolations(value, false)) {
      ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
    }
  });
export type UpdateContractInput = z.input<typeof UpdateContractInput>;

export const CreatePositionInput = z
  .object({
    name: trimmed(120).min(1, "Podaj nazwę stanowiska"),
    description: trimmed(500).nullable().optional(),
  })
  .strict();
export type CreatePositionInput = z.input<typeof CreatePositionInput>;

export const UpdatePositionInput = z
  .object({
    name: trimmed(120).min(1, "Podaj nazwę stanowiska").optional(),
    description: trimmed(500).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Podaj co najmniej jedno pole do zmiany");
export type UpdatePositionInput = z.input<typeof UpdatePositionInput>;

export const PositionsQuery = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type PositionsQuery = z.input<typeof PositionsQuery>;
