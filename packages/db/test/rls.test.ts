import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, uuidv7, withUser, type Actor } from "../src/index.js";

// Rola aplikacji (hira_hr_app): RLS obowiązuje ją zawsze. Lokalnie: pnpm db:up && pnpm db:migrate.
const url =
  process.env.HIRAHR_TEST_APP_DATABASE_URL ?? "postgresql://hira_hr_app:hira_hr_app@localhost:5437/hira_hr_test";
// Jedno połączenie w puli pozwala użyć tabeli tymczasowej z wymuszonym RLS do sprawdzenia funkcji pomocniczych w etapie 0.
const db = createDb(url, { max: 1 });

const acme = uuidv7();
const globex = uuidv7();
const anna: Actor = { organizationId: acme, accountId: uuidv7() };
const bartek: Actor = { organizationId: acme, accountId: uuidv7() };
const celina: Actor = { organizationId: globex, accountId: uuidv7() };

beforeAll(async () => {
  await db.$executeRawUnsafe(`
    CREATE TEMP TABLE rls_stage0_probe (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      account_id UUID NOT NULL,
      label TEXT NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`ALTER TABLE rls_stage0_probe ENABLE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`ALTER TABLE rls_stage0_probe FORCE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`
    CREATE POLICY owner_isolation ON rls_stage0_probe
      USING (
        organization_id = "public"."current_organization_id"()
        AND account_id = "public"."current_account_id"()
      )
      WITH CHECK (
        organization_id = "public"."current_organization_id"()
        AND account_id = "public"."current_account_id"()
      )
  `);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_stage0_probe`);
  await db.session.deleteMany({ where: { organizationId: { in: [acme, globex] } } });
  await db.processedEvent.deleteMany({ where: { consumer: "hirahr-rls-test" } });
  await db.eventFeedCursor.deleteMany({ where: { id: "core-rls-test" } });
  await db.$disconnect();
});

