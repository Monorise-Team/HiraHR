import type { Address, ContractType, Salary, SensitiveField } from "@hirahr/client";

/** Polskie nazwy rodzajów umów (Kodeks pracy i umowy cywilnoprawne). */
export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  PROBATION: "Umowa na okres próbny",
  FIXED_TERM: "Umowa na czas określony",
  INDEFINITE: "Umowa na czas nieokreślony",
  MANDATE: "Umowa zlecenie",
  SPECIFIC_TASK: "Umowa o dzieło",
  B2B: "Współpraca B2B",
};

export const CONTRACT_TYPE_ORDER: readonly ContractType[] = [
  "INDEFINITE",
  "FIXED_TERM",
  "PROBATION",
  "MANDATE",
  "SPECIFIC_TASK",
  "B2B",
];

/** Rodzaje z wymiarem etatu i z wymaganą datą końca (jak w kontrakcie API). */
export const EMPLOYMENT_TYPES: readonly ContractType[] = ["PROBATION", "FIXED_TERM", "INDEFINITE"];
export const TYPES_WITH_END_DATE: readonly ContractType[] = ["PROBATION", "FIXED_TERM"];

export const SENSITIVE_FIELD_LABELS: Record<SensitiveField, string> = {
  pesel: "PESEL",
  bankAccount: "numer rachunku",
  idDocumentNumber: "numer dokumentu",
  salary: "wynagrodzenie",
};

export const PERSON_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Zatrudniony",
  FORMER: "Były pracownik",
};

/** Data `RRRR-MM-DD` po polsku, np. „1 stycznia 2026”. */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    date,
  );
}

/** Data i godzina wpisu w dzienniku. */
export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** Okres umowy, np. „od 1 stycznia 2026” albo „1 stycznia – 31 marca 2026”. */
export function formatContractPeriod(startDate: string, endDate: string | null): string {
  return endDate ? `${formatDate(startDate)} – ${formatDate(endDate)}` : `od ${formatDate(startDate)}`;
}

/** Wymiar etatu, np. „pełny etat”, „1/2 etatu”. */
export function formatFte(fte: string | null): string | null {
  if (!fte) return null;
  return fte === "1/1" ? "pełny etat" : `${fte} etatu`;
}

/** Wynagrodzenie brutto, np. „8 500,00 zł brutto miesięcznie”. */
export function formatSalary(salary: Salary): string {
  const amount = Number(salary.amount);
  const money = new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: salary.currency,
    minimumFractionDigits: 2,
  }).format(amount);
  return `${money} brutto ${salary.period === "HOUR" ? "za godzinę" : "miesięcznie"}`;
}

export function formatAddress(address: Address | null): string {
  if (!address) return "—";
  const country = address.country && address.country !== "Polska" ? `, ${address.country}` : "";
  return `${address.street}, ${address.postalCode} ${address.city}${country}`;
}

/** IBAN w grupach po cztery znaki, łatwiejszy do przeczytania. */
export function formatIban(value: string | null): string {
  if (!value) return "—";
  return value.replace(/(.{4})/g, "$1 ").trim();
}

/** Lista pól dziennika po polsku, np. „PESEL, numer rachunku”. */
export function formatSensitiveFields(fields: readonly SensitiveField[]): string {
  return fields.map((field) => SENSITIVE_FIELD_LABELS[field]).join(", ");
}
