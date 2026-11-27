/**
 * Katalog ścieżek API HiraHR (`/api/v1/*`): jedno źródło prawdy dla generatora OpenAPI 3.1
 * (`openapi.ts`) i testów zgodności z kontraktem produktu (ADR-0044, ADR-0046).
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu Node 24 uruchamia generator OpenAPI bez dodatkowego kompilatora.
 */
import {
  API_PREFIX,
  CalendarAbsence,
  CreateContractInput,
  CreateLeaveRequestInput,
  DecideLeaveRequestInput,
  LeaveBalance,
  LeaveRequest,
  LeaveStatus,
  UpdateLeaveEntitlementInput,
  WorkingDays,
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

export type RouteTag = "System" | "Session" | "People" | "Contracts" | "Positions" | "Units" | "Leave";

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
  {
    name: "Leave",
    description:
      "Urlopy i nieobecności (etap 2, ADR-0104): roczne salda, wnioski z akceptacją kierownika, wpisy kadr " +
      "i kalendarz zespołu. Dni liczone w dniach pracy według wymiaru pracy z MonoriseCore i polskich świąt.",
  },
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
const REQUEST_ID: ParameterDefinition = {
  name: "requestId",
  in: "path",
  required: true,
  description: "Identyfikator wniosku urlopowego.",
  schema: UUID,
};
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PAGE_PARAMETERS: readonly ParameterDefinition[] = [
  {
    name: "limit",
    in: "query",
    required: false,
    description: "Liczba pozycji na stronie (1–100, domyślnie 50).",
    schema: LIMIT,
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    description: "Kursor następnej strony z `meta.nextCursor`.",
    schema: CURSOR,
  },
];
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
  listLeaveRequests: {
    method: "GET",
    path: `${API_PREFIX}/leave/requests`,
    operationId: "listLeaveRequests",
    tag: "Leave",
    summary: "Wnioski urlopowe",
    description:
      "Bez parametrów własne wnioski (samoobsługa, bez ról). `employeeId`: wnioski osoby dla rozpatrujących " +
      "(`hirahr.leave.approve`) i kadr (`hirahr.leave.manage`) obejmujących osobę. `approvals=true`: oczekujące " +
      "wnioski, które zalogowana osoba może rozpatrzyć (bez własnych). Zwolnienie lekarskie widzą tylko sama osoba " +
      "i kadry w zakresie firmy.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      { name: "employeeId", in: "query", required: false, description: "Wnioski tej osoby.", schema: UUID },
      {
        name: "approvals",
        in: "query",
        required: false,
        description: "`true`: oczekujące wnioski do rozpatrzenia.",
        schema: z.enum(["true", "false"]),
      },
      { name: "status", in: "query", required: false, description: "Tylko wnioski w tym stanie.", schema: LeaveStatus },
      ...PAGE_PARAMETERS,
    ],
    dataSchemaName: "LeaveRequestList",
    dataSchema: z.array(LeaveRequest),
    responseSchemaName: "LeaveRequestListResponse",
    responseDescription: "Strona wniosków: osoby od najnowszych, do rozpatrzenia od najbliższych.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  createLeaveRequest: {
    method: "POST",
    path: `${API_PREFIX}/leave/requests`,
    operationId: "createLeaveRequest",
    tag: "Leave",
    summary: "Nowy wniosek albo wpis nieobecności",
    description:
      "Za siebie: `hirahr.leave.request`, wniosek czeka na akceptację. Za inną osobę: `hirahr.leave.manage` " +
      "obejmujące osobę, wpis od razu zaakceptowany. Zwolnienie lekarskie wpisują tylko kadry w zakresie firmy. " +
      "Urlop wypoczynkowy i na żądanie wymagają salda na dany rok; na żądanie najwyżej 4 dni w roku. " +
      "Nakładanie się z inną aktywną nieobecnością albo brak dni w saldzie daje `409`.",
    auth: "user",
    successStatus: 201,
    envelope: true,
    requestBodySchemaName: "CreateLeaveRequestInput",
    requestBodySchema: CreateLeaveRequestInput,
    dataSchemaName: "LeaveRequest",
    dataSchema: LeaveRequest,
    responseSchemaName: "LeaveRequestResponse",
    responseDescription: "Utworzony wniosek z liczbą dni pracy.",
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
  decideLeaveRequest: {
    method: "POST",
    path: `${API_PREFIX}/leave/requests/{requestId}/decision`,
    operationId: "decideLeaveRequest",
    tag: "Leave",
    summary: "Akceptacja albo odrzucenie wniosku",
    description:
      "`hirahr.leave.approve` albo `hirahr.leave.manage` obejmujące osobę; nigdy własnego wniosku. " +
      "Tylko oczekujący wniosek (inaczej `409`).",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [REQUEST_ID],
    requestBodySchemaName: "DecideLeaveRequestInput",
    requestBodySchema: DecideLeaveRequestInput,
    dataSchemaName: "LeaveRequest",
    dataSchema: LeaveRequest,
    responseSchemaName: "LeaveRequestResponse",
    responseDescription: "Wniosek po decyzji.",
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
  cancelLeaveRequest: {
    method: "POST",
    path: `${API_PREFIX}/leave/requests/{requestId}/cancel`,
    operationId: "cancelLeaveRequest",
    tag: "Leave",
    summary: "Wycofanie wniosku albo wpisu",
    description:
      "Oczekujący wniosek wycofuje sama osoba albo kadry; zaakceptowany sama osoba przed jego początkiem, " +
      "a kadry zawsze. Wpis zostaje w historii jako wycofany.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [REQUEST_ID],
    dataSchemaName: "LeaveRequest",
    dataSchema: LeaveRequest,
    responseSchemaName: "LeaveRequestResponse",
    responseDescription: "Wniosek po wycofaniu.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 409: CONFLICT, 500: INTERNAL, 503: INTERNAL },
  },
  getLeaveCalendar: {
    method: "GET",
    path: `${API_PREFIX}/leave/calendar`,
    operationId: "getLeaveCalendar",
    tag: "Leave",
    summary: "Kalendarz nieobecności zespołu",
    description:
      "Nieobecności w okresie do 62 dni. Rodzaj i oczekujące wnioski widzą sama osoba, rozpatrujący i kadry; " +
      "osoby z tych samych jednostek i z `hirahr.employees.read` widzą tylko zaakceptowane nieobecności bez rodzaju.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      { name: "from", in: "query", required: true, description: "Pierwszy dzień (RRRR-MM-DD).", schema: ISO_DATE },
      { name: "to", in: "query", required: true, description: "Ostatni dzień (RRRR-MM-DD).", schema: ISO_DATE },
      { name: "unitId", in: "query", required: false, description: "Tylko członkowie tej jednostki.", schema: UUID },
      ...PAGE_PARAMETERS,
    ],
    dataSchemaName: "CalendarAbsenceList",
    dataSchema: z.array(CalendarAbsence),
    responseSchemaName: "CalendarAbsenceListResponse",
    responseDescription: "Strona nieobecności według daty początku.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  getWorkingDays: {
    method: "GET",
    path: `${API_PREFIX}/leave/working-days`,
    operationId: "getWorkingDays",
    tag: "Leave",
    summary: "Liczba dni pracy w okresie",
    description:
      "Podgląd przed złożeniem wniosku: dni z wymiarem pracy w MonoriseCore (domyślnie poniedziałek–piątek) " +
      "bez polskich dni ustawowo wolnych. Za inną osobę tylko kadry.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [
      { name: "from", in: "query", required: true, description: "Pierwszy dzień (RRRR-MM-DD).", schema: ISO_DATE },
      { name: "to", in: "query", required: true, description: "Ostatni dzień (RRRR-MM-DD).", schema: ISO_DATE },
      { name: "employeeId", in: "query", required: false, description: "Domyślnie zalogowana osoba.", schema: UUID },
    ],
    dataSchemaName: "WorkingDays",
    dataSchema: WorkingDays,
    responseSchemaName: "WorkingDaysResponse",
    responseDescription: "Liczba dni pracy i święta w okresie.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  getLeaveBalance: {
    method: "GET",
    path: `${API_PREFIX}/people/{employeeId}/leave-balance`,
    operationId: "getLeaveBalance",
    tag: "Leave",
    summary: "Saldo urlopu osoby w roku",
    description:
      "Wymiar, urlop zaległy, wykorzystane i zaplanowane dni oraz urlop na żądanie. Sama osoba, rozpatrujący " +
      "i kadry obejmujący osobę.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [
      EMPLOYEE_ID,
      {
        name: "year",
        in: "query",
        required: false,
        description: "Rok (domyślnie bieżący w Polsce).",
        schema: z.number().int().min(2000).max(2100),
      },
    ],
    dataSchemaName: "LeaveBalance",
    dataSchema: LeaveBalance,
    responseSchemaName: "LeaveBalanceResponse",
    responseDescription: "Saldo urlopu.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
  updateLeaveEntitlement: {
    method: "PUT",
    path: `${API_PREFIX}/people/{employeeId}/leave-entitlements/{year}`,
    operationId: "updateLeaveEntitlement",
    tag: "Leave",
    summary: "Ustalenie salda urlopu na rok",
    description:
      "Kadry (`hirahr.leave.manage` obejmujące osobę): podstawa 20 albo 26 dni, wymiar po uwzględnieniu etatu " +
      "i urlop zaległy z poprzedniego roku.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [
      EMPLOYEE_ID,
      {
        name: "year",
        in: "path",
        required: true,
        description: "Rok salda (2000–2100).",
        schema: z.number().int().min(2000).max(2100),
      },
    ],
    requestBodySchemaName: "UpdateLeaveEntitlementInput",
    requestBodySchema: UpdateLeaveEntitlementInput,
    dataSchemaName: "LeaveBalance",
    dataSchema: LeaveBalance,
    responseSchemaName: "LeaveBalanceResponse",
    responseDescription: "Saldo po zmianie.",
    errors: { 401: AUTH_401, 403: ACCESS_403, 404: NOT_FOUND, 422: VALIDATION, 500: INTERNAL, 503: INTERNAL },
  },
} as const satisfies Record<string, RouteDefinition>;

export const ROUTE_LIST: readonly RouteDefinition[] = Object.values(ROUTES);
