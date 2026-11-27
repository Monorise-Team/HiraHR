"use client";

import type { Capabilities, HiraHRClient, LeaveBalance, LeaveRequest, Unit } from "@hirahr/client";
import { Banner, Button, Skeleton, useToast } from "@monorise-team/ui";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatApiError } from "../api-errors";
import { SELF_SERVICE_LEAVE_TYPES, todayInPoland } from "../leave-ui";
import { BalanceSummary, LeaveRequestDialog, LeaveRequestList } from "./LeaveParts";
import { Section } from "./PersonView";
import { TeamCalendar } from "./TeamCalendar";

type Loaded<T> = { version: number; value: T } | { version: number; error: string };

function useLoad<T>(
  load: () => Promise<T>,
  version: number,
  fallback: string,
): { value: T | null; error: string | null } {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) setState({ version, value });
      },
      (failure: unknown) => {
        if (!cancelled) setState({ version, error: formatApiError(failure, fallback) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, version, fallback]);
  if (!state || state.version !== version) return { value: null, error: null };
  return "error" in state ? { value: null, error: state.error } : { value: state.value, error: null };
}

/**
 * Widok „Urlopy”: własne saldo i wnioski, wnioski do akceptacji (kierownicy i kadry) oraz kalendarz zespołu.
 */
export function LeaveView({
  client,
  employeeId,
  employeeName,
  capabilities,
  units,
}: {
  client: HiraHRClient;
  employeeId: string;
  employeeName: string;
  capabilities: Capabilities;
  units: readonly Unit[];
}) {
  const toast = useToast();
  const [year, setYear] = useState(() => Number(todayInPoland().slice(0, 4)));
  const [version, setVersion] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const canApprove = capabilities.approveLeave || capabilities.manageLeave;
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  const balance = useLoad<LeaveBalance>(
    useCallback(() => client.leave.balance(employeeId, year), [client, employeeId, year]),
    version * 10_000 + year,
    "Nie udało się wczytać salda urlopu.",
  );
  const mine = useLoad(
    useCallback(() => client.leave.requests({ limit: 50 }), [client]),
    version,
    "Nie udało się wczytać wniosków.",
  );
  const approvals = useLoad<{ items: LeaveRequest[] }>(
    useCallback(
      () => (canApprove ? client.leave.requests({ approvals: true, limit: 100 }) : Promise.resolve({ items: [] })),
      [client, canApprove],
    ),
    version,
    "Nie udało się wczytać wniosków do akceptacji.",
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text-primary">Urlopy</h1>
        {capabilities.requestLeave ? (
          <Button variant="primary" size="sm" icon={<Plus aria-hidden />} onClick={() => setDialogOpen(true)}>
            Nowy wniosek
          </Button>
        ) : null}
      </div>

      <Section
        title={`Moje saldo urlopu na ${year} rok`}
        description="Urlop wypoczynkowy razem z urlopem na żądanie, w dniach pracy."
        action={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              icon={<ChevronLeft aria-hidden />}
              aria-label="Poprzedni rok"
              onClick={() => setYear((value) => value - 1)}
            />
            <span className="min-w-12 text-center text-sm tabular-nums text-text-primary">{year}</span>
            <Button
              variant="ghost"
              size="xs"
              icon={<ChevronRight aria-hidden />}
              aria-label="Następny rok"
              onClick={() => setYear((value) => value + 1)}
            />
          </div>
        }
      >
        {balance.error ? <Banner tone="danger" message={balance.error} /> : null}
        {balance.value ? (
          <BalanceSummary balance={balance.value} isOwn />
        ) : balance.error ? null : (
          <Skeleton className="h-20" />
        )}
      </Section>

      {canApprove ? (
        <Section title="Do akceptacji" description="Oczekujące wnioski osób z Twoich jednostek, od najbliższych.">
          {approvals.error ? <Banner tone="danger" message={approvals.error} /> : null}
          {approvals.value ? (
            <LeaveRequestList
              client={client}
              requests={approvals.value.items}
              showName
              emptyText="Nie ma wniosków czekających na Twoją decyzję."
              onChanged={refresh}
            />
          ) : approvals.error ? null : (
            <Skeleton className="h-16" />
          )}
        </Section>
      ) : null}

      <Section title="Moje wnioski" description="Od najnowszych. Oczekujący wniosek i przyszły urlop możesz wycofać.">
        {mine.error ? <Banner tone="danger" message={mine.error} /> : null}
        {mine.value ? (
          <LeaveRequestList
            client={client}
            requests={mine.value.items}
            showName={false}
            emptyText={
              capabilities.requestLeave
                ? "Nie masz jeszcze wniosków. Złóż pierwszy przyciskiem „Nowy wniosek”."
                : "Nie masz wniosków. Składanie wniosków włącza Owner albo kadry (rola Pracownik)."
            }
            onChanged={refresh}
          />
        ) : mine.error ? null : (
          <Skeleton className="h-16" />
        )}
      </Section>

      <TeamCalendar key={version} client={client} units={units} />

      {dialogOpen ? (
        <LeaveRequestDialog
          client={client}
          employeeId={employeeId}
          employeeName={employeeName}
          types={SELF_SERVICE_LEAVE_TYPES}
          balance={balance.value}
          forOther={false}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            toast.toast({ tone: "success", title: "Wniosek złożony. Czeka na akceptację." });
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
