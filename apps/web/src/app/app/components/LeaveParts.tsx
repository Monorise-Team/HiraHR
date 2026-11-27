"use client";

import type { HiraHRClient, LeaveBalance, LeaveRequest, LeaveType, VacationBaseDays } from "@hirahr/client";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  InputDialog,
  ProgressBar,
  Select,
  TextArea,
  TextField,
  useToast,
} from "@monorise-team/ui";
import { Check, Undo2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { formatApiError } from "../api-errors";
import {
  absenceLabel,
  formatDays,
  formatLeavePeriod,
  formatWorkingDays,
  isIsoDate,
  LEAVE_STATUS_LABELS,
  LEAVE_STATUS_TONES,
  LEAVE_TYPE_HINTS,
  LEAVE_TYPE_LABELS,
  POOL_LEAVE_TYPES,
  suggestEntitledDays,
} from "../leave-ui";
import { formatDate } from "../people-ui";

// ── Saldo ───────────────────────────────────────────────────────────────────

/** Saldo urlopu wypoczynkowego: ile zostało, z czego się składa i ile dni na żądanie wykorzystano. */
export function BalanceSummary({ balance, isOwn }: { balance: LeaveBalance; isOwn: boolean }) {
  if (!balance.configured) {
    return (
      <p className="text-sm text-text-secondary">
        {isOwn
          ? `Kadry nie ustaliły jeszcze Twojego salda urlopu na ${balance.year} rok. Do tego czasu nie złożysz wniosku o urlop wypoczynkowy.`
          : `Saldo urlopu na ${balance.year} rok nie jest jeszcze ustalone.`}
      </p>
    );
  }
  const pool = balance.entitledDays + balance.carriedOverDays;
  const taken = balance.usedDays + balance.pendingDays;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex flex-col">
          <span className="text-3xl font-semibold text-text-primary tabular-nums">{balance.remainingDays}</span>
          <span className="text-sm text-text-secondary">
            {balance.remainingDays === 1 ? "dzień do wykorzystania" : "dni do wykorzystania"}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Wymiar" value={formatDays(balance.entitledDays)} />
          <Stat label="Zaległy" value={formatDays(balance.carriedOverDays)} />
          <Stat label="Wykorzystane" value={formatDays(balance.usedDays)} />
          <Stat label="Zaplanowane" value={formatDays(balance.pendingDays)} />
        </dl>
      </div>
      <ProgressBar
        value={pool > 0 ? Math.min(100, Math.round((taken / pool) * 100)) : 0}
        label={`Wykorzystane i zaplanowane: ${formatDays(taken)} z ${formatDays(pool)}`}
      />
      <p className="text-xs text-text-tertiary">
        Urlop na żądanie: {balance.onDemandUsedDays} z {balance.onDemandLimit} dni w roku
        {balance.notes ? ` · ${balance.notes}` : ""}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs tracking-wide text-text-tertiary uppercase">{label}</dt>
      <dd className="text-text-primary tabular-nums">{value}</dd>
    </div>
  );
}

// ── Lista wniosków ──────────────────────────────────────────────────────────

/**
 * Wnioski z akcjami dozwolonymi przez serwer (`access`): wycofanie, akceptacja i odrzucenie z uzasadnieniem.
 * `showName` pokazuje osobę (lista do akceptacji, karta osoby dla kadr).
 */
