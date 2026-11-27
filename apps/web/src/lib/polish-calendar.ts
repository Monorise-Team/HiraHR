/**
 * Kalendarz pracy w Polsce: 14 dni ustawowo wolnych (10 stałych z Wigilią od 2025 roku i 4 ruchome od Wielkanocy)
 * oraz liczenie dni pracy według tygodniowego wymiaru pracy z MonoriseCore (`{ 1: minuty, …, 7: minuty }`).
 * Ten sam sposób liczenia co w TimoTime (`reminders-rules.ts`), żeby urlop i czas pracy zgadzały się ze sobą.
 */

const FIXED_HOLIDAYS: readonly (readonly [number, number])[] = [
  [1, 1], // Nowy Rok
  [1, 6], // Święto Trzech Króli
  [5, 1], // Święto Pracy
  [5, 3], // Święto Konstytucji 3 Maja
  [8, 15], // Wniebowzięcie Najświętszej Maryi Panny
  [11, 1], // Wszystkich Świętych
  [11, 11], // Narodowe Święto Niepodległości
  [12, 24], // Wigilia Bożego Narodzenia (od 2025 roku)
  [12, 25], // Pierwszy dzień Bożego Narodzenia
  [12, 26], // Drugi dzień Bożego Narodzenia
];

/** Tygodniowy wymiar pracy: minuty pracy w dniu tygodnia ISO (1 = poniedziałek … 7 = niedziela). */
export type WeeklySchedule = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;

/** Bez wymiaru z Core przyjmujemy pełny etat od poniedziałku do piątku. */
export const DEFAULT_WEEKLY_SCHEDULE: WeeklySchedule = { 1: 480, 2: 480, 3: 480, 4: 480, 5: 480 };

const holidaysByYear = new Map<number, ReadonlySet<string>>();

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Niedziela Wielkanocna (algorytm Meeusa/Jonesa/Butchera) jako `RRRR-MM-DD`. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

/** Wszystkie 14 polskich dni ustawowo wolnych od pracy w danym roku. */
export function polishHolidays(year: number): ReadonlySet<string> {
  const cached = holidaysByYear.get(year);
  if (cached) return cached;
  const result = new Set<string>();
  for (const [month, day] of FIXED_HOLIDAYS) {
    result.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  const easter = easterSunday(year);
  result.add(easter); // Niedziela Wielkanocna
  result.add(addDays(easter, 1)); // Poniedziałek Wielkanocny
  result.add(addDays(easter, 49)); // Zielone Świątki
  result.add(addDays(easter, 60)); // Boże Ciało
  holidaysByYear.set(year, result);
  return result;
}

function isoWeekday(value: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const day = utcDate(value).getUTCDay();
  return (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export interface WorkingDaysResult {
  /** Liczba dni pracy w okresie (dni z wymiarem pracy > 0, bez świąt). */
  readonly workingDays: number;
  /** Święta przypadające w dni, które byłyby dniami pracy. */
  readonly holidays: readonly string[];
}

/**
 * Dni pracy między datami włącznie: dzień z wymiarem pracy większym od zera i niebędący świętem.
 * Okres najwyżej 400 dni (wniosek o urlop jest roczny), dłuższy daje błąd.
 */
export function countWorkingDays(from: string, to: string, schedule: WeeklySchedule | null): WorkingDaysResult {
  const plan =
    schedule && Object.values(schedule).some((minutes) => (minutes ?? 0) > 0) ? schedule : DEFAULT_WEEKLY_SCHEDULE;
  const start = utcDate(from);
  const end = utcDate(to);
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (span < 0) return { workingDays: 0, holidays: [] };
  if (span > 400) throw new Error("Okres jest za długi do policzenia dni pracy");
  let workingDays = 0;
  const holidays: string[] = [];
  for (let offset = 0; offset <= span; offset++) {
    const day = addDays(from, offset);
    if ((plan[isoWeekday(day)] ?? 0) <= 0) continue;
    if (polishHolidays(Number(day.slice(0, 4))).has(day)) {
      holidays.push(day);
      continue;
    }
    workingDays++;
  }
  return { workingDays, holidays };
}
