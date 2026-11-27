/**
 * Typowany klient API HiraHR dla przeglądarki (sesja BFF w ciasteczku HttpOnly, ADR-0050)
 * oraz wywołań z tokenem Bearer (`getToken`).
 */
import {
  API_PREFIX,
  type ApiErrorBody,
  type ApiResponse,
  type CreateContractInput,
  type CreatePositionInput,
  type CursorQuery,
  type EmploymentContract,
  type ErrorCode,
  type Me,
  type PaginatedResult,
  type PeopleListQuery,
  type PersonCard,
  type PersonListItem,
  type Position,
  type SensitiveAccessLogEntry,
  type SensitiveData,
  type Unit,
  type UpdateContractInput,
  type UpdatePositionInput,
  type UpdateProfileInput,
  type UpdateSensitiveInput,
} from "@hirahr/contracts";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorBody["details"];

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

export interface ClientOptions {
  /** Adres serwera, np. `https://hira.monorise.studio`; pusty w przeglądarce (ten sam adres). */
  baseUrl?: string;
  /** Opcjonalny token Bearer; przeglądarka go nie używa (korzysta z ciasteczka sesji BFF). */
  getToken?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export type HiraHRClient = ReturnType<typeof createClient>;

function segment(value: string): string {
  return encodeURIComponent(value);
}

function queryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if ((typeof value === "string" && value !== "") || typeof value === "number") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function createClient({ baseUrl = "", getToken, fetch: fetchImpl = fetch }: ClientOptions = {}) {
  async function send<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = getToken ? await getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: getToken ? "omit" : "same-origin",
      });
    } catch {
      throw new ApiError(0, { code: "INTERNAL_ERROR", message: "Brak połączenia z serwerem HiraHR", details: [] });
    }
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (response.status === 204) {
      return { data: null, meta: {}, error: null };
    }
    if (!response.ok || !payload || payload.error) {
      throw new ApiError(
        response.status,
        payload?.error ?? { code: "INTERNAL_ERROR", message: `Błąd serwera (${response.status})`, details: [] },
      );
    }
    return payload;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await send<T>(method, path, body)).data as T;
  }

  async function requestPage<T>(path: string): Promise<PaginatedResult<T>> {
    const payload = await send<T[]>("GET", path);
    const nextCursor = typeof payload.meta.nextCursor === "string" ? payload.meta.nextCursor : null;
    return { items: payload.data ?? [], nextCursor };
  }

  return {
    people: {
      list: (query: PeopleListQuery = {}) => requestPage<PersonListItem>(`/people${queryString(query)}`),
      get: (employeeId: string) => request<PersonCard>("GET", `/people/${segment(employeeId)}`),
      update: (employeeId: string, input: UpdateProfileInput) =>
        request<PersonCard>("PATCH", `/people/${segment(employeeId)}`, input),
      sensitive: (employeeId: string) => request<SensitiveData>("GET", `/people/${segment(employeeId)}/sensitive`),
      updateSensitive: (employeeId: string, input: UpdateSensitiveInput) =>
        request<PersonCard>("PUT", `/people/${segment(employeeId)}/sensitive`, input),
      accessLog: (employeeId: string, query: CursorQuery = {}) =>
        requestPage<SensitiveAccessLogEntry>(
          `/people/${segment(employeeId)}/sensitive-access-log${queryString(query)}`,
        ),
      createContract: (employeeId: string, input: CreateContractInput) =>
        request<EmploymentContract>("POST", `/people/${segment(employeeId)}/contracts`, input),
    },
    contracts: {
      update: (contractId: string, input: UpdateContractInput) =>
        request<EmploymentContract>("PATCH", `/contracts/${segment(contractId)}`, input),
      delete: async (contractId: string) => {
        await send<null>("DELETE", `/contracts/${segment(contractId)}`);
      },
    },
    positions: {
      list: (options: { includeArchived?: boolean; limit?: number; cursor?: string } = {}) =>
        requestPage<Position>(
          `/positions${queryString({
            includeArchived: options.includeArchived ? "true" : undefined,
            limit: options.limit,
            cursor: options.cursor,
          })}`,
        ),
      create: (input: CreatePositionInput) => request<Position>("POST", "/positions", input),
      update: (positionId: string, input: UpdatePositionInput) =>
        request<Position>("PATCH", `/positions/${segment(positionId)}`, input),
    },
    units: {
      list: (query: CursorQuery = {}) => requestPage<Unit>(`/units${queryString(query)}`),
    },
    session: {
      me: () => request<Me>("GET", "/me"),
      /**
       * Wylogowanie w przeglądarce (BFF): serwer kończy sesję i unieważnia token w Core. Odpowiedź to
       * przekierowanie, którego nie śledzimy; potem wystarczy ponownie zapytać o `me`.
       */
      signOut: async () => {
        await fetchImpl(`${baseUrl}/api/auth/sign-out`, {
          method: "POST",
          credentials: "same-origin",
          redirect: "manual",
        });
      },
    },
  };
}

export * from "@hirahr/contracts";
