-- Etap 1 HiraHR (ADR-0104): kartoteka pracowników, umowy z historią, stanowiska i dziennik dostępu
-- do danych wrażliwych. Dane tożsamości i struktury firmy zostają w MonoriseCore (employee_id to pracownik Core).
-- Pola *_encrypted zawierają wyłącznie szyfrogram AES-256-GCM z kluczem spoza bazy (format v1.<klucz>.…).

-- CreateEnum
CREATE TYPE "public"."ContractType" AS ENUM ('PROBATION', 'FIXED_TERM', 'INDEFINITE', 'MANDATE', 'SPECIFIC_TASK', 'B2B');
CREATE TYPE "public"."SensitiveAccessAction" AS ENUM ('READ', 'UPDATE');

-- CreateTable
CREATE TABLE "public"."positions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "positions_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "positions_description_check" CHECK ("description" IS NULL OR char_length("description") <= 500)
);

CREATE TABLE "public"."employee_profiles" (
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "date_of_birth" DATE,
    "personal_email" TEXT,
    "personal_phone" TEXT,
    "home_address" JSONB,
    "mailing_address" JSONB,
    "emergency_contact" JSONB,
    "pesel_encrypted" TEXT,
    "bank_account_encrypted" TEXT,
    "id_document_encrypted" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_account_id" UUID,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("organization_id", "employee_id"),
    CONSTRAINT "employee_profiles_personal_email_check" CHECK ("personal_email" IS NULL OR char_length("personal_email") <= 254),
    CONSTRAINT "employee_profiles_personal_phone_check" CHECK ("personal_phone" IS NULL OR char_length("personal_phone") <= 40),
    CONSTRAINT "employee_profiles_home_address_check" CHECK ("home_address" IS NULL OR jsonb_typeof("home_address") = 'object'),
    CONSTRAINT "employee_profiles_mailing_address_check" CHECK ("mailing_address" IS NULL OR jsonb_typeof("mailing_address") = 'object'),
    CONSTRAINT "employee_profiles_emergency_contact_check" CHECK ("emergency_contact" IS NULL OR jsonb_typeof("emergency_contact") = 'object'),
    -- Dane wrażliwe tylko jako szyfrogram, nigdy jawnie
    CONSTRAINT "employee_profiles_pesel_encrypted_check" CHECK ("pesel_encrypted" IS NULL OR "pesel_encrypted" ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    CONSTRAINT "employee_profiles_bank_account_encrypted_check" CHECK ("bank_account_encrypted" IS NULL OR "bank_account_encrypted" ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    CONSTRAINT "employee_profiles_id_document_encrypted_check" CHECK ("id_document_encrypted" IS NULL OR "id_document_encrypted" ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

CREATE TABLE "public"."employment_contracts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "public"."ContractType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "fte_numerator" INTEGER,
    "fte_denominator" INTEGER,
    "position_id" UUID,
    "salary_encrypted" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_account_id" UUID NOT NULL,

    CONSTRAINT "employment_contracts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employment_contracts_dates_check" CHECK ("end_date" IS NULL OR "end_date" >= "start_date"),
    CONSTRAINT "employment_contracts_end_date_required_check" CHECK ("type" NOT IN ('PROBATION', 'FIXED_TERM') OR "end_date" IS NOT NULL),
    -- Wymiar etatu mają tylko umowy o pracę (0 < etat <= 1)
    CONSTRAINT "employment_contracts_fte_check" CHECK (
        ("type" IN ('PROBATION', 'FIXED_TERM', 'INDEFINITE')
            AND "fte_numerator" IS NOT NULL AND "fte_denominator" IS NOT NULL
            AND "fte_numerator" > 0 AND "fte_denominator" > 0 AND "fte_numerator" <= "fte_denominator")
        OR ("type" NOT IN ('PROBATION', 'FIXED_TERM', 'INDEFINITE')
            AND "fte_numerator" IS NULL AND "fte_denominator" IS NULL)
    ),
    CONSTRAINT "employment_contracts_notes_check" CHECK ("notes" IS NULL OR char_length("notes") <= 1000),
    CONSTRAINT "employment_contracts_salary_encrypted_check" CHECK ("salary_encrypted" IS NULL OR "salary_encrypted" ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

CREATE TABLE "public"."sensitive_access_log" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "action" "public"."SensitiveAccessAction" NOT NULL,
    "fields" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensitive_access_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sensitive_access_log_fields_check" CHECK (
        cardinality("fields") > 0
        AND "fields" <@ ARRAY['pesel', 'bankAccount', 'idDocumentNumber', 'salary']::TEXT[]
    )
);

-- CreateIndex
CREATE INDEX "positions_organization_id_archived_at_idx" ON "public"."positions"("organization_id", "archived_at");
CREATE UNIQUE INDEX "positions_organization_id_id_key" ON "public"."positions"("organization_id", "id");
-- Nazwa aktywnego stanowiska jest unikalna w firmie bez względu na wielkość liter
CREATE UNIQUE INDEX "positions_active_name_key" ON "public"."positions"("organization_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE INDEX "employment_contracts_organization_id_employee_id_start_date_idx" ON "public"."employment_contracts"("organization_id", "employee_id", "start_date");
CREATE UNIQUE INDEX "employment_contracts_organization_id_id_key" ON "public"."employment_contracts"("organization_id", "id");
CREATE INDEX "sensitive_access_log_org_employee_created_idx" ON "public"."sensitive_access_log"("organization_id", "employee_id", "created_at", "id");

-- AddForeignKey (złożony klucz: stanowisko zawsze z tej samej firmy, bo sprawdzanie FK omija RLS)
ALTER TABLE "public"."employment_contracts" ADD CONSTRAINT "employment_contracts_organization_id_position_id_fkey"
    FOREIGN KEY ("organization_id", "position_id") REFERENCES "public"."positions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Uprawnienia roli aplikacji ─────────────────────────────────────────────────────────────────────
-- Migracja początkowa nadaje domyślnie pełne prawa do nowych tabel, więc najpierw je odbieramy,
-- a potem nadajemy tylko potrzebne (stanowiska i kartoteki bez DELETE, dziennik bez UPDATE i DELETE).
REVOKE ALL ON "public"."positions", "public"."employee_profiles", "public"."employment_contracts", "public"."sensitive_access_log" FROM hira_hr_app;
GRANT SELECT, INSERT, UPDATE ON "public"."positions" TO hira_hr_app;
GRANT SELECT, INSERT, UPDATE ON "public"."employee_profiles" TO hira_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."employment_contracts" TO hira_hr_app;
-- Dziennik tylko do dopisywania: bez UPDATE i DELETE
GRANT SELECT, INSERT ON "public"."sensitive_access_log" TO hira_hr_app;

-- ── Separacja firm przez RLS (ADR-0037) ────────────────────────────────────────────────────────────
ALTER TABLE "public"."positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."positions" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."positions"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."employee_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."employee_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."employee_profiles"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."employment_contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."employment_contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."employment_contracts"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."sensitive_access_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sensitive_access_log" FORCE ROW LEVEL SECURITY;
-- Wpis zawsze w imieniu zalogowanej osoby z jej firmy
CREATE POLICY organization_isolation ON "public"."sensitive_access_log"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK (
        "organization_id" = "public"."current_organization_id"()
        AND "actor_account_id" = "public"."current_account_id"()
    );
