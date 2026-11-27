/**
 * Testy tras kartoteki HiraHR (etap 1, ADR-0104) na prawdziwych handlerach Next.js, prawdziwym PostgreSQL z RLS
 * i atrapie `createFakeCore` (katalog pracowników i członkostw w jednostkach).
 *
 * Firma Acme: Oddział Kraków > Magazyn oraz Finanse.
 * - Ewa: rola Kadry w zakresie całej firmy (także dane wrażliwe),
 * - Kasia: rola Kadry w zakresie oddziału Kraków (kartoteki i umowy, bez danych wrażliwych),
 * - Jan: Kierownik w Magazynie (tylko podgląd kartotek),
 * - Anna (Magazyn) i Piotr (Finanse): bez ról, tylko samoobsługa.
 */
import type { Authenticated, Session } from "@monorise-team/auth/next";
import {
  createFakeCore,
  type CreatedEmployeeWithAccount,
  type FakeCore,
  type FakeOrganizationBuilder,
} from "@monorise-team/testing";
import { HIRAHR_PERMISSIONS } from "@hirahr/contracts";
import { withUser } from "@hirahr/db";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as contractByIdRoute from "@/app/api/v1/contracts/[contractId]/route";
import * as personRoute from "@/app/api/v1/people/[employeeId]/route";
import * as contractsRoute from "@/app/api/v1/people/[employeeId]/contracts/route";
import * as accessLogRoute from "@/app/api/v1/people/[employeeId]/sensitive-access-log/route";
import * as sensitiveRoute from "@/app/api/v1/people/[employeeId]/sensitive/route";
import * as peopleRoute from "@/app/api/v1/people/route";
import * as positionByIdRoute from "@/app/api/v1/positions/[positionId]/route";
import * as positionsRoute from "@/app/api/v1/positions/route";
import * as unitsRoute from "@/app/api/v1/units/route";
import { getAuth } from "@/server/auth";
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
import { invalidatePermissionCache } from "@/server/permissions";
import { createFakeCoreWithUnitsFetch } from "./helpers/fake-core-units";

const API = "http://hira.localhost:3600";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.people.test";
const CLIENT_ID = "hirahr-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

// Poprawne dane testowe (suma kontrolna PESEL i IBAN), nie należą do prawdziwych osób
const PESEL_ANNA = "90010112318";
const IBAN_ANNA = "PL61 1090 1014 0000 0712 1981 2874";

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
    body:
      response.status === 204
        ? ({ data: null, meta: null, error: null } as TestEnvelope)
        : ((await response.json()) as TestEnvelope),
  }));
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let krakowId: string;
let magazynId: string;
let finanseId: string;
let ewa: CreatedEmployeeWithAccount;
let kasia: CreatedEmployeeWithAccount;
let jan: CreatedEmployeeWithAccount;
let anna: CreatedEmployeeWithAccount;
let piotr: CreatedEmployeeWithAccount;

async function tokenFor(employee: CreatedEmployeeWithAccount) {
  return acme.signUserToken(employee.accountId, { audience: API });
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
  setCoreRetryForTests(false);
  invalidatePermissionCache();
  invalidateDirectoryCache();
  resetMachineCoreTokenCache();

  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("hirahr");
  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  const magazyn = acme.addUnit({ name: "Magazyn", type: "TEAM", parentId: krakow.id });
  const finanse = acme.addUnit({ name: "Finanse", type: "TEAM" });
  krakowId = krakow.id;
  magazynId = magazyn.id;
  finanseId = finanse.id;

  const keys = HIRAHR_PERMISSIONS.keys;
  const hrRole = acme.addRole({
    name: "Kadry",
    product: "hirahr",
    permissions: Object.values(keys),
  }).id;
  const managerRole = acme.addRole({
    name: "Kierownik",
    product: "hirahr",
    permissions: [keys["employees.read"], keys["leave.request"], keys["leave.approve"]],
  }).id;

  ewa = acme.addEmployee({ firstName: "Ewa", lastName: "Kadrowa", products: ["hirahr"] });
  kasia = acme.addEmployee({ firstName: "Kasia", lastName: "Oddziałowa", products: ["hirahr"], unitIds: [krakowId] });
  jan = acme.addEmployee({ firstName: "Jan", lastName: "Kierownik", products: ["hirahr"], unitIds: [magazynId] });
  anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["hirahr"], unitIds: [magazynId] });
  piotr = acme.addEmployee({ firstName: "Piotr", lastName: "Żółkiewski", products: ["hirahr"], unitIds: [finanseId] });

  acme.assignRole({ accountId: ewa.accountId, roleId: hrRole, scope: { type: "ORGANIZATION" } });
  acme.assignRole({ accountId: kasia.accountId, roleId: hrRole, scope: { type: "UNIT", unitId: krakowId } });
  acme.assignRole({ accountId: jan.accountId, roleId: managerRole, scope: { type: "UNIT", unitId: magazynId } });

  vi.spyOn(globalThis, "fetch").mockImplementation(createFakeCoreWithUnitsFetch(fakeCore));
});

