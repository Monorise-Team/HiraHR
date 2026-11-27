/**
 * Testy tras urlopów HiraHR (etap 2, ADR-0104) na prawdziwych handlerach Next.js, prawdziwym PostgreSQL z RLS
 * i atrapie `createFakeCore` (katalog pracowników, członkostwa w jednostkach i wymiar pracy).
 *
 * Firma Acme: Oddział Kraków > Magazyn oraz Finanse.
 * - Ewa: Kadry w zakresie całej firmy (także zwolnienia lekarskie),
 * - Kasia: Kadry w zakresie oddziału Kraków,
 * - Jan: Kierownik w Magazynie (akceptuje wnioski),
 * - Anna (Magazyn): Pracownik (składa własne wnioski),
 * - Piotr (Finanse): bez ról, tylko samoobsługa (bez składania wniosków).
 *
 * Daty są w 2098 roku, żeby wnioski były zawsze w przyszłości niezależnie od dnia uruchomienia testów.
 */
import {
  createFakeCore,
  type CreatedEmployeeWithAccount,
  type FakeCore,
  type FakeOrganizationBuilder,
} from "@monorise-team/testing";
import { HIRAHR_PERMISSIONS } from "@hirahr/contracts";
import { uuidv7, withUser } from "@hirahr/db";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as calendarRoute from "@/app/api/v1/leave/calendar/route";
import * as cancelRoute from "@/app/api/v1/leave/requests/[requestId]/cancel/route";
import * as decisionRoute from "@/app/api/v1/leave/requests/[requestId]/decision/route";
import * as requestsRoute from "@/app/api/v1/leave/requests/route";
import * as workingDaysRoute from "@/app/api/v1/leave/working-days/route";
import * as contractsRoute from "@/app/api/v1/people/[employeeId]/contracts/route";
import * as balanceRoute from "@/app/api/v1/people/[employeeId]/leave-balance/route";
import * as entitlementRoute from "@/app/api/v1/people/[employeeId]/leave-entitlements/[year]/route";
import { resetMachineCoreTokenCache, setCoreRetryForTests } from "@/server/core";
import { invalidateDirectoryCache } from "@/server/core-directory";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { getDb } from "@/server/db";
import { generateKeyEntry } from "@/server/field-encryption";
import { isOverlapViolation } from "@/server/leave-service";
import { invalidatePermissionCache } from "@/server/permissions";
import { createFakeCoreWithUnitsFetch } from "./helpers/fake-core-units";

const API = "http://hira.localhost:3600";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.leave.test";
const CLIENT_ID = "hirahr-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const YEAR = 2098;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- w testach czytamy kopertę JSON swobodnie
type TestEnvelope = { data: any; meta: any; error: any };

