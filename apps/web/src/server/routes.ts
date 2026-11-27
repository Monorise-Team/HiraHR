/**
 * Katalog ścieżek API HiraHR (`/api/v1/*`): jedno źródło prawdy dla generatora OpenAPI 3.1
 * (`openapi.ts`) i testów zgodności z kontraktem produktu (ADR-0044, ADR-0046).
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu Node 24 uruchamia generator OpenAPI bez dodatkowego kompilatora.
 */
import {
  API_PREFIX,
  CreateContractInput,
  CreatePositionInput,
  EmploymentContract,
  Health,
  Me,
  PersonCard,
  PersonListItem,
  Position,
  SensitiveAccessLogEntry,
  SensitiveData,
  Unit,
  UpdateContractInput,
  UpdatePositionInput,
  UpdateProfileInput,
  UpdateSensitiveInput,
  type ErrorCode,
} from "@hirahr/contracts";
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteTag = "System" | "Session" | "People" | "Contracts" | "Positions" | "Units";

/**
 * Wymagane uwierzytelnienie trasy:
 * - `false`: publiczna (bez tokenu i bez sesji),
 * - `"session"`: wyłącznie sesja BFF przeglądarki w ciasteczku `HttpOnly`,
 * - `"user"`: token użytkownika `Bearer` albo sesja BFF przeglądarki.
 */
export type RouteAuth = false | "session" | "user";

export interface TagDefinition {
  name: RouteTag;
  description: string;
}

export const TAGS: readonly TagDefinition[] = [
  { name: "System", description: "Stan usługi HiraHR." },
  { name: "Session", description: "Dane zalogowanej osoby, firmy i możliwości widoczne w przeglądarce (BFF)." },
  {
    name: "People",
    description:
      "Kartoteka pracowników (etap 1, ADR-0104): lista ludzi w zasięgu uprawnień, karta osoby, dane wrażliwe z dziennikiem dostępu.",
  },
  { name: "Contracts", description: "Umowy pracowników z historią; wynagrodzenie jest daną wrażliwą." },
  { name: "Positions", description: "Katalog stanowisk firmy." },
  { name: "Units", description: "Jednostki struktury firmy z MonoriseCore (nazwy do filtrów)." },
];

export type SuccessStatus = 200 | 201 | 204;
export type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
export type RouteErrors = Partial<Record<ErrorStatus, readonly ErrorCode[]>>;

export interface ParameterDefinition {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: z.ZodType;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Ścieżka w formacie OpenAPI (np. `/api/v1/me`). */
  path: string;
  operationId: string;
  tag: RouteTag;
  summary: string;
  description?: string;
  auth: RouteAuth;
  /** Kod odpowiedzi sukcesu. */
  successStatus: SuccessStatus;
  /** Czy odpowiedź sukcesu jest owinięta w kopertę `{ data, meta, error }` (nie dotyczy 204). */
  envelope: boolean;
  /** Lista ze stronicowaniem kursorowym (`meta.nextCursor`). */
  paginated?: boolean;
  /** Parametry ścieżki (`path`) i zapytania (`query`). */
  parameters?: readonly ParameterDefinition[];
  /** Nazwa i schemat treści żądania (dla POST/PUT/PATCH). */
  requestBodySchemaName?: string;
  requestBodySchema?: z.ZodType;
  requestBodyRequired?: boolean;
  requestBodyDescription?: string;
  /** Nazwa schematu danych w `components/schemas` (brak przy 204). */
  dataSchemaName?: string;
  dataSchema?: z.ZodType;
  /** Nazwa schematu odpowiedzi w `components/schemas` dla odpowiedzi z kopertą (np. `MeResponse`). */
  responseSchemaName?: string;
  responseDescription: string;
  errors: RouteErrors;
}

const UUID = z.string().uuid();
const LIMIT = z.number().int().min(1).max(100);
const CURSOR = z.string().min(1).max(256);
const EMPLOYEE_ID: ParameterDefinition = {
  name: "employeeId",
  in: "path",
  required: true,
  description: "Identyfikator pracownika w MonoriseCore.",
  schema: UUID,
};
const CONTRACT_ID: ParameterDefinition = {
  name: "contractId",
  in: "path",
  required: true,
  description: "Identyfikator umowy.",
  schema: UUID,
};
const AUTH_401 = ["UNAUTHENTICATED"] as const;
const ACCESS_403 = ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"] as const;
const NOT_FOUND = ["NOT_FOUND"] as const;
const VALIDATION = ["VALIDATION_FAILED"] as const;
const CONFLICT = ["CONFLICT"] as const;
const INTERNAL = ["INTERNAL_ERROR"] as const;

