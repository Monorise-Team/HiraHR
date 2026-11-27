"use client";

import type { HiraHRClient, Position } from "@hirahr/client";
import { Badge, Banner, Button, Card, EmptyState, InputDialog, Skeleton, TextField, useToast } from "@monorise-team/ui";
import { Archive, ArchiveRestore, Briefcase, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatApiError } from "../api-errors";

/** Katalog stanowisk firmy (`hirahr.settings.manage`): dodawanie, zmiana nazwy i archiwizacja. */
export function PositionsView({ client }: { client: HiraHRClient }) {
  const toast = useToast();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Position | null>(null);

  const load = useCallback(
    () =>
      client.positions.list({ includeArchived: true, limit: 100 }).then(
        (page) => setPositions(page.items),
        (failure: unknown) => setError(formatApiError(failure, "Nie udało się wczytać stanowisk.")),
      ),
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await action();
      toast.toast({ tone: "success", title: success });
      await load();
    } catch (failure) {
      setError(formatApiError(failure));
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await run(() => client.positions.create({ name: name.trim() }), "Dodano stanowisko.");
    setName("");
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-primary">Stanowiska</h1>
        <p className="text-sm text-text-secondary">
          Stanowiska wybiera się przy umowach. Nieużywane zarchiwizuj: znikną z wyboru, a stare umowy je zachowają.
        </p>
      </div>

      <form className="flex items-end gap-2" onSubmit={(event) => void add(event)}>
        <div className="flex-1">
          <TextField
            label="Nowe stanowisko"
            placeholder="np. Magazynierka"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" icon={<Plus aria-hidden />} disabled={saving || !name.trim()}>
          Dodaj
        </Button>
      </form>

      {error ? <Banner tone="danger" message={error} /> : null}

      <Card surface="middle" className="p-2">
        {positions === null ? (
          <div className="flex flex-col gap-2 p-2" aria-busy="true" aria-label="Wczytywanie stanowisk">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : positions.length === 0 ? (
          <EmptyState
            icon={<Briefcase aria-hidden />}
            title="Brak stanowisk"
            description="Dodaj pierwsze stanowisko, żeby wybierać je przy umowach."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border-primary" aria-label="Lista stanowisk">
            {positions.map((position) => (
              <li key={position.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={position.archived ? "text-sm text-text-tertiary" : "text-sm text-text-primary"}>
                    {position.name}
                  </span>
                  {position.archived ? <Badge tone="neutral">Zarchiwizowane</Badge> : null}
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Pencil aria-hidden />}
                    aria-label={`Zmień nazwę stanowiska ${position.name}`}
                    onClick={() => setRenaming(position)}
                  >
                    Zmień nazwę
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={position.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                    aria-label={`${position.archived ? "Przywróć" : "Archiwizuj"} stanowisko ${position.name}`}
                    onClick={() =>
                      void run(
                        () => client.positions.update(position.id, { archived: !position.archived }),
                        position.archived ? "Przywrócono stanowisko." : "Zarchiwizowano stanowisko.",
                      )
                    }
                  >
                    {position.archived ? "Przywróć" : "Archiwizuj"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <InputDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Zmień nazwę stanowiska"
        label="Nazwa"
        defaultValue={renaming?.name ?? ""}
        confirmLabel="Zapisz"
        onConfirm={(value) => {
          const position = renaming;
          setRenaming(null);
          if (position)
            void run(() => client.positions.update(position.id, { name: value.trim() }), "Zmieniono nazwę.");
        }}
      />
    </div>
  );
}
