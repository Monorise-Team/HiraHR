# HiraHR

Kadry Monorise w przeglądarce: kartoteka pracowników, umowy i stanowiska, urlopy i nieobecności oraz akta osobowe. Zakresem funkcji wzorujemy się na Personio dopasowanym do polskiego prawa pracy ([ADR-0104](https://github.com/Monorise-Team/MonoriseDocumentation/blob/main/adr/ADR-0104-hirahr-personio-polish-labour-law.md)). Logowanie, firmy, pracownicy, jednostki i uprawnienia pochodzą z MonoriseCore.

## Etapy

| Etap | Zakres                                                                                              | Stan    |
| ---- | --------------------------------------------------------------------------------------------------- | ------- |
| 0    | szkielet: logowanie przez Core, `/me`, uprawnienia i role, kanał zdarzeń, powłoka aplikacji, strona | gotowy  |
| 1    | kartoteka: dane kadrowe, umowy z historią, stanowiska, dane wrażliwe szyfrowane, dziennik dostępu   | gotowy  |
| 2    | urlopy i nieobecności: salda 20/26 dni, wnioski, akceptacja kierownika, kalendarz zespołu           | w toku  |
| 3    | dokumenty: akta osobowe w częściach A–E, magazyn zgodny z S3, terminy przechowywania                | później |

## Części

| Katalog              | Co to jest                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web`           | Next.js na porcie 3600: `hira.localhost` (strona i API `/api/v1`), `hirahr.localhost` (aplikacja) |
| `packages/contracts` | schematy Zod, typy API, manifest uprawnień `hirahr.*` i gotowe role                               |
| `packages/db`        | Prisma 7 z RLS, lokalnie PostgreSQL w Dockerze na porcie 5437                                     |
| `packages/client`    | typowany klient API dla przeglądarki                                                              |

Szczegóły dla agentów: [architektura](docs/agents/architecture.md), [API](docs/agents/api.md), [baza](docs/agents/database.md).

## Uruchomienie lokalnie

Wymaga działającego MonoriseCore (`Repos/MonoriseCore`, porty 3100 i 3200) z klientem `hirahr-web` z `pnpm oauth:seed`.

```bash
pnpm install
pnpm setup:env      # apps/web/.env.local i packages/db/.env
pnpm db:up          # PostgreSQL hira-hr-database na porcie 5437
pnpm db:migrate     # migracje w bazie roboczej i testowej
pnpm permissions:register
pnpm dev            # http://hirahr.localhost:3600
```

Firma potrzebuje dostępu do produktu (`pnpm entitlement:grant -- --organization <domena> --product hirahr` w MonoriseCore), a osoba dostępu do aplikacji w Portalu.

`pnpm check` uruchamia formatowanie, zgodność wersji, OpenAPI, lint, typy, testy (z lokalną bazą) i budowę.