function call<P>(
  handler: (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
  params = {} as P,
) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { host: "hira.localhost:3600" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const request = new NextRequest(`${BASE}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return handler(request, { params: Promise.resolve(params) }).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as TestEnvelope,
  }));
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let magazynId: string;
let finanseId: string;
let ewa: CreatedEmployeeWithAccount;
let kasia: CreatedEmployeeWithAccount;
let jan: CreatedEmployeeWithAccount;
let anna: CreatedEmployeeWithAccount;
let piotr: CreatedEmployeeWithAccount;
/** Wymiar pracy z Core dopisywany do odpowiedzi katalogu (atrapa go nie zwraca). */
const schedules = new Map<string, Record<string, number>>();

function withSchedules(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/directory/employees") || !response.ok) return response;
    const body = (await response.json()) as { data: { id: string }[] };
    body.data = body.data.map((employee) => ({
      ...employee,
      effectiveWorkSchedule: schedules.get(employee.id) ?? null,
    }));
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function tokenFor(employee: CreatedEmployeeWithAccount) {
  return acme.signUserToken(employee.accountId, { audience: API });
}

async function setEntitlement(employee: CreatedEmployeeWithAccount, entitledDays: number, year = YEAR) {
  const response = await call(
    entitlementRoute.PUT,
    `/people/${employee.employeeId}/leave-entitlements/${year}`,
    { method: "PUT", token: await tokenFor(ewa), body: { baseDays: 26, entitledDays } },
    { employeeId: employee.employeeId, year: String(year) },
  );
  expect(response.status).toBe(200);
  return response.body.data;
}

async function createRequest(
  employee: CreatedEmployeeWithAccount,
  body: { type: string; startDate: string; endDate: string; employeeId?: string; note?: string },
) {
  return call(requestsRoute.POST, "/leave/requests", { method: "POST", token: await tokenFor(employee), body });
}

async function decide(
  employee: CreatedEmployeeWithAccount,
  requestId: string,
  decision: "APPROVE" | "REJECT",
  note?: string,
) {
  return call(
    decisionRoute.POST,
    `/leave/requests/${requestId}/decision`,
    { method: "POST", token: await tokenFor(employee), body: { decision, ...(note ? { note } : {}) } },
    { requestId },
  );
}

async function cancel(employee: CreatedEmployeeWithAccount, requestId: string) {
  return call(
    cancelRoute.POST,
    `/leave/requests/${requestId}/cancel`,
    { method: "POST", token: await tokenFor(employee) },
    { requestId },
  );
}

async function balanceOf(viewer: CreatedEmployeeWithAccount, employee: CreatedEmployeeWithAccount, year = YEAR) {
  return call(
    balanceRoute.GET,
    `/people/${employee.employeeId}/leave-balance?year=${year}`,
    { token: await tokenFor(viewer) },
    { employeeId: employee.employeeId },
  );
}

async function calendarFor(viewer: CreatedEmployeeWithAccount, from: string, to: string, extra = "") {
  return call(calendarRoute.GET, `/leave/calendar?from=${from}&to=${to}${extra}`, { token: await tokenFor(viewer) });
}

beforeAll(async () => {
  fakeCore = await createFakeCore({
    issuer: FAKE_CORE_URL,
    coreApiUrl: FAKE_CORE_URL,
    products: [
      {
        key: "hirahr",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        scopes: [
          CORE_PERMISSIONS_REGISTER_SCOPE,
          CORE_PERMISSIONS_READ_SCOPE,
          CORE_DIRECTORY_READ_SCOPE,
          CORE_EVENTS_READ_SCOPE,
        ],
      },
    ],
  });
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  process.env.HIRAHR_FIELD_ENCRYPTION_KEYS = generateKeyEntry("test1");
  delete process.env.HIRAHR_CORE_JWKS;
});

beforeEach(() => {
  fakeCore.reset();
  schedules.clear();
  setCoreRetryForTests(false);
  invalidatePermissionCache();
  invalidateDirectoryCache();
  resetMachineCoreTokenCache();

  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("hirahr");
  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  const magazyn = acme.addUnit({ name: "Magazyn", type: "TEAM", parentId: krakow.id });
  const finanse = acme.addUnit({ name: "Finanse", type: "TEAM" });
  magazynId = magazyn.id;
  finanseId = finanse.id;

  const keys = HIRAHR_PERMISSIONS.keys;
  const hrRole = acme.addRole({ name: "Kadry", product: "hirahr", permissions: Object.values(keys) }).id;
  const managerRole = acme.addRole({
    name: "Kierownik",
    product: "hirahr",
    permissions: [keys["employees.read"], keys["leave.request"], keys["leave.approve"]],
  }).id;
  const employeeRole = acme.addRole({ name: "Pracownik", product: "hirahr", permissions: [keys["leave.request"]] }).id;

  ewa = acme.addEmployee({ firstName: "Ewa", lastName: "Kadrowa", products: ["hirahr"] });
  kasia = acme.addEmployee({ firstName: "Kasia", lastName: "Oddziałowa", products: ["hirahr"], unitIds: [krakow.id] });
  jan = acme.addEmployee({ firstName: "Jan", lastName: "Kierownik", products: ["hirahr"], unitIds: [magazynId] });
  anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["hirahr"], unitIds: [magazynId] });
  piotr = acme.addEmployee({ firstName: "Piotr", lastName: "Żółkiewski", products: ["hirahr"], unitIds: [finanseId] });

  acme.assignRole({ accountId: ewa.accountId, roleId: hrRole, scope: { type: "ORGANIZATION" } });
  acme.assignRole({ accountId: kasia.accountId, roleId: hrRole, scope: { type: "UNIT", unitId: krakow.id } });
  acme.assignRole({ accountId: jan.accountId, roleId: managerRole, scope: { type: "UNIT", unitId: magazynId } });
  acme.assignRole({ accountId: anna.accountId, roleId: employeeRole, scope: { type: "ORGANIZATION" } });

  vi.spyOn(globalThis, "fetch").mockImplementation(withSchedules(createFakeCoreWithUnitsFetch(fakeCore)));
});

afterEach(() => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

describe("saldo urlopu", () => {
  it("kadry ustalają saldo z podpowiedzią z etatu; widzi je sama osoba i jej kierownik, a nie osoba spoza zasięgu", async () => {
    const before = await balanceOf(anna, anna);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ configured: false, remainingDays: 0, onDemandLimit: 4 });

    const contract = await call(
      contractsRoute.POST,
      `/people/${anna.employeeId}/contracts`,
      { method: "POST", token: await tokenFor(ewa), body: { type: "INDEFINITE", startDate: "2026-01-01", fte: "1/2" } },
      { employeeId: anna.employeeId },
    );
    expect(contract.status).toBe(201);

    const put = await call(
      entitlementRoute.PUT,
      `/people/${anna.employeeId}/leave-entitlements/${YEAR}`,
      {
        method: "PUT",
        token: await tokenFor(ewa),
        body: { baseDays: 26, entitledDays: 13, carriedOverDays: 2, notes: "Zaległy urlop z poprzedniego roku" },
      },
      { employeeId: anna.employeeId, year: String(YEAR) },
    );
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({
      configured: true,
      baseDays: 26,
      suggestedEntitledDays: 13,
      currentContractFte: "1/2",
      entitledDays: 13,
      carriedOverDays: 2,
      remainingDays: 15,
      notes: "Zaległy urlop z poprzedniego roku",
    });

    expect((await balanceOf(jan, anna)).body.data.remainingDays).toBe(15);
    expect((await balanceOf(piotr, anna)).status).toBe(404);

    for (const editor of [jan, anna]) {
      const denied = await call(
        entitlementRoute.PUT,
        `/people/${anna.employeeId}/leave-entitlements/${YEAR}`,
        { method: "PUT", token: await tokenFor(editor), body: { entitledDays: 26 } },
        { employeeId: anna.employeeId, year: String(YEAR) },
      );
      expect(denied.status).toBe(403);
    }
    // Kadry oddziału obejmują Magazyn (poddrzewo jednostki)
    const branch = await call(
      entitlementRoute.PUT,
      `/people/${anna.employeeId}/leave-entitlements/${YEAR}`,
      { method: "PUT", token: await tokenFor(kasia), body: { entitledDays: 26 } },
      { employeeId: anna.employeeId, year: String(YEAR) },
    );
    expect(branch.status).toBe(200);
    expect(branch.body.data).toMatchObject({ entitledDays: 26, carriedOverDays: 0, baseDays: 26 });

    const badYear = await call(
      entitlementRoute.PUT,
      `/people/${anna.employeeId}/leave-entitlements/1999`,
      { method: "PUT", token: await tokenFor(ewa), body: { entitledDays: 26 } },
      { employeeId: anna.employeeId, year: "1999" },
    );
    expect(badYear.status).toBe(422);
    const badBase = await call(
      entitlementRoute.PUT,
      `/people/${anna.employeeId}/leave-entitlements/${YEAR}`,
      { method: "PUT", token: await tokenFor(ewa), body: { baseDays: 24, entitledDays: 24 } },
      { employeeId: anna.employeeId, year: String(YEAR) },
    );
    expect(badBase.status).toBe(422);
  });
});

describe("wnioski i akceptacja", () => {
  it("wniosek czeka na kierownika, który go akceptuje; saldo liczy dni pracy, a przyszły urlop da się wycofać", async () => {
    await setEntitlement(anna, 26);
    const created = await createRequest(anna, {
      type: "VACATION",
      startDate: `${YEAR}-08-04`,
      endDate: `${YEAR}-08-08`,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      employeeName: "Anna Nowak",
      type: "VACATION",
      status: "PENDING",
      workingDays: 5,
      decidedBy: null,
      access: { canCancel: true, canDecide: false },
    });
    const requestId = created.body.data.id as string;
    expect((await balanceOf(anna, anna)).body.data).toMatchObject({ pendingDays: 5, usedDays: 0, remainingDays: 21 });

    const overlap = await createRequest(anna, {
      type: "VACATION",
      startDate: `${YEAR}-08-08`,
      endDate: `${YEAR}-08-11`,
    });
    expect(overlap.status).toBe(409);

    const queue = await call(requestsRoute.GET, "/leave/requests?approvals=true", { token: await tokenFor(jan) });
    expect(queue.status).toBe(200);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0]).toMatchObject({ id: requestId, access: { canDecide: true } });
    for (const approver of [ewa, kasia]) {
      const hrQueue = await call(requestsRoute.GET, "/leave/requests?approvals=true", {
        token: await tokenFor(approver),
      });
      expect(hrQueue.body.data.map((item: { id: string }) => item.id)).toEqual([requestId]);
    }
    expect(
      (await call(requestsRoute.GET, "/leave/requests?approvals=true", { token: await tokenFor(anna) })).status,
    ).toBe(403);

    expect((await decide(anna, requestId, "APPROVE")).status).toBe(403);
    expect((await decide(piotr, requestId, "APPROVE")).status).toBe(404);

    const approved = await decide(jan, requestId, "APPROVE", "Miłego wypoczynku");
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "APPROVED",
      decisionNote: "Miłego wypoczynku",
      decidedBy: { accountId: jan.accountId, name: "Jan Kierownik" },
    });
    expect((await decide(jan, requestId, "REJECT")).status).toBe(409);
    expect((await balanceOf(anna, anna)).body.data).toMatchObject({ pendingDays: 0, usedDays: 5, remainingDays: 21 });

    const cancelled = await cancel(anna, requestId);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("CANCELLED");
    expect((await cancel(anna, requestId)).status).toBe(409);
    expect((await balanceOf(anna, anna)).body.data).toMatchObject({ usedDays: 0, remainingDays: 26 });
  });

  it("odrzuca wniosek bez salda, ponad saldo, ponad 4 dni na żądanie, w same dni wolne i przez przełom roku", async () => {
    const noBalance = await createRequest(anna, {
      type: "VACATION",
      startDate: `${YEAR + 1}-02-02`,
      endDate: `${YEAR + 1}-02-03`,
    });
    expect(noBalance.status).toBe(422);
    expect(noBalance.body.error.message).toContain(`${YEAR + 1}`);

    await setEntitlement(anna, 3);
    const tooLong = await createRequest(anna, {
      type: "VACATION",
      startDate: `${YEAR}-09-08`,
      endDate: `${YEAR}-09-12`,
    });
    expect(tooLong.status).toBe(409);
    expect(tooLong.body.error.message).toContain("zostało 3 dni");

    await setEntitlement(anna, 26);
    const onDemand = await createRequest(anna, {
      type: "ON_DEMAND",
      startDate: `${YEAR}-03-03`,
      endDate: `${YEAR}-03-06`,
    });
    expect(onDemand.status).toBe(201);
    expect(onDemand.body.data.workingDays).toBe(4);
    const fifth = await createRequest(anna, {
      type: "ON_DEMAND",
      startDate: `${YEAR}-03-10`,
      endDate: `${YEAR}-03-10`,
    });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error.message).toContain("4 dni");

    const weekend = await createRequest(anna, {
      type: "VACATION",
      startDate: `${YEAR}-03-15`,
      endDate: `${YEAR}-03-16`,
    });
    expect(weekend.status).toBe(422);
    const yearEnd = await createRequest(anna, {
      type: "VACATION",
      startDate: `${YEAR}-12-30`,
      endDate: `${YEAR + 1}-01-03`,
    });
    expect(yearEnd.status).toBe(422);
  });

  it("zwolnienie lekarskie wpisują tylko kadry całej firmy; kierownik widzi je jako nieobecność bez rodzaju", async () => {
    const sick = { type: "SICK", startDate: `${YEAR}-02-03`, endDate: `${YEAR}-02-05`, employeeId: anna.employeeId };
    expect((await createRequest(anna, sick)).status).toBe(403);
    expect((await createRequest(kasia, sick)).status).toBe(403);
    expect(
      (await createRequest(piotr, { type: "VACATION", startDate: `${YEAR}-02-03`, endDate: `${YEAR}-02-05` })).status,
    ).toBe(403);

    const entered = await createRequest(ewa, { ...sick, note: "e-ZLA" });
    expect(entered.status).toBe(201);
    expect(entered.body.data).toMatchObject({
      type: "SICK",
      status: "APPROVED",
      decidedBy: { accountId: ewa.accountId, name: "Ewa Kadrowa" },
    });
    const sickId = entered.body.data.id as string;

    const own = await call(requestsRoute.GET, "/leave/requests", { token: await tokenFor(anna) });
    expect(own.body.data).toEqual([expect.objectContaining({ id: sickId, type: "SICK", note: "e-ZLA" })]);

    const managerList = await call(requestsRoute.GET, `/leave/requests?employeeId=${anna.employeeId}`, {
      token: await tokenFor(jan),
    });
    expect(managerList.status).toBe(200);
    expect(managerList.body.data).toEqual([]);
    const managerCalendar = await calendarFor(jan, `${YEAR}-02-01`, `${YEAR}-02-28`);
    expect(managerCalendar.body.data).toEqual([
      expect.objectContaining({ requestId: sickId, employeeName: "Anna Nowak", type: null, status: "APPROVED" }),
    ]);
    expect((await cancel(jan, sickId)).status).toBe(404);

    // Kadry oddziału wpisują urlop za osobę z Magazynu i jest on od razu zaakceptowany
    await setEntitlement(anna, 26);
    const hrEntry = await createRequest(kasia, {
      type: "VACATION",
      startDate: `${YEAR}-04-14`,
      endDate: `${YEAR}-04-18`,
      employeeId: anna.employeeId,
    });
    expect(hrEntry.status).toBe(201);
    expect(hrEntry.body.data).toMatchObject({ status: "APPROVED", decidedBy: { name: "Kasia Oddziałowa" } });

    for (const viewer of [jan, kasia]) {
      const outOfScope = await call(requestsRoute.GET, `/leave/requests?employeeId=${piotr.employeeId}`, {
        token: await tokenFor(viewer),
      });
      expect(outOfScope.status).toBe(404);
    }
  });

  it("rozpoczętego urlopu osoba nie wycofa sama, a kadry tak", async () => {
    await setEntitlement(anna, 26, 2026);
    const past = await createRequest(ewa, {
      type: "VACATION",
      startDate: "2026-11-02",
      endDate: "2026-11-03",
      employeeId: anna.employeeId,
    });
    expect(past.status).toBe(201);
    expect(past.body.data.access.canCancel).toBe(true);
    const own = await call(requestsRoute.GET, "/leave/requests", { token: await tokenFor(anna) });
    expect(own.body.data[0].access.canCancel).toBe(false);
    expect((await cancel(anna, past.body.data.id)).status).toBe(403);
    expect((await cancel(ewa, past.body.data.id)).status).toBe(200);
  });

  it("dwa równoczesne wnioski na ten sam okres: jeden przechodzi, drugi dostaje 409", async () => {
    await setEntitlement(anna, 26);
    const body = { type: "VACATION", startDate: `${YEAR}-06-30`, endDate: `${YEAR}-07-02` };
    const results = await Promise.all([createRequest(anna, body), createRequest(anna, body)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it("lista własnych wniosków jest stronicowana od najnowszych", async () => {
    await setEntitlement(anna, 26);
    for (const [start, end] of [
      [`${YEAR}-03-03`, `${YEAR}-03-03`],
      [`${YEAR}-04-14`, `${YEAR}-04-15`],
      [`${YEAR}-08-04`, `${YEAR}-08-05`],
    ] as const) {
      expect((await createRequest(anna, { type: "VACATION", startDate: start, endDate: end })).status).toBe(201);
    }
    const token = await tokenFor(anna);
    const first = await call(requestsRoute.GET, "/leave/requests?limit=2", { token });
    expect(first.body.data.map((item: { startDate: string }) => item.startDate)).toEqual([
      `${YEAR}-08-04`,
      `${YEAR}-04-14`,
    ]);
    const second = await call(requestsRoute.GET, `/leave/requests?limit=2&cursor=${first.body.meta.nextCursor}`, {
      token,
    });
    expect(second.body.data.map((item: { startDate: string }) => item.startDate)).toEqual([`${YEAR}-03-03`]);
    expect(second.body.meta.nextCursor).toBeNull();
    expect((await call(requestsRoute.GET, "/leave/requests?cursor=zepsuty", { token })).status).toBe(422);
  });
});

describe("kalendarz zespołu i dni pracy", () => {
  it("współpracownicy z jednostki widzą tylko zaakceptowane nieobecności bez rodzaju, kadry widzą wszystko", async () => {
    await setEntitlement(jan, 26);
    const pending = await createRequest(jan, {
      type: "VACATION",
      startDate: `${YEAR}-07-07`,
      endDate: `${YEAR}-07-11`,
    });
    expect(pending.status).toBe(201);

    expect((await calendarFor(anna, `${YEAR}-07-01`, `${YEAR}-07-31`)).body.data).toEqual([]);
    expect((await calendarFor(ewa, `${YEAR}-07-01`, `${YEAR}-07-31`)).body.data).toEqual([
      expect.objectContaining({ employeeName: "Jan Kierownik", type: "VACATION", status: "PENDING" }),
    ]);
    // Kierownik nie akceptuje własnego wniosku, robią to kadry
    expect((await decide(jan, pending.body.data.id, "APPROVE")).status).toBe(403);
    expect((await decide(ewa, pending.body.data.id, "APPROVE")).status).toBe(200);

    expect((await calendarFor(anna, `${YEAR}-07-01`, `${YEAR}-07-31`)).body.data).toEqual([
      expect.objectContaining({ employeeName: "Jan Kierownik", type: null, status: "APPROVED" }),
    ]);
    expect((await calendarFor(piotr, `${YEAR}-07-01`, `${YEAR}-07-31`)).body.data).toEqual([]);
    expect((await calendarFor(ewa, `${YEAR}-07-01`, `${YEAR}-07-31`, `&unitId=${finanseId}`)).body.data).toEqual([]);
    expect((await calendarFor(ewa, `${YEAR}-07-01`, `${YEAR}-07-31`, `&unitId=${magazynId}`)).body.data).toHaveLength(
      1,
    );
    expect((await calendarFor(ewa, `${YEAR}-07-01`, `${YEAR}-09-30`)).status).toBe(422);
  });

  it("podgląd dni pracy korzysta z wymiaru pracy z Core i polskich świąt", async () => {
    schedules.set(piotr.employeeId, { "1": 480, "2": 480, "3": 240 });
    const partTime = await call(workingDaysRoute.GET, "/leave/working-days?from=2027-01-04&to=2027-01-10", {
      token: await tokenFor(piotr),
    });
    expect(partTime.status).toBe(200);
    expect(partTime.body.data).toEqual({ workingDays: 2, holidays: ["2027-01-06"] });

    const christmas = await call(workingDaysRoute.GET, "/leave/working-days?from=2026-12-21&to=2026-12-31", {
      token: await tokenFor(anna),
    });
    expect(christmas.body.data).toEqual({ workingDays: 7, holidays: ["2026-12-24", "2026-12-25"] });

    const forPiotr = `/leave/working-days?from=2027-01-04&to=2027-01-10&employeeId=${piotr.employeeId}`;
    expect((await call(workingDaysRoute.GET, forPiotr, { token: await tokenFor(anna) })).status).toBe(404);
    expect((await call(workingDaysRoute.GET, forPiotr, { token: await tokenFor(ewa) })).body.data.workingDays).toBe(2);
    const forAnna = `/leave/working-days?from=2027-01-04&to=2027-01-10&employeeId=${anna.employeeId}`;
    expect((await call(workingDaysRoute.GET, forAnna, { token: await tokenFor(jan) })).status).toBe(403);
    expect(
      (
        await call(workingDaysRoute.GET, "/leave/working-days?from=2027-01-10&to=2027-01-04", {
          token: await tokenFor(anna),
        })
      ).status,
    ).toBe(422);
  });
});

describe("ograniczenie nakładania się w bazie", () => {
  it("isOverlapViolation rozpoznaje błąd EXCLUDE zwrócony przez PostgreSQL", async () => {
    const actor = { organizationId: acme.id, accountId: ewa.accountId };
    const employeeId = uuidv7();
    const insert = () =>
      withUser(getDb(), actor, (tx) =>
        tx.leaveRequest.create({
          data: {
            id: uuidv7(),
            organizationId: acme.id,
            employeeId,
            type: "OTHER",
            startDate: new Date(`${YEAR}-05-05`),
            endDate: new Date(`${YEAR}-05-06`),
            workingDays: 2,
            status: "PENDING",
            requestedByAccountId: ewa.accountId,
          },
        }),
      );
    await insert();
    const error = await insert().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(isOverlapViolation(error)).toBe(true);
    expect(isOverlapViolation(new Error("inny błąd"))).toBe(false);
  });
});
