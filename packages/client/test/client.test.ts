import { describe, expect, it } from "vitest";
import { ApiError, createClient, type Me } from "../src/index.js";

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

const SAMPLE_ME: Me = {
  account: { id: "acc-1", email: "anna@acme.test" },
  employee: { id: "emp-1", firstName: "Anna", lastName: "Nowak", fullName: "Anna Nowak", jobTitle: null },
  organization: { id: "org-1", name: "Acme" },
  capabilities: {
    hasProductAccess: true,
    readEmployees: true,
    updateEmployees: true,
    readSensitive: false,
    updateSensitive: false,
    requestLeave: false,
    approveLeave: false,
    manageLeave: false,
    readDocuments: false,
    manageDocuments: false,
    manageSettings: false,
  },
};

describe("klient API HiraHR", () => {
  it("w przeglądarce dokleja /api/v1 i wysyła ciasteczko sesji bez nagłówka Authorization", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({ fetch: fakeFetch(200, { data: SAMPLE_ME, meta: {}, error: null }, seen) });
    expect(await client.session.me()).toEqual(SAMPLE_ME);
    expect(seen.url).toBe("/api/v1/me");
    expect(seen.init?.credentials).toBe("same-origin");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("przy podanym getToken wysyła nagłówek Authorization i pomija ciasteczka", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({
      baseUrl: "https://hira.monorise.studio",
      getToken: () => "tajny-token",
      fetch: fakeFetch(200, { data: SAMPLE_ME, meta: {}, error: null }, seen),
    });
    expect(await client.session.me()).toEqual(SAMPLE_ME);
    expect(seen.url).toBe("https://hira.monorise.studio/api/v1/me");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer tajny-token");
    expect(seen.init?.credentials).toBe("omit");
  });

  it("buduje adresy urlopów: wnioski do rozpatrzenia, kalendarz, saldo i decyzję", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({ fetch: fakeFetch(200, { data: [], meta: { nextCursor: null }, error: null }, seen) });
    await client.leave.requests({ approvals: true, limit: 20 });
    expect(seen.url).toBe("/api/v1/leave/requests?approvals=true&limit=20");
    await client.leave.requests();
    expect(seen.url).toBe("/api/v1/leave/requests");
    await client.leave.calendar({ from: "2026-08-01", to: "2026-08-31" });
    expect(seen.url).toBe("/api/v1/leave/calendar?from=2026-08-01&to=2026-08-31");
    await client.leave.balance("emp-1", 2026);
    expect(seen.url).toBe("/api/v1/people/emp-1/leave-balance?year=2026");
    await client.leave.decide("req-1", { decision: "APPROVE" });
    expect(seen.url).toBe("/api/v1/leave/requests/req-1/decision");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ decision: "APPROVE" }));
  });

  it("wylogowanie wysyła POST /api/auth/sign-out z ciasteczkiem i bez śledzenia przekierowań", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({
      baseUrl: "https://hirahr.monorise.studio",
      fetch: fakeFetch(302, null, seen),
    });
    await client.session.signOut();
    expect(seen.url).toBe("https://hirahr.monorise.studio/api/auth/sign-out");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.credentials).toBe("same-origin");
    expect(seen.init?.redirect).toBe("manual");
  });

  it("zamienia błąd API oraz błąd sieci na ApiError z kodem", async () => {
    const productDeniedClient = createClient({
      fetch: fakeFetch(403, {
        data: null,
        meta: { requestId: "req_123" },
        error: {
          code: "PRODUCT_ACCESS_REQUIRED",
          message: "HiraHR nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.",
          details: [],
        },
      }),
    });
    const denied = await productDeniedClient.session.me().catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied).toMatchObject({ code: "PRODUCT_ACCESS_REQUIRED", status: 403 });

    const offlineClient = createClient({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const networkError = await offlineClient.session.me().catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(ApiError);
    expect(networkError).toMatchObject({ code: "INTERNAL_ERROR", status: 0 });
  });
});
