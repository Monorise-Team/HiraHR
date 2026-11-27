# Architektura HiraHR

HiraHR to kadry Monorise w przeglądarce, wzorowane zakresem funkcji na Personio dopasowanym do polskiego prawa pracy (ADR-0104). Działa wyłącznie w przeglądarce, bez aplikacji mobilnej i desktopowej. Układ repozytorium powtarza KivoTasks (ADR-0096).

Core jest źródłem tożsamości, pracowników, jednostek, przełożonych i wymiaru pracy; HiraHR przechowuje tylko dane kadrowe powiązane z pracownikiem Core (`employeeId`) i nie kopiuje struktury firmy (ADR-0030).

## Układ przestrzeni roboczej

| Katalog                   | Rola                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                | Jedna aplikacja Next.js (lokalnie port `3600`): strona produktu i API `/api/v1` na `hira.*`, aplikacja w przeglądarce na `hirahr.*`.                                  |
| `packages/contracts`      | Schematy Zod, typy odpowiedzi API (`{ data, meta, error }`, `Capabilities`, `Me`), manifest uprawnień (`HIRAHR_PERMISSIONS`) i gotowe role (`HIRAHR_ROLE_TEMPLATES`). |
| `packages/client`         | Typowany klient HTTP API HiraHR dla przeglądarki (`createClient`, `ApiError`).                                                                                        |
| `packages/db`             | Schemat Prisma 7, migracje PostgreSQL, klient bazy (`createDb`), `uuidv7` i pomocnik RLS `withUser`.                                                                  |
| `openapi/hirahr-api.json` | Opis OpenAPI 3.1 generowany deterministycznie z katalogu ścieżek i schematów Zod.                                                                                     |

## Routing według hosta (`apps/web/src/proxy.ts` i `src/lib/hosts.ts`)

- `hira.monorise.studio` (lokalnie `hira.localhost:3600`): wyświetla stronę produktu (`src/app/(site)/`) oraz udostępnia API `/api/v1/*`. Ścieżki `/app` i `/app/*` na tym hoście zwracają `404`.
- `hirahr.monorise.studio` (lokalnie `hirahr.localhost:3600`): przepisuje wszystkie ścieżki poza `/api/*` pod `/app/*` (`src/app/app/`). Lista hostów aplikacji może być nadpisana zmienną `HIRAHR_APP_HOSTS`.
- Żądania wstępne CORS (`OPTIONS /api/*`) przepuszczają wyłącznie adresy z `HIRAHR_ALLOWED_ORIGINS`.

## Logowanie i integracja z MonoriseCore

- **Sesja przeglądarki (BFF, ADR-0050):** `apps/web/src/server/auth.ts` tworzy instancję `createWebAuth` z `@monorise-team/auth/next` dla klienta `hirahr-web` i obu zasobów (`HIRAHR_API_URL` oraz `CORE_API_URL`). Sesje trafiają do `auth.sessions` (`src/server/sessions.ts`), a tokeny są zaszyfrowane kluczem `HIRAHR_SESSION_SECRET`.
- **Trasy logowania:** `/api/auth/sign-in`, `/api/auth/callback`, `/api/auth/sign-out`.
- **Tożsamość żądania:** wyłącznie `requireUser(request)` w `src/server/auth.ts`. Zwraca `Caller` (`organizationId`, `accountId`, `employeeId`, `context`, `session`, `token`).
- **Klient Core SDK (`src/server/core.ts` i `src/server/core-machine.ts`):**
  - `createUserCoreClient(session)`: wywołania w imieniu zalogowanej osoby (`GET /core/v1/me` dla `GET /api/v1/me`).
  - `getMachineCoreClient()`: token maszynowy OAuth 2.1 (`client_credentials`, zakresy `core:permissions.read core:directory.read core:events.read`), buforowany do 30 s przed wygaśnięciem z pojedynczym odświeżaniem w locie (`single-flight`).
  - Oba klienty ponawiają żądania przy krótkich błędach sieci i statusach `429`, `502`, `503`, `504` (`DEFAULT_CORE_RETRY`: 3 próby, 200 do 2000 ms). Przy trwałej awarii serwer odmawia bezpiecznie kodem `503` (fail-closed).

## Uprawnienia, role i kanał zdarzeń