export const ROUTES = {
  getHealth: {
    method: "GET",
    path: `${API_PREFIX}/health`,
    operationId: "getHealth",
    tag: "System",
    summary: "Stan usługi HiraHR",
    description: "Publiczna kontrola zdrowia serwera API bez sprawdzania bazy danych i MonoriseCore.",
    auth: false,
    successStatus: 200,
    envelope: true,
    dataSchemaName: "Health",
    dataSchema: Health,
    responseSchemaName: "HealthResponse",
    responseDescription: "Usługa działa.",
    errors: {
      500: ["INTERNAL_ERROR"],
    },
  },
  getMe: {
    method: "GET",
    path: `${API_PREFIX}/me`,
    operationId: "getMe",
    tag: "Session",
    summary: "Zalogowana osoba, firma i możliwości w HiraHR",
    description:
      "Zwraca profil osoby i firmy pobrany z MonoriseCore (`GET /core/v1/me`) oraz pole `capabilities` wyliczone " +
      "z migawki uprawnień produktu `hirahr`. Dostępne wyłącznie przez sesję BFF przeglądarki (ciasteczko); " +
      "wywołania z tokenem Bearer otrzymują `403 PERMISSION_DENIED`, bo profil osoby i firmy pobierają bezpośrednio z Core API.",
    auth: "session",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "Me",
    dataSchema: Me,
    responseSchemaName: "MeResponse",
    responseDescription: "Profil zalogowanej osoby, firma i możliwości w interfejsie.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PERMISSION_DENIED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },

  listPeople: {
    method: "GET",
    path: `${API_PREFIX}/people`,
    operationId: "listPeople",
    tag: "People",
    summary: "Ludzie w zasięgu uprawnień",
    description:
      "Wymaga `hirahr.employees.read`: zakres całej firmy daje wszystkich, zakres jednostek tylko ich członków " +
      "(członkostwa z katalogu MonoriseCore). Zawiera obecną umowę i stanowisko. Przy awarii Core `503`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      {
        name: "search",
        in: "query",
        required: false,
        description: "Szukaj po imieniu i nazwisku (bez polskich znaków też).",
        schema: z.string().max(120),
      },
      { name: "unitId", in: "query", required: false, description: "Tylko członkowie tej jednostki.", schema: UUID },
      {
        name: "limit",
        in: "query",
        required: false,
        description: "Liczba osób na stronie (1–100, domyślnie 50).",
        schema: LIMIT,
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "Kursor następnej strony z `meta.nextCursor`.",
        schema: CURSOR,
      },
    ],
    dataSchemaName: "PersonList",
    dataSchema: z.array(PersonListItem),
    responseSchemaName: "PersonListResponse",
    responseDescription: "Strona listy ludzi.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  getPerson: {
    method: "GET",
    path: `${API_PREFIX}/people/{employeeId}`,
    operationId: "getPerson",
    tag: "People",
    summary: "Karta osoby",
    description:
      "Dane z Core, kartoteka, umowy (bez wynagrodzeń) i informacja, które dane wrażliwe są wpisane. Sama osoba " +
      "widzi zawsze swoją kartę; inni potrzebują `hirahr.employees.read` obejmującego osobę, w przeciwnym razie `404`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [EMPLOYEE_ID],
    dataSchemaName: "PersonCard",
    dataSchema: PersonCard,
    responseSchemaName: "PersonCardResponse",
    responseDescription: "Karta osoby.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  updatePerson: {
    method: "PATCH",
    path: `${API_PREFIX}/people/{employeeId}`,
    operationId: "updatePerson",
    tag: "People",
    summary: "Zmiana kartoteki (bez danych wrażliwych)",
    description:
      "Sama osoba może zmienić swoją kartotekę (samoobsługa); inni potrzebują `hirahr.employees.update` obejmującego osobę. " +
      "Pominięte pole zostaje bez zmian, `null` czyści wartość.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [EMPLOYEE_ID],
    requestBodySchemaName: "UpdateProfileInput",
    requestBodySchema: UpdateProfileInput,
    dataSchemaName: "PersonCard",
    dataSchema: PersonCard,
    responseSchemaName: "PersonCardResponse",
    responseDescription: "Karta osoby po zmianie.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  getSensitiveData: {
    method: "GET",
    path: `${API_PREFIX}/people/{employeeId}/sensitive`,
    operationId: "getSensitiveData",
    tag: "People",
    summary: "Dane wrażliwe osoby (odczyt zapisany w dzienniku)",
    description:
      "PESEL, rachunek, numer dokumentu i wynagrodzenia z umów. Sama osoba albo `hirahr.sensitive.read` " +
      "w zakresie całej firmy (zakres jednostek nie wystarcza). Każdy odczyt trafia do dziennika.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [EMPLOYEE_ID],
    dataSchemaName: "SensitiveData",
    dataSchema: SensitiveData,
    responseSchemaName: "SensitiveDataResponse",
    responseDescription: "Odszyfrowane dane wrażliwe.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  updateSensitiveData: {
    method: "PUT",
    path: `${API_PREFIX}/people/{employeeId}/sensitive`,
    operationId: "updateSensitiveData",
    tag: "People",
    summary: "Zmiana danych wrażliwych (zapisana w dzienniku)",
    description:
      "PESEL (z sumą kontrolną), rachunek IBAN i numer dokumentu. Tylko `hirahr.sensitive.update` w zakresie " +
      "całej firmy. Wartości są szyfrowane AES-256-GCM; zmiana trafia do dziennika bez samych wartości.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [EMPLOYEE_ID],
    requestBodySchemaName: "UpdateSensitiveInput",
    requestBodySchema: UpdateSensitiveInput,
    dataSchemaName: "PersonCard",
    dataSchema: PersonCard,
    responseSchemaName: "PersonCardResponse",
    responseDescription: "Karta osoby po zmianie.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  listSensitiveAccessLog: {
    method: "GET",
    path: `${API_PREFIX}/people/{employeeId}/sensitive-access-log`,
    operationId: "listSensitiveAccessLog",
    tag: "People",
    summary: "Dziennik dostępu do danych wrażliwych osoby",
    description:
      "Kto i kiedy odczytał albo zmienił dane wrażliwe. Sama osoba albo `hirahr.sensitive.read` w zakresie firmy.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      EMPLOYEE_ID,
      {
        name: "limit",
        in: "query",
        required: false,
        description: "Liczba wpisów na stronie (1–100, domyślnie 50).",
        schema: LIMIT,
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "Kursor następnej strony z `meta.nextCursor`.",
        schema: CURSOR,
      },
    ],
    dataSchemaName: "SensitiveAccessLogList",
    dataSchema: z.array(SensitiveAccessLogEntry),
    responseSchemaName: "SensitiveAccessLogListResponse",
    responseDescription: "Strona dziennika, od najnowszych.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  createContract: {
    method: "POST",
    path: `${API_PREFIX}/people/{employeeId}/contracts`,
    operationId: "createContract",
    tag: "Contracts",
    summary: "Nowa umowa osoby",
    description:
      "Wymaga `hirahr.employees.update` obejmującego osobę; wynagrodzenie dodatkowo `hirahr.sensitive.update` w zakresie firmy.",
    auth: "user",
    successStatus: 201,
    envelope: true,
    parameters: [EMPLOYEE_ID],
    requestBodySchemaName: "CreateContractInput",
    requestBodySchema: CreateContractInput,
    dataSchemaName: "EmploymentContract",
    dataSchema: EmploymentContract,
    responseSchemaName: "EmploymentContractResponse",
    responseDescription: "Utworzona umowa (bez wynagrodzenia).",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  updateContract: {
    method: "PATCH",
    path: `${API_PREFIX}/contracts/{contractId}`,
    operationId: "updateContract",
    tag: "Contracts",
    summary: "Zmiana umowy",
    description: "Reguły (data końca, wymiar etatu) sprawdzane na umowie po zmianie. Wynagrodzenie jak przy tworzeniu.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [CONTRACT_ID],
    requestBodySchemaName: "UpdateContractInput",
    requestBodySchema: UpdateContractInput,
    dataSchemaName: "EmploymentContract",
    dataSchema: EmploymentContract,
    responseSchemaName: "EmploymentContractResponse",
    responseDescription: "Umowa po zmianie.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  deleteContract: {
    method: "DELETE",
    path: `${API_PREFIX}/contracts/{contractId}`,
    operationId: "deleteContract",
    tag: "Contracts",
    summary: "Usunięcie umowy wpisanej przez pomyłkę",
    auth: "user",
    successStatus: 204,
    envelope: false,
    parameters: [CONTRACT_ID],
    responseDescription: "Umowa usunięta.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  listPositions: {
    method: "GET",
    path: `${API_PREFIX}/positions`,
    operationId: "listPositions",
    tag: "Positions",
    summary: "Katalog stanowisk firmy",
    auth: "user",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      {
        name: "includeArchived",
        in: "query",
        required: false,
        description: "Także zarchiwizowane (`true`).",
        schema: z.enum(["true", "false"]),
      },
      {
        name: "limit",
        in: "query",
        required: false,
        description: "Liczba na stronie (1–100, domyślnie 50).",
        schema: LIMIT,
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "Kursor następnej strony z `meta.nextCursor`.",
        schema: CURSOR,
      },
    ],
    dataSchemaName: "PositionList",
    dataSchema: z.array(Position),
    responseSchemaName: "PositionListResponse",
    responseDescription: "Stanowiska według nazwy.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  createPosition: {
    method: "POST",
    path: `${API_PREFIX}/positions`,
    operationId: "createPosition",
    tag: "Positions",
    summary: "Nowe stanowisko",
    description: "Wymaga `hirahr.settings.manage`. Nazwa aktywnego stanowiska jest unikalna w firmie (`409`).",
    auth: "user",
    successStatus: 201,
    envelope: true,
    requestBodySchemaName: "CreatePositionInput",
    requestBodySchema: CreatePositionInput,
    dataSchemaName: "Position",
    dataSchema: Position,
    responseSchemaName: "PositionResponse",
    responseDescription: "Utworzone stanowisko.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 409: CONFLICT, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  updatePosition: {
    method: "PATCH",
    path: `${API_PREFIX}/positions/{positionId}`,
    operationId: "updatePosition",
    tag: "Positions",
    summary: "Zmiana albo archiwizacja stanowiska",
    description: "Wymaga `hirahr.settings.manage`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [
      { name: "positionId", in: "path", required: true, description: "Identyfikator stanowiska.", schema: UUID },
    ],
    requestBodySchemaName: "UpdatePositionInput",
    requestBodySchema: UpdatePositionInput,
    dataSchemaName: "Position",
    dataSchema: Position,
    responseSchemaName: "PositionResponse",
    responseDescription: "Stanowisko po zmianie.",
    errors: {
      401: AUTH_401,
      403: ACCESS_403,
      404: NOT_FOUND,
      409: CONFLICT,
      422: VALIDATION,
      500: INTERNAL,
      503: INTERNAL,
    },
  },
  listUnits: {
    method: "GET",
    path: `${API_PREFIX}/units`,
    operationId: "listUnits",
    tag: "Units",
    summary: "Aktywne jednostki firmy",
    description: "Nazwy jednostek z MonoriseCore w imieniu zalogowanej osoby; tylko sesja przeglądarki.",
    auth: "session",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      {
        name: "limit",
        in: "query",
        required: false,
        description: "Liczba na stronie (1–100, domyślnie 50).",
        schema: LIMIT,
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "Kursor następnej strony z `meta.nextCursor`.",
        schema: CURSOR,
      },
    ],
    dataSchemaName: "UnitList",
    dataSchema: z.array(Unit),
    responseSchemaName: "UnitListResponse",
    responseDescription: "Jednostki według nazwy.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 500: INTERNAL, 503: INTERNAL },
  },
} as const satisfies Record<string, RouteDefinition>;

export const ROUTE_LIST: readonly RouteDefinition[] = Object.values(ROUTES);
