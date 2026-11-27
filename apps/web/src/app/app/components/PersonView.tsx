"use client";

import type { Address, EmergencyContact, HiraHRClient, PersonCard, Unit, UpdateProfileInput } from "@hirahr/client";
import { Avatar, Badge, Banner, Button, Card, Skeleton, TextField, useToast } from "@monorise-team/ui";
import { ArrowLeft, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { formatApiError } from "../api-errors";
import { VIEW_HASHES } from "../app-views";
import { formatAddress, formatDate, PERSON_STATUS_LABELS } from "../people-ui";
import { ContractsSection } from "./ContractsSection";
import { SensitiveSection } from "./SensitiveSection";

/** Karta osoby: dane z Core i kartoteka HiraHR. Ten sam widok służy jako „Mój profil”. */
export function PersonView({
  client,
  employeeId,
  units,
  isOwnProfile,
}: {
  client: HiraHRClient;
  employeeId: string;
  units: readonly Unit[];
  isOwnProfile: boolean;
}) {
  const [card, setCard] = useState<PersonCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Karta jest montowana od nowa dla każdej osoby (klucz w rodzicu), więc stan startuje pusty
  const load = useCallback(() => {
    client.people.get(employeeId).then(
      (loaded) => {
        setCard(loaded);
        setError(null);
      },
      (failure: unknown) => setError(formatApiError(failure, "Nie udało się wczytać karty osoby.")),
    );
  }, [client, employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  const unitNames = useMemo(() => new Map(units.map((unit) => [unit.id, unit.name])), [units]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        {isOwnProfile ? null : <BackLink />}
        <Banner tone="danger" message={error} />
      </div>
    );
  }
  if (!card) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Wczytywanie karty osoby">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const unitLabel = card.unitIds
    .map((id) => unitNames.get(id))
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex flex-col gap-5">
      {isOwnProfile ? null : <BackLink />}
      <div className="flex items-center gap-4">
        <Avatar name={card.fullName} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-xl font-semibold text-text-primary">
            {isOwnProfile ? "Mój profil" : card.fullName}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            {isOwnProfile ? <span>{card.fullName}</span> : null}
            {unitLabel ? <span>{unitLabel}</span> : null}
            {card.status !== "ACTIVE" ? (
              <Badge tone="neutral">{PERSON_STATUS_LABELS[card.status] ?? card.status}</Badge>
            ) : null}
          </div>
        </div>
      </div>

      <ProfileSection client={client} card={card} onChange={setCard} />
      <ContractsSection client={client} card={card} onChanged={load} />
      {card.access.canReadSensitive ? <SensitiveSection client={client} card={card} onChange={setCard} /> : null}
    </div>
  );
}

function BackLink() {
  return (
    <a
      href={VIEW_HASHES.people}
      className="flex w-fit items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Wróć do listy ludzi
    </a>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card surface="middle" className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs tracking-wide text-text-tertiary uppercase">{label}</dt>
      <dd className="text-sm text-text-primary">{children}</dd>
    </div>
  );
}

interface AddressDraft {
  street: string;
  postalCode: string;
  city: string;
  country: string;
}

const emptyAddress: AddressDraft = { street: "", postalCode: "", city: "", country: "Polska" };

function toAddressDraft(address: Address | null): AddressDraft {
  return address ? { ...address } : { ...emptyAddress };
}

/** Pusty adres zapisujemy jako brak adresu; częściowo wypełniony sprawdzi serwer. */
function fromAddressDraft(draft: AddressDraft): Address | null {
  const filled = draft.street.trim() || draft.postalCode.trim() || draft.city.trim();
  return filled ? { ...draft } : null;
}

function ProfileSection({
  client,
  card,
  onChange,
}: {
  client: HiraHRClient;
  card: PersonCard;
  onChange: (card: PersonCard) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [personalEmail, setPersonalEmail] = useState("");
  const [personalPhone, setPersonalPhone] = useState("");
  const [home, setHome] = useState<AddressDraft>(emptyAddress);
  const [mailing, setMailing] = useState<AddressDraft>(emptyAddress);
  const [emergency, setEmergency] = useState<EmergencyContact>({ name: "", relation: "", phone: "" });

  const startEditing = () => {
    const profile = card.profile;
    setDateOfBirth(profile.dateOfBirth ?? "");
    setPersonalEmail(profile.personalEmail ?? "");
    setPersonalPhone(profile.personalPhone ?? "");
    setHome(toAddressDraft(profile.homeAddress));
    setMailing(toAddressDraft(profile.mailingAddress));
    setEmergency(profile.emergencyContact ?? { name: "", relation: "", phone: "" });
    setError(null);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const emergencyFilled = emergency.name.trim() || emergency.phone.trim();
    const input: UpdateProfileInput = {
      dateOfBirth: dateOfBirth || null,
      personalEmail: personalEmail.trim() || null,
      personalPhone: personalPhone.trim() || null,
      homeAddress: fromAddressDraft(home),
      mailingAddress: fromAddressDraft(mailing),
      emergencyContact: emergencyFilled ? emergency : null,
    };
    try {
      onChange(await client.people.update(card.employeeId, input));
      setEditing(false);
      toast.toast({ tone: "success", title: "Zapisano kartotekę." });
    } catch (failure) {
      setError(formatApiError(failure, "Nie udało się zapisać kartoteki."));
    } finally {
      setSaving(false);
    }
  };

  const profile = card.profile;
  return (
    <Section
      title="Dane osobowe"
      description={card.access.self ? "Możesz sam zmieniać swoje dane kontaktowe." : undefined}
      action={
        card.access.canUpdateProfile && !editing ? (
          <Button variant="secondary" size="sm" icon={<Pencil aria-hidden />} onClick={startEditing}>
            Edytuj
          </Button>
        ) : null
      }
    >
      {editing ? (
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          {error ? <Banner tone="danger" message={error} /> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Data urodzenia"
              type="date"
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.target.value)}
            />
            <TextField
              label="Prywatny e-mail"
              type="email"
              value={personalEmail}
              onChange={(event) => setPersonalEmail(event.target.value)}
            />
            <TextField
              label="Prywatny telefon"
              type="tel"
              value={personalPhone}
              onChange={(event) => setPersonalPhone(event.target.value)}
            />
          </div>
          <AddressFields legend="Adres zamieszkania" value={home} onChange={setHome} />
          <AddressFields legend="Adres do korespondencji (jeśli inny)" value={mailing} onChange={setMailing} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text-primary">Kontakt w nagłych wypadkach</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                label="Imię i nazwisko"
                value={emergency.name}
                onChange={(event) => setEmergency({ ...emergency, name: event.target.value })}
              />
              <TextField
                label="Kim jest"
                placeholder="np. żona, brat"
                value={emergency.relation}
                onChange={(event) => setEmergency({ ...emergency, relation: event.target.value })}
              />
              <TextField
                label="Telefon"
                type="tel"
                value={emergency.phone}
                onChange={(event) => setEmergency({ ...emergency, phone: event.target.value })}
              />
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Anuluj
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Zapisywanie…" : "Zapisz"}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field label="Data urodzenia">{formatDate(profile.dateOfBirth)}</Field>
          <Field label="Prywatny e-mail">{profile.personalEmail ?? "—"}</Field>
          <Field label="Prywatny telefon">{profile.personalPhone ?? "—"}</Field>
          <Field label="Adres zamieszkania">{formatAddress(profile.homeAddress)}</Field>
          <Field label="Adres do korespondencji">
            {profile.mailingAddress ? formatAddress(profile.mailingAddress) : "Jak zamieszkania"}
          </Field>
          <Field label="Kontakt w nagłych wypadkach">
            {profile.emergencyContact
              ? `${profile.emergencyContact.name}${profile.emergencyContact.relation ? ` (${profile.emergencyContact.relation})` : ""}, ${profile.emergencyContact.phone}`
              : "—"}
          </Field>
        </dl>
      )}
    </Section>
  );
}

function AddressFields({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: AddressDraft;
  onChange: (value: AddressDraft) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text-primary">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1.5fr_1fr]">
        <TextField
          label="Ulica i numer"
          value={value.street}
          onChange={(event) => onChange({ ...value, street: event.target.value })}
        />
        <TextField
          label="Kod pocztowy"
          value={value.postalCode}
          onChange={(event) => onChange({ ...value, postalCode: event.target.value })}
        />
        <TextField
          label="Miejscowość"
          value={value.city}
          onChange={(event) => onChange({ ...value, city: event.target.value })}
        />
        <TextField
          label="Kraj"
          value={value.country}
          onChange={(event) => onChange({ ...value, country: event.target.value })}
        />
      </div>
    </fieldset>
  );
}