- **Deklaracja:** `packages/contracts/src/permissions.ts` (`definePermissions("hirahr", ...)`):
  - `hirahr.employees.read|update`, `hirahr.sensitive.read|update`, `hirahr.leave.request|approve|manage`, `hirahr.documents.read|manage`, `hirahr.settings.manage`.
  - Gotowe role: `hirahr.employee` (Pracownik), `hirahr.manager` (Kierownik), `hirahr.hr` (Kadry).
  - Samoobsługa (własna kartoteka, saldo i wnioski) działa dla każdej osoby z dostępem do produktu, bez ról.
- **Rejestracja w Core:** `pnpm permissions:register` (`apps/web/scripts/register-permissions.mjs` i `src/server/core-registration.ts`, zakres `core:permissions.register`). Wysyła idempotentnie najpierw manifest uprawnień, potem szablony ról.
- **Sprawdzanie po stronie serwera (`src/server/permissions.ts`):**
  - Pamięć podręczna `createPermissionCache` (maks. 5 minut, jedna instancja na proces w `globalThis.__hirahrPermissionCache`, odświeżana natychmiast po wzroście `authz_rev`).
  - `assertProductAccess` zwraca `403 PRODUCT_ACCESS_REQUIRED`, gdy `"hirahr"` nie ma w `snapshot.products`.
  - `assertPermission` i `assertPermissionScope` sprawdzają dostęp do produktu oraz uprawnienie lub jego efektywny zakres (`ORGANIZATION` albo `LIMITED` z `unitIds` i `resourceIds`).
  - `capabilitiesFromSnapshot` wylicza `Capabilities` dla `GET /api/v1/me`.
  - **Dane wrażliwe tylko w zakresie całej firmy (ADR-0104):** `canOrganizationWide` i `assertOrganizationWidePermission` uznają `hirahr.sensitive.*` wyłącznie przy zakresie `ORGANIZATION`; przypisanie ograniczone do jednostek nie daje dostępu (Core nie ma takiego ograniczenia, pilnuje go HiraHR). Lista takich uprawnień: `HIRAHR_ORGANIZATION_ONLY_PERMISSIONS`.
- **Kanał zdarzeń Core (`src/server/event-feed.ts` i `src/instrumentation.ts`, ADR-0100):**
  - W środowisku Node.js `register()` uruchamia `startCoreEventPolling()`, gdy `HIRAHR_EVENT_FEED_INTERVAL_MS > 0` (domyślnie `5000` w `development`, `0` poza nim).
  - Po odebraniu `organization.permissions.changed` natychmiast wywołuje `invalidatePermissionCache({ organizationId, accountId })`.
  - Ograniczenie: pamięć podręczna uprawnień działa w pamięci pojedynczego procesu; przed skalowaniem na wiele instancji potrzebna będzie wspólna pamięć podręczna albo kursor na instancję.

## Powłoka aplikacji (`apps/web/src/app/app/`)

- Korzysta wyłącznie z `@monorise-team/ui` i tokenów `@monorise-team/tokens` (ADR-0091).
- `HiraHRApp.tsx`: zarządza stanem sesji (`LoadingView`, `SignedOutView` z bezpiecznym powrotem `sanitizeReturnTo`, `LoadErrorView`, `NoAccessView`) i wyborem widoku z fragmentu URL (`app-views.ts`: `#moj-profil`, `#ludzie`, `#urlopy`, `#wyglad`). Do aplikacji wystarcza dostęp do produktu (samoobsługa).
- `HiraHRShell.tsx`: `AppShell`, zwijany `SidebarShell`, paleta poleceń `⌘K` (`CommandPalette`), pomoc skrótów (`ShortcutsHelp` pod `?`) i skróty `g p` (Mój profil), `g l` (Ludzie), `g u` (Urlopy), `g w` (Wygląd).
- W etapie 0 widoki „Mój profil”, „Ludzie” i „Urlopy” wyświetlają stan pusty z zapowiedzią etapów 1 i 2, a „Wygląd” (`AppearanceView.tsx`) udostępnia ustawienia motywu (`AppearanceControls`).

## Polecenia robocze

```bash
pnpm install && pnpm setup:env && pnpm db:up && pnpm db:migrate
pnpm permissions:register # rejestracja uprawnień i gotowych ról w MonoriseCore
pnpm openapi              # generowanie openapi/hirahr-api.json
pnpm openapi:check        # weryfikacja aktualności openapi/hirahr-api.json
pnpm dev                  # hira.localhost:3600 i hirahr.localhost:3600
pnpm check                # pełne kontrole (wymaga lokalnego PostgreSQL)
pnpm test                 # testy we wszystkich paczkach
pnpm shared:update        # aktualizacja paczek @monorise-team/* do jednej wersji
```
