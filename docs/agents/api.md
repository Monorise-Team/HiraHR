# API, kontrakty i testy HiraHR

API HiraHR działa pod ścieżką `/api/v1/*` na hoście `hira.monorise.studio` (lokalnie `http://hira.localhost:3600/api/v1`).

## Standard odpowiedzi i obsługa tras (`apps/web/src/server/api.ts`)

- Każda trasa w `apps/web/src/app/api/v1/**/route.ts` jest opakowana w `route()` z `src/server/api.ts`.
- Każda odpowiedź ma nagłówek `Cache-Control: no-store` i kopertę `{ data, meta: { requestId }, error }` (ADR-0044).
- Błędy domenowe rzucane są przez `ApiFailure(status, code, message, details)` ze stałymi kodami `ERROR_CODES` z `@hirahr/contracts` (m.in. `UNAUTHENTICATED`, `PRODUCT_ACCESS_REQUIRED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`).
- Błędy `ZodError`, `AuthError`, `PermissionError`, `CoreApiError` i `CoreMachineTokenError` są automatycznie mapowane na spójne kody HTTP i polskie komunikaty.
- Żądania mutujące z ciasteczkiem sesji (bez nagłówka `Authorization`) przechodzą kontrolę `assertSameOrigin` (CSRF).

## Trasy etapu 0

| Metoda i ścieżka     | Uwierzytelnienie            | Opis                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health` | Publiczna                   | Zwraca `{ status: "ok", version }` bez odpytywania bazy i Core.                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/v1/me`     | Sesja BFF (`sessionCookie`) | Pobiera profil osoby i firmy z Core (`GET /core/v1/me`) oraz wylicza `capabilities` (`hasProductAccess`, `readEmployees`, `updateEmployees`, `readSensitive`, `updateSensitive`, `requestLeave`, `approveLeave`, `manageLeave`, `readDocuments`, `manageDocuments`, `manageSettings`; `readSensitive` i `updateSensitive` tylko przy zakresie całej firmy) z migawki uprawnień. Wywołania z tokenem `Bearer` dostają `403 PERMISSION_DENIED`. |

Trasy logowania BFF (poza `/api/v1`, bez koperty JSON): `GET /api/auth/sign-in`, `GET /api/auth/callback`, `POST /api/auth/sign-out`.

## Trasy etapu 1: kartoteka (ADR-0104)

Listy mają stronicowanie kursorem (`limit` 1–100, `cursor` z `meta.nextCursor`). Osoba spoza zasięgu dostaje `404` (404 przed 403).

