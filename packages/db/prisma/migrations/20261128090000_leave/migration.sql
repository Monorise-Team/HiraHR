-- Etap 2 HiraHR (ADR-0104): roczne salda urlopu i wnioski o nieobecność z akceptacją.
-- Dni pracy liczy serwer przy złożeniu wniosku (wymiar pracy z MonoriseCore i polskie święta ustawowe).

-- Ograniczenie EXCLUDE łączy równość (firma, osoba) z nakładaniem się zakresów dat
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "public"."LeaveType" AS ENUM ('VACATION', 'ON_DEMAND', 'OCCASIONAL', 'CHILDCARE', 'SICK', 'UNPAID', 'OTHER');
CREATE TYPE "public"."LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."leave_entitlements" (
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "base_days" INTEGER,
    "entitled_days" INTEGER NOT NULL,
    "carried_over_days" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "leave_entitlements_pkey" PRIMARY KEY ("organization_id", "employee_id", "year"),
    CONSTRAINT "leave_entitlements_year_check" CHECK ("year" BETWEEN 2000 AND 2100),
    CONSTRAINT "leave_entitlements_base_days_check" CHECK ("base_days" IS NULL OR "base_days" IN (20, 26)),
    CONSTRAINT "leave_entitlements_days_check" CHECK ("entitled_days" BETWEEN 0 AND 100 AND "carried_over_days" BETWEEN 0 AND 100),
    CONSTRAINT "leave_entitlements_notes_check" CHECK ("notes" IS NULL OR char_length("notes") <= 500)
);

CREATE TABLE "public"."leave_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "public"."LeaveType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "working_days" INTEGER NOT NULL,
    "status" "public"."LeaveStatus" NOT NULL,
    "note" TEXT,
    "decision_note" TEXT,
    "requested_by_account_id" UUID NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leave_requests_dates_check" CHECK ("end_date" >= "start_date"),
    CONSTRAINT "leave_requests_working_days_check" CHECK ("working_days" BETWEEN 1 AND 366),
    -- Urlop z puli wypoczynkowego nie przechodzi przez przełom roku (saldo jest roczne)
    CONSTRAINT "leave_requests_vacation_year_check" CHECK (
        "type" NOT IN ('VACATION', 'ON_DEMAND') OR date_part('year', "start_date") = date_part('year', "end_date")
    ),
    -- Decyzja ma autora i czas; oczekujący wniosek ich nie ma
    CONSTRAINT "leave_requests_decision_check" CHECK (
        ("status" = 'PENDING' AND "decided_at" IS NULL)
        OR ("status" IN ('APPROVED', 'REJECTED') AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL)
        OR "status" = 'CANCELLED'
    ),
    CONSTRAINT "leave_requests_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500),
    CONSTRAINT "leave_requests_decision_note_check" CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 500),
    -- Aktywne nieobecności jednej osoby nie mogą się nakładać (także przy dwóch wnioskach naraz)
    CONSTRAINT "leave_requests_no_overlap" EXCLUDE USING gist (
        "organization_id" WITH =,
        "employee_id" WITH =,
        daterange("start_date", "end_date", '[]') WITH &&
    ) WHERE ("status" IN ('PENDING', 'APPROVED'))
);

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_organization_id_id_key" ON "public"."leave_requests"("organization_id", "id");
CREATE INDEX "leave_requests_organization_id_employee_id_start_date_idx" ON "public"."leave_requests"("organization_id", "employee_id", "start_date");
CREATE INDEX "leave_requests_organization_id_status_start_date_idx" ON "public"."leave_requests"("organization_id", "status", "start_date");

-- ── Uprawnienia roli aplikacji ─────────────────────────────────────────────────────────────────────
-- Migracja początkowa nadaje domyślnie pełne prawa do nowych tabel; odbieramy je i nadajemy potrzebne
-- (bez DELETE: wnioski się anuluje albo odrzuca, a salda nadpisuje).
REVOKE ALL ON "public"."leave_entitlements", "public"."leave_requests" FROM hira_hr_app;
GRANT SELECT, INSERT, UPDATE ON "public"."leave_entitlements" TO hira_hr_app;
GRANT SELECT, INSERT, UPDATE ON "public"."leave_requests" TO hira_hr_app;

-- ── Separacja firm przez RLS (ADR-0037) ────────────────────────────────────────────────────────────
ALTER TABLE "public"."leave_entitlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."leave_entitlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."leave_entitlements"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."leave_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."leave_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."leave_requests"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());