afterEach(() => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

const names = (body: TestEnvelope) => (body.data as { fullName: string }[]).map((person) => person.fullName).sort();

describe("lista ludzi w zasięgu uprawnień", () => {
  it("Kadry w firmie widzą wszystkich, Kadry w oddziale tylko oddział z poddrzewem, Kierownik tylko Magazyn", async () => {
    const all = await call(peopleRoute.GET, "/people", { token: await tokenFor(ewa) });
    expect(all.status).toBe(200);
    expect(names(all.body)).toEqual(
      ["Anna Nowak", "Ewa Kadrowa", "Jan Kierownik", "Kasia Oddziałowa", "Piotr Żółkiewski"].sort(),
    );

    const branch = await call(peopleRoute.GET, "/people", { token: await tokenFor(kasia) });
    expect(names(branch.body)).toEqual(["Anna Nowak", "Jan Kierownik", "Kasia Oddziałowa"]);

    const team = await call(peopleRoute.GET, "/people", { token: await tokenFor(jan) });
    expect(names(team.body)).toEqual(["Anna Nowak", "Jan Kierownik"]);
  });

  it("bez employees.read odmawia (403), a filtry, wyszukiwanie bez polskich znaków i stronicowanie działają", async () => {
    const denied = await call(peopleRoute.GET, "/people", { token: await tokenFor(anna) });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");

    const token = await tokenFor(ewa);
    const search = await call(peopleRoute.GET, "/people?search=zolkiewski", { token });
    expect(names(search.body)).toEqual(["Piotr Żółkiewski"]);

    const unit = await call(peopleRoute.GET, `/people?unitId=${magazynId}`, { token });
    expect(names(unit.body)).toEqual(["Anna Nowak", "Jan Kierownik"]);

    const first = await call(peopleRoute.GET, "/people?limit=2", { token });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await call(peopleRoute.GET, `/people?limit=2&cursor=${first.body.meta.nextCursor}`, { token });
    expect(second.body.data).toHaveLength(2);
    const third = await call(peopleRoute.GET, `/people?limit=2&cursor=${second.body.meta.nextCursor}`, { token });
    expect(third.body.data).toHaveLength(1);
    expect(third.body.meta.nextCursor).toBeNull();

    const badCursor = await call(peopleRoute.GET, "/people?cursor=zepsuty", { token });
    expect(badCursor.status).toBe(422);
  });

  it("przy awarii katalogu Core odmawia (503) zamiast pokazać za dużo", async () => {
    setCoreRetryForTests(false);
    fakeCore.failNext("directoryEmployees", { status: 503 });
    const response = await call(peopleRoute.GET, "/people", { token: await tokenFor(ewa) });
    expect(response.status).toBe(503);
  });
});

describe("karta osoby i samoobsługa", () => {
  it("sama osoba widzi swoją kartę, osoba spoza zasięgu dostaje 404, a nieznany identyfikator też 404", async () => {
    const own = await call(
      personRoute.GET,
      `/people/${anna.employeeId}`,
      { token: await tokenFor(anna) },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(own.status).toBe(200);
    expect(own.body.data.access).toEqual({
      self: true,
      canUpdateProfile: true,
      canManageContracts: false,
      canReadSensitive: true,
      canUpdateSensitive: false,
    });
    expect(own.body.data.unitIds).toEqual([magazynId]);

    const other = await call(
      personRoute.GET,
      `/people/${piotr.employeeId}`,
      { token: await tokenFor(anna) },
      {
        employeeId: piotr.employeeId,
      },
    );
    expect(other.status).toBe(404);

    const outsideTeam = await call(
      personRoute.GET,
      `/people/${piotr.employeeId}`,
      { token: await tokenFor(jan) },
      {
        employeeId: piotr.employeeId,
      },
    );
    expect(outsideTeam.status).toBe(404);

    const unknown = "01a21d17-0000-7000-8000-000000000000";
    const missing = await call(
      personRoute.GET,
      `/people/${unknown}`,
      { token: await tokenFor(ewa) },
      {
        employeeId: unknown,
      },
    );
    expect(missing.status).toBe(404);
  });

  it("Kierownik widzi kartę z zespołu bez prawa zmian; Kadry w oddziale nie mają dostępu do danych wrażliwych", async () => {
    const byManager = await call(
      personRoute.GET,
      `/people/${anna.employeeId}`,
      { token: await tokenFor(jan) },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(byManager.status).toBe(200);
    expect(byManager.body.data.access).toMatchObject({
      self: false,
      canUpdateProfile: false,
      canManageContracts: false,
      canReadSensitive: false,
    });

    const byBranchHr = await call(
      personRoute.GET,
      `/people/${anna.employeeId}`,
      { token: await tokenFor(kasia) },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(byBranchHr.body.data.access).toMatchObject({
      canUpdateProfile: true,
      canManageContracts: true,
      canReadSensitive: false,
      canUpdateSensitive: false,
    });
  });

  it("zmienia kartotekę: sama osoba i Kadry w zasięgu tak, Kierownik nie (403), błędny e-mail 422", async () => {
    const own = await call(
      personRoute.PATCH,
      `/people/${anna.employeeId}`,
      {
        method: "PATCH",
        token: await tokenFor(anna),
        body: {
          personalPhone: "+48 600 100 200",
          homeAddress: { street: "Długa 5/2", postalCode: "30-001", city: "Kraków" },
          emergencyContact: { name: "Marek Nowak", relation: "mąż", phone: "+48 600 300 400" },
        },
      },
      { employeeId: anna.employeeId },
    );
    expect(own.status).toBe(200);
    expect(own.body.data.profile).toMatchObject({
      personalPhone: "+48 600 100 200",
      homeAddress: { street: "Długa 5/2", postalCode: "30-001", city: "Kraków", country: "Polska" },
      emergencyContact: { name: "Marek Nowak", relation: "mąż", phone: "+48 600 300 400" },
    });

    const byHr = await call(
      personRoute.PATCH,
      `/people/${anna.employeeId}`,
      { method: "PATCH", token: await tokenFor(kasia), body: { dateOfBirth: "1990-01-01", homeAddress: null } },
      { employeeId: anna.employeeId },
    );
    expect(byHr.status).toBe(200);
    expect(byHr.body.data.profile.dateOfBirth).toBe("1990-01-01");
    expect(byHr.body.data.profile.homeAddress).toBeNull();
    expect(byHr.body.data.profile.personalPhone).toBe("+48 600 100 200");

    const byManager = await call(
      personRoute.PATCH,
      `/people/${anna.employeeId}`,
      { method: "PATCH", token: await tokenFor(jan), body: { personalPhone: "1" } },
      { employeeId: anna.employeeId },
    );
    expect(byManager.status).toBe(403);

    const badEmail = await call(
      personRoute.PATCH,
      `/people/${anna.employeeId}`,
      { method: "PATCH", token: await tokenFor(anna), body: { personalEmail: "nie-email" } },
      { employeeId: anna.employeeId },
    );
    expect(badEmail.status).toBe(422);
  });
});

describe("dane wrażliwe i dziennik dostępu", () => {
  it("zapisuje PESEL i rachunek tylko jako szyfrogram, z kontrolą sumy i z dziennikiem kto i kiedy", async () => {
    const ewaToken = await tokenFor(ewa);
    const invalid = await call(
      sensitiveRoute.PUT,
      `/people/${anna.employeeId}/sensitive`,
      { method: "PUT", token: ewaToken, body: { pesel: "90010112319" } },
      { employeeId: anna.employeeId },
    );
    expect(invalid.status).toBe(422);

    const saved = await call(
      sensitiveRoute.PUT,
      `/people/${anna.employeeId}/sensitive`,
      {
        method: "PUT",
        token: ewaToken,
        body: { pesel: PESEL_ANNA, bankAccount: IBAN_ANNA, idDocumentNumber: "abc123456" },
      },
      { employeeId: anna.employeeId },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.sensitive).toEqual({ pesel: true, bankAccount: true, idDocumentNumber: true });

    // W bazie nie ma jawnych wartości, tylko szyfrogram v1.<klucz>.…
    const stored = await withUser(getDb(), { organizationId: acme.id, accountId: ewa.accountId }, (tx) =>
      tx.employeeProfile.findUniqueOrThrow({
        where: { organizationId_employeeId: { organizationId: acme.id, employeeId: anna.employeeId } },
      }),
    );
    expect(stored.peselEncrypted).toMatch(/^v1\.test1\./);
    expect(stored.peselEncrypted).not.toContain(PESEL_ANNA);
    expect(stored.bankAccountEncrypted).not.toContain("10901014");

    const read = await call(
      sensitiveRoute.GET,
      `/people/${anna.employeeId}/sensitive`,
      { token: ewaToken },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      pesel: PESEL_ANNA,
      bankAccount: "PL61109010140000071219812874",
      idDocumentNumber: "ABC123456",
    });

    const ownRead = await call(
      sensitiveRoute.GET,
      `/people/${anna.employeeId}/sensitive`,
      { token: await tokenFor(anna) },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(ownRead.status).toBe(200);
    expect(ownRead.body.data.pesel).toBe(PESEL_ANNA);

    const log = await call(
      accessLogRoute.GET,
      `/people/${anna.employeeId}/sensitive-access-log`,
      { token: await tokenFor(anna) },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(log.status).toBe(200);
    const entries = log.body.data as { actor: { name: string }; action: string; fields: string[] }[];
    expect(entries.map((entry) => `${entry.actor.name}:${entry.action}`)).toEqual([
      "Anna Nowak:READ",
      "Ewa Kadrowa:READ",
      "Ewa Kadrowa:UPDATE",
    ]);
    expect(entries[2]!.fields).toEqual(["pesel", "bankAccount", "idDocumentNumber"]);
    expect(JSON.stringify(log.body)).not.toContain(PESEL_ANNA);
  });

  it("odmawia danych wrażliwych przy zakresie oddziału i Kierownikowi (403), a dziennik innym (403)", async () => {
    const kasiaToken = await tokenFor(kasia);
    const readByBranch = await call(
      sensitiveRoute.GET,
      `/people/${anna.employeeId}/sensitive`,
      { token: kasiaToken },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(readByBranch.status).toBe(403);

    const updateByBranch = await call(
      sensitiveRoute.PUT,
      `/people/${anna.employeeId}/sensitive`,
      { method: "PUT", token: kasiaToken, body: { pesel: PESEL_ANNA } },
      { employeeId: anna.employeeId },
    );
    expect(updateByBranch.status).toBe(403);

    const ownUpdate = await call(
      sensitiveRoute.PUT,
      `/people/${anna.employeeId}/sensitive`,
      { method: "PUT", token: await tokenFor(anna), body: { pesel: PESEL_ANNA } },
      { employeeId: anna.employeeId },
    );
    expect(ownUpdate.status).toBe(403);

    const logByManager = await call(
      accessLogRoute.GET,
      `/people/${anna.employeeId}/sensitive-access-log`,
      { token: await tokenFor(jan) },
      {
        employeeId: anna.employeeId,
      },
    );
    expect(logByManager.status).toBe(403);
  });
});

describe("umowy i stanowiska", () => {
  async function createPosition(name: string) {
    const response = await call(positionsRoute.POST, "/positions", {
      method: "POST",
      token: await tokenFor(ewa),
      body: { name },
    });
    expect(response.status).toBe(201);
    return response.body.data as { id: string; name: string };
  }

  it("prowadzi katalog stanowisk: tylko settings.manage, unikalna nazwa (409), archiwizacja", async () => {
    const denied = await call(positionsRoute.POST, "/positions", {
      method: "POST",
      token: await tokenFor(jan),
      body: { name: "Magazynierka" },
    });
    expect(denied.status).toBe(403);

    const position = await createPosition("Magazynierka");
    const duplicate = await call(positionsRoute.POST, "/positions", {
      method: "POST",
      token: await tokenFor(ewa),
      body: { name: "magazynierka" },
    });
    expect(duplicate.status).toBe(409);

    const archived = await call(
      positionByIdRoute.PATCH,
      `/positions/${position.id}`,
      { method: "PATCH", token: await tokenFor(ewa), body: { archived: true } },
      { positionId: position.id },
    );
    expect(archived.body.data.archived).toBe(true);

    const active = await call(positionsRoute.GET, "/positions", { token: await tokenFor(anna) });
    expect(active.body.data).toEqual([]);
    const all = await call(positionsRoute.GET, "/positions?includeArchived=true", { token: await tokenFor(anna) });
    expect(all.body.data).toHaveLength(1);

    // Po archiwizacji nazwa jest znowu wolna
    await createPosition("Magazynierka");
  });

  it("dodaje umowy z regułami, wynagrodzenie tylko z sensitive.update w firmie, obecna umowa widoczna na liście", async () => {
    const position = await createPosition("Magazynierka");
    const kasiaToken = await tokenFor(kasia);
    const path = `/people/${anna.employeeId}/contracts`;
    const params = { employeeId: anna.employeeId };

    const missingEnd = await call(
      contractsRoute.POST,
      path,
      {
        method: "POST",
        token: kasiaToken,
        body: { type: "FIXED_TERM", startDate: "2026-01-01", fte: "1/1" },
      },
      params,
    );
    expect(missingEnd.status).toBe(422);

    const mandateWithFte = await call(
      contractsRoute.POST,
      path,
      {
        method: "POST",
        token: kasiaToken,
        body: { type: "MANDATE", startDate: "2026-01-01", fte: "1/2" },
      },
      params,
    );
    expect(mandateWithFte.status).toBe(422);

    const salaryByBranch = await call(
      contractsRoute.POST,
      path,
      {
        method: "POST",
        token: kasiaToken,
        body: { type: "INDEFINITE", startDate: "2026-01-01", fte: "1/1", salary: { amount: "8500.00" } },
      },
      params,
    );
    expect(salaryByBranch.status).toBe(403);

    const byManager = await call(
      contractsRoute.POST,
      path,
      {
        method: "POST",
        token: await tokenFor(jan),
        body: { type: "INDEFINITE", startDate: "2026-01-01", fte: "1/1" },
      },
      params,
    );
    expect(byManager.status).toBe(403);

    const created = await call(
      contractsRoute.POST,
      path,
      {
        method: "POST",
        token: kasiaToken,
        body: {
          type: "INDEFINITE",
          startDate: "2020-01-01",
          fte: "3/4",
          positionId: position.id,
          notes: "Pierwsza umowa",
        },
      },
      params,
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      type: "INDEFINITE",
      fte: "3/4",
      position: { id: position.id, name: "Magazynierka" },
      current: true,
      hasSalary: false,
    });

    const withSalary = await call(
      contractsRoute.POST,
      `/people/${piotr.employeeId}/contracts`,
      {
        method: "POST",
        token: await tokenFor(ewa),
        body: { type: "B2B", startDate: "2024-05-01", salary: { amount: "15000", currency: "PLN", period: "MONTH" } },
      },
      { employeeId: piotr.employeeId },
    );
    expect(withSalary.status).toBe(201);
    expect(withSalary.body.data.hasSalary).toBe(true);

    const list = await call(peopleRoute.GET, "/people", { token: await tokenFor(ewa) });
    const annaRow = (
      list.body.data as { employeeId: string; currentPosition: unknown; currentContractType: string }[]
    ).find((row) => row.employeeId === anna.employeeId);
    expect(annaRow).toMatchObject({ currentContractType: "INDEFINITE", currentPosition: { name: "Magazynierka" } });

    // Umowę z wynagrodzeniem usunie tylko osoba z danymi wrażliwymi w zakresie firmy
    const annaSalaryContract = await call(
      contractsRoute.POST,
      `/people/${anna.employeeId}/contracts`,
      {
        method: "POST",
        token: await tokenFor(ewa),
        body: { type: "MANDATE", startDate: "2019-01-01", endDate: "2019-06-30", salary: { amount: "3000" } },
      },
      { employeeId: anna.employeeId },
    );
    expect(annaSalaryContract.status).toBe(201);
    const deleteWithoutSensitive = await call(
      contractByIdRoute.DELETE,
      `/contracts/${annaSalaryContract.body.data.id}`,
      { method: "DELETE", token: kasiaToken },
      { contractId: annaSalaryContract.body.data.id },
    );
    expect(deleteWithoutSensitive.status).toBe(403);

    const piotrSensitive = await call(
      sensitiveRoute.GET,
      `/people/${piotr.employeeId}/sensitive`,
      { token: await tokenFor(piotr) },
      {
        employeeId: piotr.employeeId,
      },
    );
    expect(piotrSensitive.body.data.salaries).toEqual([
      { contractId: withSalary.body.data.id, salary: { amount: "15000", currency: "PLN", period: "MONTH" } },
    ]);
  });

  it("zmienia i usuwa umowy w zasięgu; reguły na rekordzie po scaleniu; umowa spoza zasięgu to 404", async () => {
    const kasiaToken = await tokenFor(kasia);
    const created = await call(
      contractsRoute.POST,
      `/people/${anna.employeeId}/contracts`,
      {
        method: "POST",
        token: kasiaToken,
        body: { type: "PROBATION", startDate: "2026-01-01", endDate: "2026-03-31", fte: "1/1" },
      },
      { employeeId: anna.employeeId },
    );
    const contractId = created.body.data.id as string;

    const toMandateKeepingFte = await call(
      contractByIdRoute.PATCH,
      `/contracts/${contractId}`,
      {
        method: "PATCH",
        token: kasiaToken,
        body: { type: "MANDATE" },
      },
      { contractId },
    );
    expect(toMandateKeepingFte.status).toBe(422);

    const toMandate = await call(
      contractByIdRoute.PATCH,
      `/contracts/${contractId}`,
      {
        method: "PATCH",
        token: kasiaToken,
        body: { type: "MANDATE", fte: null, endDate: null },
      },
      { contractId },
    );
    expect(toMandate.status).toBe(200);
    expect(toMandate.body.data).toMatchObject({ type: "MANDATE", fte: null, endDate: null });

    const piotrContract = await call(
      contractsRoute.POST,
      `/people/${piotr.employeeId}/contracts`,
      {
        method: "POST",
        token: await tokenFor(ewa),
        body: { type: "INDEFINITE", startDate: "2025-01-01", fte: "1/1" },
      },
      { employeeId: piotr.employeeId },
    );
    const outside = await call(
      contractByIdRoute.PATCH,
      `/contracts/${piotrContract.body.data.id}`,
      {
        method: "PATCH",
        token: kasiaToken,
        body: { notes: "x" },
      },
      { contractId: piotrContract.body.data.id },
    );
    expect(outside.status).toBe(404);

    const deleted = await call(
      contractByIdRoute.DELETE,
      `/contracts/${contractId}`,
      { method: "DELETE", token: kasiaToken },
      {
        contractId,
      },
    );
    expect(deleted.status).toBe(204);
    const card = await call(
      personRoute.GET,
      `/people/${anna.employeeId}`,
      { token: kasiaToken },
      { employeeId: anna.employeeId },
    );
    expect(card.body.data.contracts).toEqual([]);
  });
});

describe("jednostki", () => {
  it("lista jednostek działa tylko w sesji przeglądarki", async () => {
    const withToken = await call(unitsRoute.GET, "/units", { token: await tokenFor(ewa) });
    expect(withToken.status).toBe(403);

    const coreToken = await acme.signUserToken(ewa.accountId, { audience: fakeCore.coreApiUrl });
    const context = {
      accountId: ewa.accountId,
      organizationId: acme.id,
      employeeId: ewa.employeeId,
      sessionId: "sesja-people-test",
      authzRevision: ewa.account.authzRevision,
      methods: [],
      clientId: CLIENT_ID,
      scopes: ["openid", "profile", "email", "offline_access"],
      expiresAt: new Date(Date.now() + 5 * 60_000),
    };
    const session: Session = {
      context,
      profile: { email: ewa.account.email, name: "Ewa Kadrowa" },
      expiresAt: new Date(Date.now() + 60 * 60_000),
      accessToken: async () => coreToken,
      setCookies: [],
    };
    const authenticated: Authenticated = { context, via: "session", session, setCookies: [] };
    vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);

    const withSession = await call(unitsRoute.GET, "/units");
    expect(withSession.status).toBe(200);
    expect((withSession.body.data as { name: string }[]).map((unit) => unit.name)).toEqual([
      "Finanse",
      "Magazyn",
      "Oddział Kraków",
    ]);
  });
});