| Metoda i ścieżka                                                 | Kto                                                                       | Opis                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/people`                                             | `employees.read`                                                          | Ludzie w zasięgu: zakres firmy daje wszystkich, zakres jednostek ich członków (członkostwa z katalogu Core), `RESOURCE` pojedyncze osoby. Filtry `search` (bez polskich znaków) i `unitId`. Obecna umowa i stanowisko. Awaria Core: `503`. |
| `GET /api/v1/people/{employeeId}`                                | sama osoba albo `employees.read` w zasięgu                                | Karta: dane z Core, kartoteka, umowy bez wynagrodzeń, obecność danych wrażliwych i `access`.                                                                                                                                               |
| `PATCH /api/v1/people/{employeeId}`                              | sama osoba albo `employees.update` w zasięgu                              | Zmiana kartoteki bez danych wrażliwych (pominięte pole bez zmian, `null` czyści).                                                                                                                                                          |
| `GET /api/v1/people/{employeeId}/sensitive`                      | sama osoba albo `sensitive.read` w zakresie firmy                         | Odszyfrowany PESEL, rachunek, dokument i wynagrodzenia; odczyt trafia do dziennika.                                                                                                                                                        |
| `PUT /api/v1/people/{employeeId}/sensitive`                      | `sensitive.update` w zakresie firmy                                       | PESEL (suma kontrolna), IBAN (mod 97), dokument; zmiana trafia do dziennika.                                                                                                                                                               |
| `GET /api/v1/people/{employeeId}/sensitive-access-log`           | sama osoba albo `sensitive.read` w zakresie firmy                         | Kto i kiedy odczytał albo zmienił dane wrażliwe.                                                                                                                                                                                           |
| `POST /api/v1/people/{employeeId}/contracts`                     | `employees.update` w zasięgu (wynagrodzenie: `sensitive.update` w firmie) | Nowa umowa; reguły: data końca dla próbnej i terminowej, etat tylko w umowach o pracę.                                                                                                                                                     |
| `PATCH /api/v1/contracts/{contractId}`                           | jak wyżej                                                                 | Zmiana umowy; reguły sprawdzane po scaleniu zmian.                                                                                                                                                                                         |
| `DELETE /api/v1/contracts/{contractId}`                          | `employees.update` w zasięgu                                              | Usunięcie umowy wpisanej przez pomyłkę.                                                                                                                                                                                                    |
| `GET /api/v1/positions`                                          | dostęp do produktu                                                        | Katalog stanowisk (`includeArchived=true` także archiwalne).                                                                                                                                                                               |
| `POST /api/v1/positions`, `PATCH /api/v1/positions/{positionId}` | `settings.manage`                                                         | Nowe stanowisko, zmiana nazwy, archiwizacja; aktywna nazwa unikalna w firmie (`409`).                                                                                                                                                      |
| `GET /api/v1/units`                                              | sesja przeglądarki                                                        | Aktywne jednostki z Core (nazwy do filtrów).                                                                                                                                                                                               |

## Trasy etapu 2: urlopy i nieobecności (ADR-0104)

Dni liczone w dniach pracy (wymiar pracy z Core i polskie święta). Listy mają stronicowanie kursorem. Osoba spoza zasięgu dostaje `404`; osoba, której kartę widać, ale bez praw do urlopów, `403`.

| Metoda i ścieżka                                            | Kto                                                                                        | Opis                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/leave/requests`                                | sama osoba; z `employeeId` rozpatrujący i kadry; z `approvals=true` `leave.approve/manage` | Własne wnioski, wnioski osoby (od najnowszych) albo oczekujące do rozpatrzenia (od najbliższych, bez własnych). Zwolnienie lekarskie widzą tylko sama osoba i kadry w zakresie firmy. |
| `POST /api/v1/leave/requests`                               | `leave.request` za siebie; `leave.manage` za osobę; zwolnienie: `leave.manage` w firmie    | Wniosek „oczekuje” albo wpis kadr „zaakceptowany”. Saldo, limit 4 dni na żądanie i nakładanie się sprawdzane pod blokadą (`409`); brak salda na rok i same dni wolne: `422`.          |
| `POST /api/v1/leave/requests/{requestId}/decision`          | `leave.approve` albo `leave.manage` obejmujące osobę, nigdy własny                         | `APPROVE` albo `REJECT` z uzasadnieniem; tylko oczekujący wniosek (`409`).                                                                                                            |
| `POST /api/v1/leave/requests/{requestId}/cancel`            | sama osoba (oczekujący albo przed początkiem urlopu) albo kadry                            | Wycofanie; wpis zostaje w historii.                                                                                                                                                   |
| `GET /api/v1/leave/calendar`                                | dostęp do produktu                                                                         | Nieobecności w okresie do 62 dni (`from`, `to`, `unitId`); rodzaj i oczekujące tylko przy pełnym wglądzie, współpracownicy z jednostki widzą zaakceptowane bez rodzaju.               |
| `GET /api/v1/leave/working-days`                            | sama osoba albo kadry obejmujące osobę                                                     | Podgląd liczby dni pracy i świąt w okresie.                                                                                                                                           |
| `GET /api/v1/people/{employeeId}/leave-balance`             | sama osoba, rozpatrujący i kadry                                                           | Saldo w roku (`year`), podpowiedź wymiaru z etatu i `access` (`canRequest`, `canManage`, `canEnterSick`) dla przycisków.                                                              |
| `PUT /api/v1/people/{employeeId}/leave-entitlements/{year}` | `leave.manage` obejmujące osobę                                                            | Podstawa 20/26, wymiar na rok, urlop zaległy i uwagi.                                                                                                                                 |

## Katalog tras i OpenAPI 3.1

- Jednym źródłem prawdy dla OpenAPI jest `apps/web/src/server/routes.ts` połączony ze schematami Zod z `packages/contracts/src/index.ts`.
- `apps/web/src/server/openapi.ts` generuje deterministyczny dokument OpenAPI 3.1.0 zapisywany w `openapi/hirahr-api.json`.
- Po każdej zmianie tras albo schematów uruchom `pnpm openapi`; CI sprawdza aktualność pliku przez `pnpm openapi:check`.
- Testy w `apps/web/test/contract.test.ts` pilnują, aby `openapi/hirahr-api.json` pokrywał dokładnie wszystkie pliki `route.ts` pod `apps/web/src/app/api/v1/`, nie miał zerwanych ani nieużywanych schematów i spełniał `checkOpenApiDocument` z `@monorise-team/testing`.