describe("RLS i uprawnienia roli aplikacji hira_hr_app (etap 0)", () => {
  it("rola hira_hr_app nie jest superużytkownikiem i nie ma BYPASSRLS", async () => {
    const rows = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("withUser ustawia current_organization_id() i current_account_id() wyłącznie na czas transakcji", async () => {
    const inside = await withUser(
      db,
      anna,
      (tx) =>
        tx.$queryRaw<{ organizationId: string | null; accountId: string | null }[]>`
        SELECT "public"."current_organization_id"()::text AS "organizationId",
               "public"."current_account_id"()::text AS "accountId"
      `,
    );
    expect(inside).toEqual([{ organizationId: anna.organizationId, accountId: anna.accountId }]);

    // Po zakończeniu transakcji zmienne znikają i nie przeciekają na kolejne zapytania z puli
    const outside = await db.$queryRaw<{ organizationId: string | null; accountId: string | null }[]>`
      SELECT "public"."current_organization_id"()::text AS "organizationId",
             "public"."current_account_id"()::text AS "accountId"
    `;
    expect(outside).toEqual([{ organizationId: null, accountId: null }]);
  });

  it("odrzuca niepoprawny UUID w withUser przed wysłaniem zapytania do bazy", async () => {
    await expect(
      withUser(db, { organizationId: "nie-uuid", accountId: anna.accountId }, async () => true),
    ).rejects.toThrow(/UUID/);
    await expect(
      withUser(db, { organizationId: anna.organizationId, accountId: "nie-uuid" }, async () => true),
    ).rejects.toThrow(/UUID/);
  });

  it("polityka RLS oparta na funkcjach pomocniczych izoluje odczyt i zapis między firmami i kontami", async () => {
    const annaRowId = uuidv7();
    await withUser(
      db,
      anna,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO rls_stage0_probe (id, organization_id, account_id, label)
        VALUES (${annaRowId}::uuid, ${anna.organizationId}::uuid, ${anna.accountId}::uuid, 'wpis-anny')
      `,
    );

    const annaVisible = await withUser(
      db,
      anna,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`,
    );
    expect(annaVisible).toEqual([{ id: annaRowId }]);

    // Inna osoba z tej samej firmy, osoba z innej firmy i zapytanie bez withUser nie widzą wiersza
    expect(
      await withUser(db, bartek, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`),
    ).toEqual([]);
    expect(
      await withUser(db, celina, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`),
    ).toEqual([]);
    expect(await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`).toEqual([]);

    // Nie da się zapisać wiersza z cudzym organization_id albo account_id
    await expect(
      withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO rls_stage0_probe (id, organization_id, account_id, label)
          VALUES (${uuidv7()}::uuid, ${celina.organizationId}::uuid, ${celina.accountId}::uuid, 'obcy')
        `,
      ),
    ).rejects.toThrow();

    await withUser(db, anna, (tx) => tx.$executeRaw`DELETE FROM rls_stage0_probe WHERE id = ${annaRowId}::uuid`);
  });

  it("sesje przeglądarki i tabele kanału zdarzeń są dostępne dla hira_hr_app bez ustawionej firmy", async () => {
    const sessionId = `skrot-${uuidv7()}`;
    await db.session.create({
      data: {
        id: sessionId,
        accountId: anna.accountId,
        organizationId: acme,
        expiresAt: new Date(Date.now() + 60_000),
        data: "x",
      },
    });
    expect((await db.session.findUnique({ where: { id: sessionId } }))?.accountId).toBe(anna.accountId);
    await db.session.delete({ where: { id: sessionId } });

    await db.eventFeedCursor.upsert({
      where: { id: "core-rls-test" },
      create: { id: "core-rls-test", sequence: "42" },
      update: { sequence: "42" },
    });
    expect((await db.eventFeedCursor.findUnique({ where: { id: "core-rls-test" } }))?.sequence).toBe("42");

    const eventId = uuidv7();
    await db.processedEvent.create({
      data: { consumer: "hirahr-rls-test", eventId, processedAt: new Date() },
    });
    expect(
      await db.processedEvent.findUnique({
        where: { consumer_eventId: { consumer: "hirahr-rls-test", eventId } },
      }),
    ).not.toBeNull();
  });

  it("rola aplikacji nie widzi historii migracji", async () => {
    await expect(db.$queryRaw`SELECT count(*) FROM public._prisma_migrations`).rejects.toThrow(/permission denied/);
  });
});

describe("RLS tabel kartoteki (etap 1, ADR-0104)", () => {
  const STAGE1_TABLES = ["positions", "employee_profiles", "employment_contracts", "sensitive_access_log"] as const;
  const annaEmployee = uuidv7();
  const celinaEmployee = uuidv7();

  it("wszystkie tabele kartoteki mają włączone i wymuszone RLS", async () => {
    const rows = await db.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...STAGE1_TABLES]})
      ORDER BY relname
    `;
    expect(rows).toHaveLength(STAGE1_TABLES.length);
    for (const row of rows) {
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("izoluje kartoteki i umowy między firmami, a bez kontekstu nie zwraca nic", async () => {
    await withUser(db, anna, (tx) =>
      tx.employeeProfile.create({ data: { organizationId: acme, employeeId: annaEmployee, personalPhone: "+48 600" } }),
    );
    await withUser(db, celina, (tx) =>
      tx.employeeProfile.create({ data: { organizationId: globex, employeeId: celinaEmployee } }),
    );
    expect(await withUser(db, anna, (tx) => tx.employeeProfile.count())).toBe(1);
    expect(await withUser(db, celina, (tx) => tx.employeeProfile.count())).toBe(1);
    expect(await db.employeeProfile.count()).toBe(0);

    await expect(
      withUser(db, anna, (tx) => tx.employeeProfile.create({ data: { organizationId: globex, employeeId: uuidv7() } })),
    ).rejects.toThrow();

    // Umowa nie może wskazać stanowiska innej firmy (złożony klucz obcy)
    const globexPosition = await withUser(db, celina, (tx) =>
      tx.position.create({ data: { id: uuidv7(), organizationId: globex, name: "Księgowa" } }),
    );
    await expect(
      withUser(db, anna, (tx) =>
        tx.employmentContract.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            employeeId: annaEmployee,
            type: "INDEFINITE",
            startDate: new Date("2026-01-01"),
            fteNumerator: 1,
            fteDenominator: 1,
            positionId: globexPosition.id,
            createdByAccountId: anna.accountId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("odrzuca jawne wartości w polach szyfrowanych i niespójne umowy (CHECK)", async () => {
    await expect(
      withUser(db, anna, (tx) =>
        tx.employeeProfile.update({
          where: { organizationId_employeeId: { organizationId: acme, employeeId: annaEmployee } },
          data: { peselEncrypted: "90010112318" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withUser(db, anna, (tx) =>
        tx.employmentContract.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            employeeId: annaEmployee,
            type: "MANDATE",
            startDate: new Date("2026-01-01"),
            fteNumerator: 1,
            fteDenominator: 2,
            createdByAccountId: anna.accountId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("dziennik dostępu jest tylko do dopisywania i zawsze w imieniu zalogowanej osoby", async () => {
    const entry = await withUser(db, anna, (tx) =>
      tx.sensitiveAccessLog.create({
        data: {
          id: uuidv7(),
          organizationId: acme,
          actorAccountId: anna.accountId,
          employeeId: annaEmployee,
          action: "READ",
          fields: ["pesel"],
        },
      }),
    );
    await expect(
      withUser(db, anna, (tx) =>
        tx.sensitiveAccessLog.update({ where: { id: entry.id }, data: { fields: ["salary"] } }),
      ),
    ).rejects.toThrow();
    await expect(
      withUser(db, anna, (tx) => tx.sensitiveAccessLog.delete({ where: { id: entry.id } })),
    ).rejects.toThrow();
    // Wpis w imieniu innej osoby odrzuca polityka RLS
    await expect(
      withUser(db, anna, (tx) =>
        tx.sensitiveAccessLog.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            actorAccountId: bartek.accountId,
            employeeId: annaEmployee,
            action: "READ",
            fields: ["pesel"],
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("RLS i ograniczenia tabel urlopów (etap 2, ADR-0104)", () => {
  const STAGE2_TABLES = ["leave_entitlements", "leave_requests"] as const;
  const annaEmployee = uuidv7();

  function leave(
    actor: Actor,
    data: {
      start: string;
      end: string;
      status?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
      type?: "VACATION" | "SICK";
    },
  ) {
    const decided = data.status === "APPROVED" || data.status === "REJECTED";
    return withUser(db, actor, (tx) =>
      tx.leaveRequest.create({
        data: {
          id: uuidv7(),
          organizationId: actor.organizationId,
          employeeId: annaEmployee,
          type: data.type ?? "VACATION",
          startDate: new Date(data.start),
          endDate: new Date(data.end),
          workingDays: 1,
          status: data.status ?? "PENDING",
          requestedByAccountId: actor.accountId,
          ...(decided ? { decidedByAccountId: actor.accountId, decidedAt: new Date() } : {}),
        },
      }),
    );
  }

  it("obie tabele mają włączone i wymuszone RLS, a rola aplikacji nie może usuwać wierszy", async () => {
    const rows = await db.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...STAGE2_TABLES]})
      ORDER BY relname
    `;
    expect(rows).toHaveLength(STAGE2_TABLES.length);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

    const privileges = await db.$queryRaw<{ table: string; canDelete: boolean; canTruncate: boolean }[]>`
      SELECT relname AS "table",
             has_table_privilege(current_user, oid, 'DELETE') AS "canDelete",
             has_table_privilege(current_user, oid, 'TRUNCATE') AS "canTruncate"
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...STAGE2_TABLES]})
    `;
    for (const row of privileges) expect(row).toMatchObject({ canDelete: false, canTruncate: false });
  });

  it("izoluje salda i wnioski między firmami, a bez kontekstu nie zwraca nic", async () => {
    await withUser(db, anna, (tx) =>
      tx.leaveEntitlement.create({
        data: {
          organizationId: acme,
          employeeId: annaEmployee,
          year: 2027,
          entitledDays: 26,
          updatedByAccountId: anna.accountId,
        },
      }),
    );
    await leave(anna, { start: "2027-02-01", end: "2027-02-05" });
    expect(await withUser(db, anna, (tx) => tx.leaveEntitlement.count())).toBe(1);
    expect(await withUser(db, anna, (tx) => tx.leaveRequest.count())).toBe(1);
    expect(await withUser(db, celina, (tx) => tx.leaveEntitlement.count())).toBe(0);
    expect(await withUser(db, celina, (tx) => tx.leaveRequest.count())).toBe(0);
    expect(await db.leaveRequest.count()).toBe(0);
    await expect(
      withUser(db, anna, (tx) =>
        tx.leaveEntitlement.create({
          data: {
            organizationId: globex,
            employeeId: annaEmployee,
            year: 2027,
            entitledDays: 20,
            updatedByAccountId: anna.accountId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("aktywne nieobecności jednej osoby nie mogą się nakładać, odrzucone i wycofane mogą", async () => {
    await leave(anna, { start: "2027-03-01", end: "2027-03-05", status: "APPROVED" });
    await expect(leave(anna, { start: "2027-03-05", end: "2027-03-08" })).rejects.toThrow(
      /23P01|no_overlap|exclusion/i,
    );
    await expect(
      leave(anna, { start: "2027-03-02", end: "2027-03-03", status: "APPROVED", type: "SICK" }),
    ).rejects.toThrow();
    await leave(anna, { start: "2027-03-02", end: "2027-03-03", status: "REJECTED" });
    await leave(anna, { start: "2027-03-04", end: "2027-03-04", status: "CANCELLED" });
    // Ta sama osoba w innej firmie to inny wiersz katalogu, więc ograniczenie jej nie dotyczy
    await leave(celina, { start: "2027-03-01", end: "2027-03-05" });
  });

  it("odrzuca urlop wypoczynkowy przez przełom roku i decyzję bez autora (CHECK)", async () => {
    await expect(leave(anna, { start: "2027-12-30", end: "2028-01-03" })).rejects.toThrow();
    await leave(anna, { start: "2027-12-30", end: "2028-01-03", type: "SICK", status: "APPROVED" });
    await expect(
      withUser(db, anna, (tx) =>
        tx.leaveRequest.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            employeeId: annaEmployee,
            type: "VACATION",
            startDate: new Date("2027-05-03"),
            endDate: new Date("2027-05-04"),
            workingDays: 1,
            status: "APPROVED",
            requestedByAccountId: anna.accountId,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withUser(db, anna, (tx) =>
        tx.leaveEntitlement.create({
          data: {
            organizationId: acme,
            employeeId: annaEmployee,
            year: 2028,
            baseDays: 24,
            entitledDays: 24,
            updatedByAccountId: anna.accountId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
