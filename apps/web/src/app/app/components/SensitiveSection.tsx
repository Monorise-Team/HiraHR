"use client";

import type {
  HiraHRClient,
  PersonCard,
  SensitiveAccessLogEntry,
  SensitiveData,
  UpdateSensitiveInput,
} from "@hirahr/client";
import { Banner, Button, Dialog, TextField, useToast } from "@monorise-team/ui";
import { Eye, EyeOff, History, Pencil, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { formatApiError } from "../api-errors";
import {
  CONTRACT_TYPE_LABELS,
  formatContractPeriod,
  formatDateTime,
  formatIban,
  formatSalary,
  formatSensitiveFields,
} from "../people-ui";
import { Field, Section } from "./PersonView";

/**
 * Dane wrażliwe: domyślnie ukryte, odsłaniane na wyraźne żądanie (każdy odczyt trafia do dziennika).
 * Widoczne dla samej osoby i dla `hirahr.sensitive.read` w zakresie całej firmy (ADR-0104).
 */
export function SensitiveSection({
  client,
  card,
  onChange,
}: {
  client: HiraHRClient;
  card: PersonCard;
  onChange: (card: PersonCard) => void;
}) {
  const [data, setData] = useState<SensitiveData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [log, setLog] = useState<SensitiveAccessLogEntry[] | null>(null);

  const reveal = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await client.people.sensitive(card.employeeId));
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się odczytać danych wrażliwych."));
    } finally {
      setLoading(false);
    }
  };

  const showLog = async () => {
    setError(null);
    try {
      setLog((await client.people.accessLog(card.employeeId, { limit: 20 })).items);
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się wczytać dziennika."));
    }
  };

  const contractsById = new Map(card.contracts.map((contract) => [contract.id, contract]));
  const presence = card.sensitive;

  return (
    <Section
      title="Dane wrażliwe"
      description="PESEL, rachunek, dokument i wynagrodzenia są szyfrowane. Każde wyświetlenie i zmiana trafia do dziennika."
      action={
        <div className="flex flex-wrap gap-2">
          {data ? (
            <Button variant="secondary" size="sm" icon={<EyeOff aria-hidden />} onClick={() => setData(null)}>
              Ukryj
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<Eye aria-hidden />}
              onClick={() => void reveal()}
              disabled={loading}
            >
              {loading ? "Odczytywanie…" : "Pokaż"}
            </Button>
          )}
          {card.access.canUpdateSensitive ? (
            <Button variant="secondary" size="sm" icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>
              Zmień
            </Button>
          ) : null}
        </div>
      }
    >
      {error ? <Banner tone="danger" message={error} /> : null}
      <dl className="grid gap-4 sm:grid-cols-3">
        <Field label="PESEL">{data ? (data.pesel ?? "—") : presence.pesel ? "••••••••••• (wpisany)" : "—"}</Field>
        <Field label="Numer rachunku">
          {data ? formatIban(data.bankAccount) : presence.bankAccount ? "•••• (wpisany)" : "—"}
        </Field>
        <Field label="Numer dokumentu">
          {data ? (data.idDocumentNumber ?? "—") : presence.idDocumentNumber ? "•••• (wpisany)" : "—"}
        </Field>
      </dl>
      {data && data.salaries.some((entry) => entry.salary) ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs tracking-wide text-text-tertiary uppercase">Wynagrodzenia</h3>
          <ul className="flex flex-col gap-1">
            {data.salaries
              .filter((entry) => entry.salary)
              .map((entry) => {
                const contract = contractsById.get(entry.contractId);
                return (
                  <li key={entry.contractId} className="text-sm text-text-primary">
                    {formatSalary(entry.salary!)}
                    {contract ? (
                      <span className="text-text-secondary">
                        {" "}
                        · {CONTRACT_TYPE_LABELS[contract.type]},{" "}
                        {formatContractPeriod(contract.startDate, contract.endDate)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border-primary pt-3">
        {log === null ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<History aria-hidden />}
            className="w-fit"
            onClick={() => void showLog()}
          >
            {card.access.self ? "Kto oglądał moje dane" : "Dziennik dostępu"}
          </Button>
        ) : log.length === 0 ? (
          <p className="text-sm text-text-secondary">Nikt jeszcze nie oglądał ani nie zmieniał tych danych.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Dziennik dostępu do danych wrażliwych">
            {log.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                <ShieldCheck className="size-4 text-text-tertiary" aria-hidden />
                <span className="text-text-primary">{entry.actor.name}</span>
                <span className="text-text-secondary">
                  {entry.action === "READ" ? "wyświetla" : "zmienia"}: {formatSensitiveFields(entry.fields)}
                </span>
                <span className="text-xs text-text-tertiary">{formatDateTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing ? (
        <SensitiveDialog
          client={client}
          card={card}
          current={data}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            setData(null);
            setLog(null);
            onChange(updated);
          }}
        />
      ) : null}
    </Section>
  );
}

function SensitiveDialog({
  client,
  card,
  current,
  onClose,
  onSaved,
}: {
  client: HiraHRClient;
  card: PersonCard;
  current: SensitiveData | null;
  onClose: () => void;
  onSaved: (card: PersonCard) => void;
}) {
  const toast = useToast();
  const [pesel, setPesel] = useState(current?.pesel ?? "");
  const [bankAccount, setBankAccount] = useState(current?.bankAccount ? formatIban(current.bankAccount) : "");
  const [idDocumentNumber, setIdDocumentNumber] = useState(current?.idDocumentNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    // Puste pole bez odczytanych danych zostawia wartość bez zmian; po odczycie pusta wartość ją usuwa
    const input: UpdateSensitiveInput = {};
    const assign = (key: keyof UpdateSensitiveInput, value: string, previous: string | null | undefined) => {
      const trimmed = value.trim();
      if (trimmed) input[key] = trimmed;
      else if (current && previous) input[key] = null;
    };
    assign("pesel", pesel, current?.pesel);
    assign("bankAccount", bankAccount, current?.bankAccount);
    assign("idDocumentNumber", idDocumentNumber, current?.idDocumentNumber);
    if (Object.keys(input).length === 0) {
      setError("Wpisz co najmniej jedną wartość.");
      return;
    }
    setSaving(true);
    try {
      onSaved(await client.people.updateSensitive(card.employeeId, input));
      toast.toast({ tone: "success", title: "Zapisano dane wrażliwe." });
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się zapisać danych wrażliwych."));
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
      title="Zmień dane wrażliwe"
      description={`${card.fullName}. Zmiana trafi do dziennika (bez samych wartości).`}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        {error ? <Banner tone="danger" message={error} /> : null}
        <TextField
          label="PESEL"
          inputMode="numeric"
          autoComplete="off"
          maxLength={11}
          hint={current ? undefined : "Puste pole zostawia obecną wartość"}
          value={pesel}
          onChange={(event) => setPesel(event.target.value)}
        />
        <TextField
          label="Numer rachunku (IBAN)"
          autoComplete="off"
          hint="Polski rachunek: 26 cyfr, z PL albo bez"
          value={bankAccount}
          onChange={(event) => setBankAccount(event.target.value)}
        />
        <TextField
          label="Numer dokumentu tożsamości"
          autoComplete="off"
          value={idDocumentNumber}
          onChange={(event) => setIdDocumentNumber(event.target.value)}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Anuluj
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Zapisywanie…" : "Zapisz"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