## Kontrakty i klient

- `packages/contracts`: wspólne schematy Zod, `ApiErrorResponse`, `apiSuccessSchema`, `Health`, `Capabilities`, `Me` oraz `permissions.ts` (`HIRAHR_PERMISSIONS`, `HIRAHR_PERMISSION_MANIFEST`, `HIRAHR_ROLE_TEMPLATES`).
- `packages/contracts/src/people.ts`: schematy kartoteki, walidacja `isValidPesel`, `peselBirthDate`, `isValidIban`, `normalizeIban`, reguły umów `contractViolations`.
- `packages/contracts/src/leave.ts`: rodzaje i stany nieobecności, saldo, wniosek, kalendarz, zapytania i reguły (koniec po początku, urlop z puli w jednym roku, najwyżej rok w jednym wpisie, kalendarz do 62 dni).
- `packages/client`: `createClient({ baseUrl, getToken, fetch })` z metodami `session.*`, `people.*` (lista, karta, zmiana, dane wrażliwe, dziennik, nowa umowa), `contracts.*`, `positions.*`, `units.list()` i `leave.*` (wnioski, decyzja, wycofanie, kalendarz, dni pracy, saldo, ustalenie salda); listy zwracają `{ items, nextCursor }`, a błędy `ApiError`.

## Zestawy testów

Testy bez bazy danych (działają z atrapą `createFakeCore` z `@monorise-team/testing`, bez gniazd TCP):

- `packages/contracts/test/contracts.test.ts`: manifest uprawnień, gotowe role i schematy kopert.
- `packages/client/test/client.test.ts`: klient HTTP, nagłówki, ciasteczka i mapowanie `ApiError`.
- `apps/web/test/contract.test.ts`: kontrakt produktu Monorise (`defineProductContractTests`, `checkAuthentication`, `checkProductAccess`, spójność OpenAPI 3.1).
- `apps/web/test/api.test.ts`: `/health`, `/me`, `capabilities`, błędy Core, PKCE `/api/auth/sign-in`, ochrona CSRF i odświeżanie po `authz_rev`.
- `apps/web/test/permissions.test.ts`: role (`Kierownik`, `Kadry`, `Gość`, `Owner`), dane wrażliwe tylko w zakresie firmy, zakresy `ORGANIZATION`/`UNIT`/`RESOURCE`, `PRODUCT_ACCESS_REQUIRED`, pamięć podręczna i 503.
- `apps/web/test/core-machine.test.ts`, `core-registration.test.ts`, `core-resilience.test.ts`: token maszynowy, rejestracja manifestu i ról, ponawianie żądań i stronicowanie katalogu.
- `apps/web/test/event-feed.test.ts`: odbiór zdarzeń z Core, deduplikacja, kursor i konfiguracja `HIRAHR_EVENT_FEED_INTERVAL_MS`.
- `apps/web/test/hosts.test.ts`, `app-views.test.ts`: routing po hoście, parsowanie hashów i logika dostępu w powłoce.

- `apps/web/test/people-helpers.test.ts`: szyfrowanie AES-256-GCM (kontekst AAD, podmiana szyfrogramu, wymiana klucza), zasięg kartotek, wyszukiwanie.

- `apps/web/test/polish-calendar.test.ts`: święta i Wielkanoc, dni pracy z wymiaru pracy, podpowiedź wymiaru urlopu z etatu, formaty dat i dni w interfejsie.

Testy wymagające PostgreSQL: `packages/db/test/rls.test.ts` (także RLS, CHECK i dziennik tylko do dopisywania w tabelach kartoteki oraz RLS, brak `DELETE`, EXCLUDE i CHECK w tabelach urlopów), `apps/web/test/tenant-isolation.test.ts`, `apps/web/test/people-api.test.ts` (trasy kartoteki na prawdziwych handlerach i bazie z atrapą Core) oraz `apps/web/test/leave-api.test.ts` (saldo, wnioski i akceptacja, zwolnienie lekarskie, kalendarz, dni pracy z wymiaru, dwa równoczesne wnioski, rozpoznanie błędu EXCLUDE).
