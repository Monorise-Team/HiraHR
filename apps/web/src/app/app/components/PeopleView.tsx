"use client";

import type { HiraHRClient, PersonListItem, Unit } from "@hirahr/client";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ListItem,
  Select,
  Skeleton,
  TextField,
} from "@monorise-team/ui";
import { Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatApiError } from "../api-errors";
import { personHash } from "../app-views";
import { CONTRACT_TYPE_LABELS, PERSON_STATUS_LABELS } from "../people-ui";

const PAGE_SIZE = 50;

/** Lista ludzi w zasięgu uprawnień `hirahr.employees.read` (wyszukiwanie, filtr jednostki, kolejne strony). */
export function PeopleView({ client, units }: { client: HiraHRClient; units: readonly Unit[] }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [unitId, setUnitId] = useState("");
  const [result, setResult] = useState<{
    key: string;
    items: PersonListItem[];
    nextCursor: string | null;
    error: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const unitNames = useMemo(() => new Map(units.map((unit) => [unit.id, unit.name])), [units]);
  const requestKey = JSON.stringify([query, unitId]);
  // Ładowanie trwa, dopóki wynik nie dotyczy bieżących filtrów (bez ustawiania stanu w efekcie)
  const loading = result?.key !== requestKey;
  const items = loading ? [] : result.items;
  const nextCursor = loading ? null : result.nextCursor;
  const error = (loading ? null : result.error) ?? moreError;

  // Wyszukiwanie po krótkiej przerwie w pisaniu
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const key = JSON.stringify([query, unitId]);
    client.people.list({ search: query || undefined, unitId: unitId || undefined, limit: PAGE_SIZE }).then(
      (page) => {
        if (!cancelled) setResult({ key, items: page.items, nextCursor: page.nextCursor, error: null });
      },
      (failure: unknown) => {
        if (!cancelled) {
          setResult({
            key,
            items: [],
            nextCursor: null,
            error: formatApiError(failure, "Nie udało się wczytać listy ludzi."),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, query, unitId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.people.list({
        search: query || undefined,
        unitId: unitId || undefined,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setResult((current) =>
        current ? { ...current, items: [...current.items, ...page.items], nextCursor: page.nextCursor } : current,
      );
      setMoreError(null);
    } catch (failure) {
      setMoreError(formatApiError(failure, "Nie udało się wczytać kolejnych osób."));
    } finally {
      setLoadingMore(false);
    }
  }, [client, nextCursor, query, unitId]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-primary">Ludzie</h1>
        <p className="text-sm text-text-secondary">Kartoteki osób, do których masz dostęp.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
        <TextField
          label="Szukaj"
          placeholder="Imię lub nazwisko"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-shortcut-search
        />
        <Select label="Jednostka" value={unitId} onChange={(event) => setUnitId(event.target.value)}>
          <option value="">Wszystkie</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </Select>
      </div>

      {error ? <Banner tone="danger" message={error} /> : null}

      <Card surface="middle" className="flex flex-col gap-1 p-2">
        {loading ? (
          <div className="flex flex-col gap-2 p-2" aria-busy="true" aria-label="Wczytywanie listy ludzi">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Users aria-hidden />}
            title={query || unitId ? "Nikt nie pasuje do filtrów" : "Brak osób"}
            description={
              query || unitId ? "Zmień wyszukiwanie albo jednostkę." : "W Twoim zasięgu nie ma jeszcze żadnej osoby."
            }
          />
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Lista ludzi">
            {items.map((person) => {
              const unitLabel = person.unitIds
                .map((id) => unitNames.get(id))
                .filter(Boolean)
                .join(", ");
              const contract = person.currentContractType ? CONTRACT_TYPE_LABELS[person.currentContractType] : null;
              return (
                <li key={person.employeeId}>
                  <ListItem
                    leading={<Avatar name={person.fullName} size="sm" />}
                    title={person.fullName}
                    subtitle={[person.currentPosition?.name, unitLabel].filter(Boolean).join(" · ") || "Bez stanowiska"}
                    meta={
                      person.status !== "ACTIVE" ? (
                        <Badge tone="neutral">{PERSON_STATUS_LABELS[person.status] ?? person.status}</Badge>
                      ) : contract ? (
                        <span className="text-xs text-text-tertiary">{contract}</span>
                      ) : null
                    }
                    onClick={() => {
                      window.location.hash = personHash(person.employeeId);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {nextCursor && !loading ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Wczytywanie…" : "Wczytaj więcej"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
