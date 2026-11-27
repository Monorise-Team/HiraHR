# Baza danych HiraHR

HiraHR korzysta z bazy PostgreSQL 17 i Prisma 7 w paczce `packages/db` (`@hirahr/db`, ADR-0096). Lokalnie baza działa w Dockerze na porcie `5437` (kontener `hira-hr-database`), żeby nie kolidować z Core (`5433`), AvenMail (`5434`), TimoTime (`5435`) i KivoTasks (`5436`).

## Role i bazy (`docker/postgres-init.sql`)

- **`hira_hr_owner`**: właściciel baz `hira_hr` oraz `hira_hr_test`, uruchamia migracje (`packages/db/.env`, `pnpm db:migrate`).
- **`hira_hr_app`**: rola aplikacji (`apps/web/.env.local`), nie jest właścicielem tabel, nie ma `SUPERUSER` ani `BYPASSRLS`. Ma `USAGE` na schematach `public` i `auth` oraz `SELECT, INSERT, UPDATE, DELETE` na tabelach (z wyłączeniem `public._prisma_migrations`, na której uprawnienia są cofnięte).

## Tabele w etapie 0 (`packages/db/prisma/schema.prisma`)

Początkowa migracja (`packages/db/prisma/migrations/20261127200000_init/migration.sql`) zakłada wyłącznie tabele techniczne etapu 0 i infrastrukturę RLS:

| Tabela               | Schemat  | RLS | Przeznaczenie                                                                                                                                |
| -------------------- | -------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`           | `auth`   | Nie | Zaszyfrowane sesje przeglądarki (BFF, `@monorise-team/auth`). Serwer szuka ich po skrócie identyfikatora z ciasteczka przed poznaniem firmy. |
| `event_feed_cursors` | `public` | Nie | Ostatni przetworzony numer `sequence` dla kanału zdarzeń Core (`id = "core"`). Bez danych firmowych.                                         |
| `processed_events`   | `public` | Nie | Deduplikacja zdarzeń `(consumer, event_id)` dla odbiorcy `@monorise-team/events`. Bez danych firmowych.                                      |

## Tabele etapu 1: kartoteka (`20261127210000_employee_records`)

Wszystkie z `ENABLE` + `FORCE ROW LEVEL SECURITY` i polityką `organization_isolation`. Migracja odbiera domyślne prawa nadane w etapie 0 i nadaje tylko potrzebne.

| Tabela                 | Prawa `hira_hr_app`              | Przeznaczenie                                                                                                                                                                                                   |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `positions`            | `SELECT, INSERT, UPDATE`         | Katalog stanowisk; archiwizacja zamiast usuwania; aktywna nazwa unikalna w firmie (indeks częściowy `positions_active_name_key` na `lower(name)`).                                                              |
| `employee_profiles`    | `SELECT, INSERT, UPDATE`         | Kartoteka pracownika Core (`organization_id`, `employee_id`): data urodzenia, kontakty, adresy i kontakt w nagłych wypadkach (JSONB) oraz `pesel_encrypted`, `bank_account_encrypted`, `id_document_encrypted`. |
| `employment_contracts` | `SELECT, INSERT, UPDATE, DELETE` | Umowy z historią; złożony klucz obcy do `positions`; CHECK: data końca dla próbnej i terminowej, etat tylko w umowach o pracę; `salary_encrypted`.                                                              |
| `sensitive_access_log` | `SELECT, INSERT`                 | Dziennik dostępu do danych wrażliwych, tylko do dopisywania; polityka wymaga `actor_account_id = current_account_id()`.                                                                                         |

Kolumny `*_encrypted` mają CHECK na format szyfrogramu (`v1.<klucz>.<iv>.<szyfrogram>.<znacznik>`), więc jawna wartość nie przejdzie. Szyfrowanie: `apps/web/src/server/field-encryption.ts` (AES-256-GCM, losowe IV, AAD = firma, rekord i pole; klucze `HIRAHR_FIELD_ENCRYPTION_KEYS` w formacie `id:base64`, pierwszy szyfruje, wszystkie odszyfrowują; lokalnie tworzy go `pnpm setup:env`).

## Funkcje pomocnicze RLS i `withUser`

Migracja początkowa definiuje dwie stabilne funkcje SQL odczytujące zmienne lokalne transakcji:

- `public.current_organization_id() RETURNS uuid` (czyta `app.organization_id`),
- `public.current_account_id() RETURNS uuid` (czyta `app.account_id`).

Po stronie TypeScript ustawia je wyłącznie `withUser(db, actor, fn)` w `packages/db/src/index.ts`:

- waliduje format UUID w `actor.organizationId` i `actor.accountId` przed otwarciem transakcji,
- uruchamia `SELECT set_config('app.organization_id', ..., true), set_config('app.account_id', ..., true)` wewnątrz `db.$transaction`,
- po zakończeniu transakcji zmienne znikają i nie przeciekają na inne połączenia z puli.

## Zasady dla nowych tabel (od etapu 1)

1. Edytuj `packages/db/prisma/schema.prisma` i wygeneruj nową migrację (`pnpm --filter @hirahr/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`) do nowego katalogu w `packages/db/prisma/migrations/`.
2. Każda tabela z danymi osób albo firm musi dostać w tej samej migracji:
   - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
   - `ALTER TABLE ... FORCE ROW LEVEL SECURITY;`
   - polityki `USING` i `WITH CHECK` korzystające z `public.current_organization_id()` (oraz ewentualnie `public.current_account_id()` lub zakresu jednostek/zasobów).
3. Dodaj testy izolacji w `packages/db/test/rls.test.ts` i `apps/web/test/tenant-isolation.test.ts` (`checkTenantIsolation` z `@monorise-team/testing`).
4. Zmiany w strukturze bazy scalamy dopiero po zgodzie właściciela projektu.

## Testy bazy

- `packages/db/test/rls.test.ts`: sprawdza uprawnienia roli `hira_hr_app`, zachowanie `withUser` i funkcji RLS na tabeli tymczasowej z `ENABLE` + `FORCE ROW LEVEL SECURITY`, tabele techniczne, odmowę dostępu do `public._prisma_migrations` oraz RLS, CHECK i dziennik tylko do dopisywania w tabelach kartoteki.
- `apps/web/test/tenant-isolation.test.ts`: sprawdza separację między firmami przez `checkTenantIsolation` z `@monorise-team/testing`.
- Oba pliki wymagają działającego PostgreSQL (`pnpm db:up && pnpm db:migrate`).