export function LeaveRequestList({
  client,
  requests,
  showName,
  emptyText,
  onChanged,
}: {
  client: HiraHRClient;
  requests: readonly LeaveRequest[];
  showName: boolean;
  emptyText: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [toCancel, setToCancel] = useState<LeaveRequest | null>(null);
  const [toReject, setToReject] = useState<LeaveRequest | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (request: LeaveRequest, action: () => Promise<unknown>, success: string, fallback: string) => {
    setWorking(request.id);
    setError(null);
    try {
      await action();
      toast.toast({ tone: "success", title: success });
      onChanged();
    } catch (failure) {
      setError(formatApiError(failure, fallback));
    } finally {
      setWorking(null);
    }
  };

  if (requests.length === 0 && !error) {
    return <p className="text-sm text-text-secondary">{emptyText}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner tone="danger" message={error} /> : null}
      <ul className="flex flex-col divide-y divide-border-primary">
        {requests.map((request) => {
          const busy = working === request.id;
          return (
            <li key={request.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {showName ? `${request.employeeName} · ` : ""}
                    {absenceLabel(request.type)}
                  </span>
                  <Badge tone={LEAVE_STATUS_TONES[request.status]}>{LEAVE_STATUS_LABELS[request.status]}</Badge>
                </div>
                <span className="text-sm text-text-secondary">
                  {formatLeavePeriod(request.startDate, request.endDate)} · {formatWorkingDays(request.workingDays)}
                </span>
                {request.note ? <span className="text-xs text-text-tertiary">„{request.note}”</span> : null}
                {request.decidedBy && request.status !== "PENDING" ? (
                  <span className="text-xs text-text-tertiary">
                    {request.status === "REJECTED" ? "Odrzucił(a)" : "Rozpatrzył(a)"}: {request.decidedBy.name}
                    {request.decidedAt ? `, ${formatDate(request.decidedAt.slice(0, 10))}` : ""}
                    {request.decisionNote ? ` · „${request.decisionNote}”` : ""}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1">
                {request.access.canDecide ? (
                  <>
                    <Button
                      variant="primary"
                      size="xs"
                      icon={<Check aria-hidden />}
                      disabled={busy}
                      aria-label={`Akceptuj wniosek: ${request.employeeName}, ${formatLeavePeriod(request.startDate, request.endDate)}`}
                      onClick={() =>
                        void run(
                          request,
                          () => client.leave.decide(request.id, { decision: "APPROVE" }),
                          "Wniosek zaakceptowany.",
                          "Nie udało się zaakceptować wniosku.",
                        )
                      }
                    >
                      Akceptuj
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<X aria-hidden />}
                      disabled={busy}
                      aria-label={`Odrzuć wniosek: ${request.employeeName}, ${formatLeavePeriod(request.startDate, request.endDate)}`}
                      onClick={() => setToReject(request)}
                    >
                      Odrzuć
                    </Button>
                  </>
                ) : null}
                {request.access.canCancel ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Undo2 aria-hidden />}
                    disabled={busy}
                    aria-label={`Wycofaj: ${absenceLabel(request.type)}, ${formatLeavePeriod(request.startDate, request.endDate)}`}
                    onClick={() => setToCancel(request)}
                  >
                    Wycofaj
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={toCancel !== null}
        onOpenChange={(open) => {
          if (!open) setToCancel(null);
        }}
        title="Wycofać wniosek?"
        description={
          toCancel
            ? `${absenceLabel(toCancel.type)}, ${formatLeavePeriod(toCancel.startDate, toCancel.endDate)}. Dni wrócą do salda, a wpis zostanie w historii jako wycofany.`
            : ""
        }
        confirmLabel="Wycofaj"
        onConfirm={() => {
          const request = toCancel;
          setToCancel(null);
          if (request) {
            void run(
              request,
              () => client.leave.cancel(request.id),
              "Wniosek wycofany.",
              "Nie udało się wycofać wniosku.",
            );
          }
        }}
      />

      <InputDialog
        open={toReject !== null}
        onOpenChange={(open) => {
          if (!open) setToReject(null);
        }}
        title="Odrzucić wniosek?"
        description={
          toReject
            ? `${toReject.employeeName}: ${absenceLabel(toReject.type)}, ${formatLeavePeriod(toReject.startDate, toReject.endDate)}`
            : undefined
        }
        label="Uzasadnienie (opcjonalnie)"
        placeholder="Np. w tym tygodniu jest inwentaryzacja"
        required={false}
        validate={(value) => (value.length > 500 ? "Najwyżej 500 znaków" : null)}
        confirmLabel="Odrzuć wniosek"
        onConfirm={(value) => {
          const request = toReject;
          setToReject(null);
          if (request) {
            void run(
              request,
              () => client.leave.decide(request.id, { decision: "REJECT", note: value.trim() || null }),
              "Wniosek odrzucony.",
              "Nie udało się odrzucić wniosku.",
            );
          }
        }}
      />
    </div>
  );
}

// ── Nowy wniosek ────────────────────────────────────────────────────────────

/**
 * Wniosek za siebie albo wpis kadr za inną osobę (`employeeId`). Podgląd liczy dni pracy na serwerze
 * (wymiar pracy z Core i polskie święta), a przy urlopie z puli pokazuje, ile dni zostanie.
 */
export function LeaveRequestDialog({
  client,
  employeeId,
  employeeName,
  types,
  balance,
  forOther,
  onClose,
  onSaved,
}: {
  client: HiraHRClient;
  employeeId: string;
  employeeName: string;
  types: readonly LeaveType[];
  balance: LeaveBalance | null;
  forOther: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<LeaveType>(types[0] ?? "VACATION");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; workingDays: number; holidays: string[] } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);

  const effectiveEnd = endDate || startDate;
  const rangeKey = `${startDate}|${effectiveEnd}`;
  const rangeValid = isIsoDate(startDate) && isIsoDate(effectiveEnd) && effectiveEnd >= startDate;

  useEffect(() => {
    if (!rangeValid) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client.leave.workingDays({ from: startDate, to: effectiveEnd, ...(forOther ? { employeeId } : {}) }).then(
        (result) => {
          if (!cancelled) setPreview({ key: rangeKey, workingDays: result.workingDays, holidays: result.holidays });
        },
        (failure: unknown) => {
          if (!cancelled) {
            setPreviewError({ key: rangeKey, message: formatApiError(failure, "Nie udało się policzyć dni pracy.") });
          }
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, employeeId, forOther, rangeKey, rangeValid, startDate, effectiveEnd]);

  const currentPreview = rangeValid && preview?.key === rangeKey ? preview : null;
  const currentPreviewError = rangeValid && previewError?.key === rangeKey ? previewError.message : null;
  const fromPool = POOL_LEAVE_TYPES.includes(type);
  const balanceForYear = balance && balance.year === Number(startDate.slice(0, 4)) ? balance : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await client.leave.create({
        ...(forOther ? { employeeId } : {}),
        type,
        startDate,
        endDate: effectiveEnd,
        note: note.trim() || null,
      });
      onSaved();
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się zapisać wniosku."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={forOther ? "Wpisz nieobecność" : "Nowy wniosek"}
      description={
        forOther ? `${employeeName}. Wpis kadr jest od razu zaakceptowany.` : "Wniosek trafi do akceptacji kierownika."
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        {error ? <Banner tone="danger" message={error} /> : null}
        <Select
          label="Rodzaj"
          hint={LEAVE_TYPE_HINTS[type]}
          value={type}
          onChange={(event) => setType(event.target.value as LeaveType)}
        >
          {types.map((value) => (
            <option key={value} value={value}>
              {LEAVE_TYPE_LABELS[value]}
            </option>
          ))}
        </Select>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Od"
            type="date"
            required
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
          <TextField
            label="Do"
            type="date"
            hint="Puste: jeden dzień"
            min={startDate || undefined}
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </div>
        <div aria-live="polite" className="min-h-5 text-sm">
          {currentPreviewError ? (
            <span className="text-danger">{currentPreviewError}</span>
          ) : currentPreview ? (
            <span className="text-text-secondary">
              {currentPreview.workingDays === 0
                ? "W tym okresie nie ma dni pracy."
                : `To ${formatWorkingDays(currentPreview.workingDays)}`}
              {currentPreview.holidays.length > 0
                ? ` (bez świąt: ${currentPreview.holidays.map((day) => formatDate(day)).join(", ")})`
                : ""}
              {fromPool && balanceForYear?.configured && currentPreview.workingDays > 0
                ? `. Po tym wniosku zostanie ${formatDays(balanceForYear.remainingDays - currentPreview.workingDays)}.`
                : currentPreview.workingDays > 0
                  ? "."
                  : ""}
            </span>
          ) : null}
        </div>
        <TextArea
          label="Uwagi (opcjonalnie)"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Anuluj
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !rangeValid}>
            {saving ? "Zapisywanie…" : forOther ? "Wpisz" : "Złóż wniosek"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Saldo na rok (kadry) ────────────────────────────────────────────────────

export function EntitlementDialog({
  client,
  employeeId,
  employeeName,
  balance,
  onClose,
  onSaved,
}: {
  client: HiraHRClient;
  employeeId: string;
  employeeName: string;
  balance: LeaveBalance;
  onClose: () => void;
  onSaved: (balance: LeaveBalance) => void;
}) {
  const [baseDays, setBaseDays] = useState<string>(balance.baseDays ? String(balance.baseDays) : "");
  const [entitledDays, setEntitledDays] = useState(
    String(balance.configured ? balance.entitledDays : (balance.suggestedEntitledDays ?? "")),
  );
  const [carriedOverDays, setCarriedOverDays] = useState(String(balance.carriedOverDays));
  const suggested = suggestEntitledDays(baseDays ? Number(baseDays) : null, balance.currentContractFte);
  const [notes, setNotes] = useState(balance.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await client.leave.updateEntitlement(employeeId, balance.year, {
        baseDays: baseDays ? (Number(baseDays) as VacationBaseDays) : null,
        entitledDays: Number(entitledDays),
        carriedOverDays: Number(carriedOverDays || 0),
        notes: notes.trim() || null,
      });
      onSaved(saved);
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się zapisać salda."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Saldo urlopu na ${balance.year} rok`}
      description={employeeName}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        {error ? <Banner tone="danger" message={error} /> : null}
        <Select
          label="Podstawa z Kodeksu pracy"
          hint="20 dni przy stażu poniżej 10 lat, 26 dni przy co najmniej 10 latach (z nauką)"
          value={baseDays}
          onChange={(event) => {
            const next = event.target.value;
            setBaseDays(next);
            const suggestion = suggestEntitledDays(next ? Number(next) : null, balance.currentContractFte);
            if (suggestion !== null) setEntitledDays(String(suggestion));
          }}
        >
          <option value="">Nie podano</option>
          <option value="20">20 dni</option>
          <option value="26">26 dni</option>
        </Select>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Wymiar na rok (dni)"
            type="number"
            min={0}
            max={100}
            required
            hint={
              suggested !== null
                ? `Z etatu obecnej umowy (${balance.currentContractFte}): ${formatDays(suggested)}`
                : balance.currentContractFte
                  ? "Wybierz podstawę, żeby policzyć wymiar z etatu"
                  : "Brak obecnej umowy o pracę; wpisz wymiar ręcznie"
            }
            value={entitledDays}
            onChange={(event) => setEntitledDays(event.target.value)}
          />
          <TextField
            label="Urlop zaległy (dni)"
            type="number"
            min={0}
            max={100}
            hint="Niewykorzystany z poprzedniego roku"
            value={carriedOverDays}
            onChange={(event) => setCarriedOverDays(event.target.value)}
          />
        </div>
        <TextArea
          label="Uwagi"
          rows={2}
          maxLength={500}
          placeholder="Np. wymiar proporcjonalny od 1 marca"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Anuluj
          </Button>
          <Button type="submit" variant="primary" disabled={saving || entitledDays === ""}>
            {saving ? "Zapisywanie…" : "Zapisz saldo"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
