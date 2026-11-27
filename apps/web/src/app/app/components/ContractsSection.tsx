"use client";

import type {
  ContractType,
  CreateContractInput,
  EmploymentContract,
  HiraHRClient,
  PersonCard,
  Position,
  SalaryPeriod,
} from "@hirahr/client";
import { Badge, Banner, Button, ConfirmDialog, Dialog, Select, TextArea, TextField, useToast } from "@monorise-team/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { formatApiError } from "../api-errors";
import {
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPE_ORDER,
  EMPLOYMENT_TYPES,
  formatContractPeriod,
  formatFte,
  TYPES_WITH_END_DATE,
} from "../people-ui";
import { Section } from "./PersonView";

/** Umowy osoby z historią; zmiany dla `employees.update` w zasięgu, wynagrodzenie tylko z danymi wrażliwymi. */
export function ContractsSection({
  client,
  card,
  onChanged,
}: {
  client: HiraHRClient;
  card: PersonCard;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<{ contract: EmploymentContract | null } | null>(null);
  const [toDelete, setToDelete] = useState<EmploymentContract | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (contract: EmploymentContract) => {
    setError(null);
    try {
      await client.contracts.delete(contract.id);
      toast.toast({ tone: "success", title: "Usunięto umowę." });
      onChanged();
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się usunąć umowy."));
    }
  };

  return (
    <Section
      title="Umowy"
      description="Historia zatrudnienia: każda kolejna umowa albo aneks to nowy wpis."
      action={
        card.access.canManageContracts ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus aria-hidden />}
            onClick={() => setDialog({ contract: null })}
          >
            Dodaj umowę
          </Button>
        ) : null
      }
    >
      {error ? <Banner tone="danger" message={error} /> : null}
      {card.contracts.length === 0 ? (
        <p className="text-sm text-text-secondary">Brak umów w kartotece.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-primary">
          {card.contracts.map((contract) => (
            <li
              key={contract.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{CONTRACT_TYPE_LABELS[contract.type]}</span>
                  {contract.current ? <Badge tone="success">Obecna</Badge> : null}
                </div>
                <span className="text-sm text-text-secondary">
                  {[
                    formatContractPeriod(contract.startDate, contract.endDate),
                    contract.position?.name,
                    formatFte(contract.fte),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {contract.notes ? <span className="text-xs text-text-tertiary">{contract.notes}</span> : null}
              </div>
              {card.access.canManageContracts ? (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Pencil aria-hidden />}
                    aria-label={`Edytuj umowę: ${CONTRACT_TYPE_LABELS[contract.type]}`}
                    onClick={() => setDialog({ contract })}
                  >
                    Edytuj
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 aria-hidden />}
                    aria-label={`Usuń umowę: ${CONTRACT_TYPE_LABELS[contract.type]}`}
                    onClick={() => setToDelete(contract)}
                  >
                    Usuń
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {dialog ? (
        <ContractDialog
          client={client}
          card={card}
          contract={dialog.contract}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.toast({ tone: "success", title: "Zapisano umowę." });
            onChanged();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Usunąć umowę?"
        description="Usuń tylko umowę wpisaną przez pomyłkę. Koniec zatrudnienia zapisz jako datę końca umowy."
        confirmLabel="Usuń umowę"
        danger
        onConfirm={() => {
          const contract = toDelete;
          setToDelete(null);
          if (contract) void remove(contract);
        }}
      />
    </Section>
  );
}

function ContractDialog({
  client,
  card,
  contract,
  onClose,
  onSaved,
}: {
  client: HiraHRClient;
  card: PersonCard;
  contract: EmploymentContract | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [type, setType] = useState<ContractType>(contract?.type ?? "INDEFINITE");
  const [startDate, setStartDate] = useState(contract?.startDate ?? "");
  const [endDate, setEndDate] = useState(contract?.endDate ?? "");
  const [fte, setFte] = useState(contract?.fte ?? "1/1");
  const [positionId, setPositionId] = useState(contract?.position?.id ?? "");
  const [notes, setNotes] = useState(contract?.notes ?? "");
  const [salaryAmount, setSalaryAmount] = useState("");
  const [salaryPeriod, setSalaryPeriod] = useState<SalaryPeriod>("MONTH");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSetSalary = card.access.canUpdateSensitive;
  const isEmployment = EMPLOYMENT_TYPES.includes(type);
  const needsEnd = TYPES_WITH_END_DATE.includes(type);

  useEffect(() => {
    client.positions.list({ limit: 100 }).then(
      (page) => setPositions(page.items),
      () => setPositions([]),
    );
  }, [client]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const salary =
      canSetSalary && salaryAmount.trim()
        ? { amount: salaryAmount.trim().replace(",", "."), currency: "PLN", period: salaryPeriod }
        : undefined;
    const base = {
      type,
      startDate,
      endDate: endDate || null,
      fte: isEmployment ? fte : null,
      positionId: positionId || null,
      notes: notes.trim() || null,
      ...(salary ? { salary } : {}),
    };
    try {
      if (contract) {
        await client.contracts.update(contract.id, base);
      } else {
        await client.people.createContract(card.employeeId, base as CreateContractInput);
      }
      onSaved();
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się zapisać umowy."));
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
      title={contract ? "Edytuj umowę" : "Nowa umowa"}
      description={card.fullName}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        {error ? <Banner tone="danger" message={error} /> : null}
        <Select label="Rodzaj umowy" value={type} onChange={(event) => setType(event.target.value as ContractType)}>
          {CONTRACT_TYPE_ORDER.map((value) => (
            <option key={value} value={value}>
              {CONTRACT_TYPE_LABELS[value]}
            </option>
          ))}
        </Select>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Początek"
            type="date"
            required
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
          <TextField
            label={needsEnd ? "Koniec" : "Koniec (jeśli znany)"}
            type="date"
            required={needsEnd}
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {isEmployment ? (
            <TextField
              label="Wymiar etatu"
              hint="Ułamek, np. 1/1 albo 3/4"
              value={fte}
              onChange={(event) => setFte(event.target.value)}
            />
          ) : null}
          <Select label="Stanowisko" value={positionId} onChange={(event) => setPositionId(event.target.value)}>
            <option value="">Bez stanowiska</option>
            {positions.map((position) => (
              <option key={position.id} value={position.id}>
                {position.name}
              </option>
            ))}
          </Select>
        </div>
        {canSetSalary ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Wynagrodzenie brutto (zł)"
              hint={contract?.hasSalary ? "Zostaw puste, żeby nie zmieniać" : "Dana wrażliwa, zapis w dzienniku"}
              inputMode="decimal"
              value={salaryAmount}
              onChange={(event) => setSalaryAmount(event.target.value)}
            />
            <Select
              label="Za okres"
              value={salaryPeriod}
              onChange={(event) => setSalaryPeriod(event.target.value as SalaryPeriod)}
            >
              <option value="MONTH">miesiąc</option>
              <option value="HOUR">godzinę</option>
            </Select>
          </div>
        ) : null}
        <TextArea label="Uwagi" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
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
