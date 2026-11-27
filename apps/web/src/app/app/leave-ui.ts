import type { LeaveStatus, LeaveType } from "@hirahr/client";
import type { BadgeTone } from "@monorise-team/ui";
import { formatDate } from "./people-ui";

/** Polskie nazwy rodzajów nieobecności (Kodeks pracy). */
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  VACATION: "Urlop wypoczynkowy",
  ON_DEMAND: "Urlop na żądanie",
  OCCASIONAL: "Urlop okolicznościowy",
  CHILDCARE: "Opieka nad dzieckiem",
  SICK: "Zwolnienie lekarskie",
  UNPAID: "Urlop bezpłatny",
  OTHER: "Inna nieobecność",
};

/** Krótkie podpowiedzi przy wyborze rodzaju we wniosku. */
export const LEAVE_TYPE_HINTS: Partial<Record<LeaveType, string>> = {
  VACATION: "Z rocznej puli urlopu.",
  ON_DEMAND: "Z puli urlopu wypoczynkowego, najwyżej 4 dni w roku. Zgłoś najpóźniej w dniu urlopu.",
  OCCASIONAL: "Np. ślub, narodziny dziecka albo pogrzeb bliskiej osoby.",
  CHILDCARE: "2 dni w roku na opiekę nad dzieckiem do 14 lat.",
  SICK: "Wpisują kadry na podstawie e-ZLA.",
  UNPAID: "Na pisemny wniosek, za zgodą pracodawcy.",
};

/** Rodzaje do wyboru we własnym wniosku (zwolnienie lekarskie wpisują kadry). */
export const SELF_SERVICE_LEAVE_TYPES: readonly LeaveType[] = [
  "VACATION",
  "ON_DEMAND",
  "OCCASIONAL",
  "CHILDCARE",
  "UNPAID",
  "OTHER",
];

export const POOL_LEAVE_TYPES: readonly LeaveType[] = ["VACATION", "ON_DEMAND"];

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  PENDING: "Oczekuje",
  APPROVED: "Zaakceptowany",
  REJECTED: "Odrzucony",
  CANCELLED: "Wycofany",
};

export const LEAVE_STATUS_TONES: Record<LeaveStatus, BadgeTone> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
};

/** Rodzaj nieobecności albo „Nieobecność”, gdy rodzaj jest ukryty (np. zwolnienie lekarskie). */
export function absenceLabel(type: LeaveType | null): string {
  return type ? LEAVE_TYPE_LABELS[type] : "Nieobecność";
}

/** „1 dzień”, „5 dni” (po polsku tylko jeden dzień ma inną formę). */
export function formatDays(value: number): string {
  return Math.abs(value) === 1 ? `${value} dzień` : `${value} dni`;
}

/** „1 dzień pracy”, „5 dni pracy”. */
export function formatWorkingDays(value: number): string {
  return `${formatDays(value)} pracy`;
}

function dayAndMonth(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", timeZone: "UTC" }).format(date);
}

/** Okres nieobecności, np. „4 sierpnia 2098”, „4 sierpnia – 8 sierpnia 2098” albo przez przełom roku. */
export function formatLeavePeriod(startDate: string, endDate: string): string {
  if (startDate === endDate) return formatDate(startDate);
  if (startDate.slice(0, 4) === endDate.slice(0, 4)) return `${dayAndMonth(startDate)} – ${formatDate(endDate)}`;
  return `${formatDate(startDate)} – ${formatDate(endDate)}`;
}

/** Wymiar urlopu z podstawy (20/26) i etatu, np. „3/4”, zaokrąglony w górę (art. 154 § 2 KP). */
export function suggestEntitledDays(baseDays: number | null, fte: string | null): number | null {
  if (!baseDays || !fte) return null;
  const [numerator, denominator] = fte.split("/").map(Number);
  if (!numerator || !denominator) return baseDays;
  return Math.ceil((baseDays * numerator) / denominator);
}

/** Bieżąca data w Polsce jako `RRRR-MM-DD`. */
export function todayInPoland(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Miesiąc kalendarza: pierwszy i ostatni dzień oraz lista dni. */
export interface MonthRange {
  readonly year: number;
  /** 1–12 */
  readonly month: number;
  readonly from: string;
  readonly to: string;
  readonly days: readonly string[];
}

export function monthRange(year: number, month: number): MonthRange {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  const days = Array.from({ length: last }, (_, index) => `${year}-${pad(month)}-${pad(index + 1)}`);
  return { year, month, from: days[0]!, to: days[days.length - 1]!, days };
}

export function shiftMonth(range: Pick<MonthRange, "year" | "month">, delta: number): MonthRange {
  const index = range.year * 12 + (range.month - 1) + delta;
  return monthRange(Math.floor(index / 12), (index % 12) + 1);
}

/** Nazwa miesiąca z rokiem, np. „sierpień 2098”. */
export function formatMonth(range: Pick<MonthRange, "year" | "month">): string {
  const date = new Date(Date.UTC(range.year, range.month - 1, 15));
  return new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** Dzień tygodnia ISO (1 = poniedziałek … 7 = niedziela). */
export function isoWeekday(value: string): number {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Skrót dnia tygodnia, np. „pn”, „sb”. */
export const WEEKDAY_SHORT = ["", "pn", "wt", "śr", "cz", "pt", "sb", "nd"] as const;
