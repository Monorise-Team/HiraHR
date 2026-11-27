"use client";

import type { CalendarAbsence, HiraHRClient, Unit } from "@hirahr/client";
import { Banner, Button, Select, Skeleton } from "@monorise-team/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { polishHolidays } from "@/lib/polish-calendar";
import { formatApiError } from "../api-errors";
import {
  absenceLabel,
  formatLeavePeriod,
  formatMonth,
  isoWeekday,
  LEAVE_STATUS_LABELS,
  monthRange,
  shiftMonth,
  todayInPoland,
  WEEKDAY_SHORT,
  type MonthRange,
} from "../leave-ui";
import { Section } from "./PersonView";

/** Najwięcej stron po 100 nieobecności w jednym miesiącu (zabezpieczenie przed pętlą). */
const MAX_PAGES = 20;

async function loadMonth(client: HiraHRClient, range: MonthRange, unitId: string): Promise<CalendarAbsence[]> {
  const items: CalendarAbsence[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.leave.calendar({
      from: range.from,
      to: range.to,
      limit: 100,
      ...(unitId ? { unitId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

/**
 * Kalendarz nieobecności zespołu na miesiąc: wiersz na osobę z nieobecnością, kolumna na dzień.
 * Rodzaj widzą sama osoba, rozpatrujący i kadry; pozostali widzą „Nieobecność” (zakres ustala serwer).
 */
export function TeamCalendar({ client, units }: { client: HiraHRClient; units: readonly Unit[] }) {
  const today = todayInPoland();
  const [range, setRange] = useState<MonthRange>(() =>
    monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7))),
  );
  const [unitId, setUnitId] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; items: CalendarAbsence[] } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const key = `${range.from}|${unitId}`;

  useEffect(() => {
    let cancelled = false;
    loadMonth(client, range, unitId).then(
      (items) => {
        if (!cancelled) setLoaded({ key, items });
      },
      (failure: unknown) => {
        if (!cancelled) setFailed({ key, message: formatApiError(failure, "Nie udało się wczytać kalendarza.") });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, range, unitId, key]);

  const items = loaded?.key === key ? loaded.items : null;
  const error = failed?.key === key ? failed.message : null;
  const holidays = useMemo(() => polishHolidays(range.year), [range.year]);

  const rows = useMemo(() => {
    if (!items) return [];
    const byPerson = new Map<string, { name: string; absences: CalendarAbsence[] }>();
    for (const absence of items) {
      const row = byPerson.get(absence.employeeId) ?? { name: absence.employeeName, absences: [] };
      row.absences.push(absence);
      byPerson.set(absence.employeeId, row);
    }
    return [...byPerson.entries()]
      .map(([employeeId, row]) => ({ employeeId, ...row }))
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));
  }, [items]);

  return (
    <Section
      title="Kalendarz zespołu"
      description="Nieobecności osób, które widzisz. Współpracownicy widzą tylko zaakceptowane nieobecności, bez rodzaju."
      action={
        <div className="flex flex-wrap items-center gap-2">
          {units.length > 0 ? (
            <Select
              aria-label="Jednostka"
              value={unitId}
              onChange={(event) => setUnitId(event.target.value)}
              className="min-w-40"
            >
              <option value="">Wszystkie jednostki</option>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </Select>
          ) : null}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              icon={<ChevronLeft aria-hidden />}
              aria-label="Poprzedni miesiąc"
              onClick={() => setRange((current) => shiftMonth(current, -1))}
            />
            <span className="min-w-32 text-center text-sm font-medium text-text-primary first-letter:uppercase">
              {formatMonth(range)}
            </span>
            <Button
              variant="ghost"
              size="xs"
              icon={<ChevronRight aria-hidden />}
              aria-label="Następny miesiąc"
              onClick={() => setRange((current) => shiftMonth(current, 1))}
            />
          </div>
        </div>
      }
    >
      {error ? <Banner tone="danger" message={error} /> : null}
      {!items && !error ? <Skeleton className="h-24" /> : null}
      {items && rows.length === 0 ? (
        <p className="text-sm text-text-secondary">W tym miesiącu nikt nie ma zaplanowanej nieobecności.</p>
      ) : null}
      {items && rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <caption className="sr-only">Nieobecności w miesiącu {formatMonth(range)}</caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-10 min-w-36 bg-surface-middle pr-3 text-left font-medium text-text-tertiary"
                >
                  Osoba
                </th>
                {range.days.map((day) => {
                  const weekday = isoWeekday(day);
                  const off = weekday >= 6 || holidays.has(day);
                  return (
                    <th
                      key={day}
                      scope="col"
                      title={holidays.has(day) ? "Dzień ustawowo wolny od pracy" : undefined}
                      className={`min-w-7 px-0.5 pb-1 text-center font-normal ${
                        off ? "text-text-tertiary" : "text-text-secondary"
                      } ${day === today ? "text-accent-strong font-semibold" : ""}`}
                    >
                      <span className="block">{Number(day.slice(8))}</span>
                      <span className="block text-[10px]">{WEEKDAY_SHORT[weekday]}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 max-w-48 truncate bg-surface-middle py-1 pr-3 text-left text-sm font-normal text-text-primary"
                  >
                    {row.name}
                  </th>
                  {range.days.map((day) => {
                    const absence = row.absences.find((item) => item.startDate <= day && item.endDate >= day);
                    const off = isoWeekday(day) >= 6 || holidays.has(day);
                    const label = absence
                      ? `${row.name}: ${absenceLabel(absence.type)}, ${formatLeavePeriod(absence.startDate, absence.endDate)} (${LEAVE_STATUS_LABELS[absence.status].toLowerCase()})`
                      : undefined;
                    return (
                      <td key={day} className={`h-7 px-px py-1 ${off ? "bg-bg-tertiary/60" : ""}`}>
                        {absence ? (
                          <span
                            role="img"
                            aria-label={label}
                            title={label}
                            className={`block h-5 rounded-sm ${
                              absence.status === "PENDING"
                                ? "border border-warning bg-warning/25"
                                : off
                                  ? "bg-accent/40"
                                  : "bg-accent"
                            }`}
                          />
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-4 text-xs text-text-tertiary">
        <span className="flex items-center gap-1.5">
          <span className="block size-3 rounded-sm bg-accent" aria-hidden /> Zaakceptowana
        </span>
        <span className="flex items-center gap-1.5">
          <span className="block size-3 rounded-sm border border-warning bg-warning/25" aria-hidden /> Oczekuje na
          akceptację
        </span>
        <span className="flex items-center gap-1.5">
          <span className="block size-3 rounded-sm bg-bg-tertiary" aria-hidden /> Weekend i święta
        </span>
      </div>
    </Section>
  );
}
