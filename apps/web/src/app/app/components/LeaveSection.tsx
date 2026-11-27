"use client";

import {
  ApiError,
  LEAVE_TYPES,
  type HiraHRClient,
  type LeaveBalance,
  type LeaveRequest,
  type PersonCard,
} from "@hirahr/client";
import { Banner, Button, Skeleton, useToast } from "@monorise-team/ui";
import { CalendarPlus, ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { formatApiError } from "../api-errors";
import { SELF_SERVICE_LEAVE_TYPES, todayInPoland } from "../leave-ui";
import { BalanceSummary, EntitlementDialog, LeaveRequestDialog, LeaveRequestList } from "./LeaveParts";
import { Section } from "./PersonView";

type State =
  | { status: "loading"; key: string }
  | { status: "hidden"; key: string }
  | { status: "error"; key: string; message: string }
  | { status: "ready"; key: string; balance: LeaveBalance; requests: LeaveRequest[] };

/**
 * Urlopy na karcie osoby: saldo w roku, ostatnie wnioski i akcje kadr (saldo, wpis nieobecności).
 * Sekcja znika, gdy zalogowana osoba nie ma wglądu w urlopy tej osoby (serwer odpowiada 403/404).
 */
export function LeaveSection({
  client,
  card,
  isOwnProfile,
}: {
  client: HiraHRClient;
  card: PersonCard;
  isOwnProfile: boolean;
}) {
  const toast = useToast();
  const [year, setYear] = useState(() => Number(todayInPoland().slice(0, 4)));
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const [dialog, setDialog] = useState<"entitlement" | "entry" | "request" | null>(null);
  const key = `${card.employeeId}|${year}|${version}`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.leave.balance(card.employeeId, year),
      client.leave.requests(isOwnProfile ? { limit: 10 } : { employeeId: card.employeeId, limit: 10 }),
    ]).then(
      ([balance, page]) => {
        if (!cancelled) setState({ status: "ready", key, balance, requests: page.items });
      },
      (failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) {
          setState({ status: "hidden", key });
        } else {
          setState({ status: "error", key, message: formatApiError(failure, "Nie udało się wczytać urlopów.") });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, card.employeeId, isOwnProfile, year, key]);

  const current: State = state && state.key === key ? state : { status: "loading", key };
  if (current.status === "hidden") return null;
  const refresh = () => setVersion((value) => value + 1);
  const balance = current.status === "ready" ? current.balance : null;
  const access = balance?.access;
  const entryTypes = LEAVE_TYPES.filter((type) => type !== "SICK" || access?.canEnterSick);

  return (
    <Section
      title={`Urlopy w ${year} roku`}
      description={isOwnProfile ? "Twoje saldo i ostatnie wnioski." : "Saldo urlopu wypoczynkowego i ostatnie wnioski."}
      action={
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            icon={<ChevronLeft aria-hidden />}
            aria-label="Poprzedni rok"
            onClick={() => setYear((value) => value - 1)}
          />
          <Button
            variant="ghost"
            size="xs"
            icon={<ChevronRight aria-hidden />}
            aria-label="Następny rok"
            onClick={() => setYear((value) => value + 1)}
          />
          {access?.canManage ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil aria-hidden />}
                onClick={() => setDialog("entitlement")}
              >
                Ustal saldo
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<CalendarPlus aria-hidden />}
                onClick={() => setDialog("entry")}
              >
                Wpisz nieobecność
              </Button>
            </>
          ) : null}
          {isOwnProfile && access?.canRequest ? (
            <Button variant="secondary" size="sm" icon={<Plus aria-hidden />} onClick={() => setDialog("request")}>
              Nowy wniosek
            </Button>
          ) : null}
        </div>
      }
    >
      {current.status === "error" ? <Banner tone="danger" message={current.message} /> : null}
      {current.status === "loading" ? <Skeleton className="h-24" /> : null}
      {current.status === "ready" ? (
        <>
          <BalanceSummary balance={current.balance} isOwn={isOwnProfile} />
          <LeaveRequestList
            client={client}
            requests={current.requests}
            showName={false}
            emptyText="Brak wniosków i nieobecności."
            onChanged={refresh}
          />
        </>
      ) : null}

      {dialog === "entitlement" && balance ? (
        <EntitlementDialog
          client={client}
          employeeId={card.employeeId}
          employeeName={card.fullName}
          balance={balance}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.toast({ tone: "success", title: "Zapisano saldo urlopu." });
            refresh();
          }}
        />
      ) : null}
      {dialog === "entry" || dialog === "request" ? (
        <LeaveRequestDialog
          client={client}
          employeeId={card.employeeId}
          employeeName={card.fullName}
          types={dialog === "entry" ? entryTypes : SELF_SERVICE_LEAVE_TYPES}
          balance={balance}
          forOther={dialog === "entry"}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.toast({
              tone: "success",
              title: dialog === "entry" ? "Wpisano nieobecność." : "Wniosek złożony. Czeka na akceptację.",
            });
            refresh();
          }}
        />
      ) : null}
    </Section>
  );
}
