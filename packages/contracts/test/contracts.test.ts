import { permissionKeySchema, permissionManifestSchema } from "@monorise-team/permissions";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorResponse,
  apiSuccessSchema,
  ERROR_CODES,
  Health,
  HIRAHR_ORGANIZATION_ONLY_PERMISSIONS,
  HIRAHR_PERMISSION_MANIFEST,
  HIRAHR_PERMISSIONS,
  HIRAHR_ROLE_TEMPLATES,
  Me,
} from "../src/index.js";

/** Minimalny schemat żądania `PUT /core/v1/products/{productKey}/role-templates` zgodny z MonoriseCore. */
const CoreRoleTemplateKey = z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/);
const CoreRoleTemplateEntry = z.object({
  key: CoreRoleTemplateKey,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).nullable().optional(),
  permissions: z
    .array(permissionKeySchema)
    .min(1)
    .max(200)
    .refine((keys) => new Set(keys).size === keys.length, "Zduplikowane klucze uprawnień w roli"),
});
const CoreRegisterRoleTemplatesRequest = z
  .array(CoreRoleTemplateEntry)
  .max(100)
  .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length, "Zduplikowane klucze ról");

describe("manifest uprawnień HiraHR", () => {
  it("spełnia schemat manifestu z @monorise-team/permissions", () => {
    const parsed = permissionManifestSchema.parse(HIRAHR_PERMISSION_MANIFEST);
    expect(parsed).toHaveLength(10);
    expect(HIRAHR_PERMISSIONS.product).toBe("hirahr");
  });

  it("zawiera wszystkie uprawnienia HiraHR i opisy po polsku", () => {
    expect(Object.values(HIRAHR_PERMISSIONS.keys)).toEqual([
      "hirahr.employees.read",
      "hirahr.employees.update",
      "hirahr.sensitive.read",
      "hirahr.sensitive.update",
      "hirahr.leave.request",
      "hirahr.leave.approve",
      "hirahr.leave.manage",
      "hirahr.documents.read",
      "hirahr.documents.manage",
      "hirahr.settings.manage",
    ]);
    expect(HIRAHR_ORGANIZATION_ONLY_PERMISSIONS).toEqual(["hirahr.sensitive.read", "hirahr.sensitive.update"]);
    for (const entry of HIRAHR_PERMISSION_MANIFEST) {
      expect(entry.key.startsWith("hirahr.")).toBe(true);
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });
});

describe("gotowe role (szablony) HiraHR", () => {
  it("spełniają schemat żądania MonoriseCore i mają prefiks hirahr.", () => {
    const parsed = CoreRegisterRoleTemplatesRequest.parse(HIRAHR_ROLE_TEMPLATES);
    expect(parsed).toHaveLength(3);
    for (const template of parsed) {
      expect(template.key.startsWith("hirahr.")).toBe(true);
    }
  });

  it("odwołują się wyłącznie do uprawnień z manifestu HiraHR", () => {
    const manifestKeys = new Set<string>(HIRAHR_PERMISSION_MANIFEST.map((entry) => entry.key));
    for (const template of HIRAHR_ROLE_TEMPLATES) {
      for (const permission of template.permissions) {
        expect(manifestKeys.has(permission)).toBe(true);
      }
    }
  });

  it("definiują role Pracownik, Kierownik i Kadry z oczekiwanymi uprawnieniami", () => {
    const byKey = new Map<string, (typeof HIRAHR_ROLE_TEMPLATES)[number]>(
      HIRAHR_ROLE_TEMPLATES.map((template) => [template.key, template]),
    );

    expect(byKey.get("hirahr.employee")?.name).toBe("Pracownik");
    expect(byKey.get("hirahr.employee")?.permissions).toEqual(["hirahr.leave.request"]);

    expect(byKey.get("hirahr.manager")?.name).toBe("Kierownik");
    expect(byKey.get("hirahr.manager")?.permissions).toEqual([
      "hirahr.employees.read",
      "hirahr.leave.request",
      "hirahr.leave.approve",
    ]);

    // Kadry mają wszystkie uprawnienia; dane wrażliwe działają tylko w zakresie całej firmy (ADR-0104)
    expect(byKey.get("hirahr.hr")?.name).toBe("Kadry");
    expect([...(byKey.get("hirahr.hr")?.permissions ?? [])].sort()).toEqual(
      HIRAHR_PERMISSION_MANIFEST.map((entry) => entry.key).sort(),
    );

    // Pracownik i Kierownik nigdy nie dostają danych wrażliwych ani dokumentów
    for (const key of ["hirahr.employee", "hirahr.manager"]) {
      const permissions: readonly string[] = byKey.get(key)?.permissions ?? [];
      expect(permissions.some((permission) => permission.startsWith("hirahr.sensitive."))).toBe(false);
      expect(permissions.some((permission) => permission.startsWith("hirahr.documents."))).toBe(false);
    }
  });
});

describe("schematy kopert API i profilu Me", () => {
  it("waliduje capabilities w Me", () => {
    const meParsed = Me.parse({
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
    });
    expect(meParsed.capabilities).toEqual({
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
    });
  });

  it("zawiera PRODUCT_ACCESS_REQUIRED oraz waliduje koperty sukcesu i błędu", () => {
    expect(ERROR_CODES).toContain("PRODUCT_ACCESS_REQUIRED");
    expect(
      ApiErrorResponse.parse({
        data: null,
        meta: { requestId: "req_123" },
        error: { code: "PRODUCT_ACCESS_REQUIRED", message: "Brak dostępu", details: [] },
      }).error.code,
    ).toBe("PRODUCT_ACCESS_REQUIRED");

    const healthEnvelope = apiSuccessSchema(Health).parse({
      data: { status: "ok", version: "0.0.0" },
      meta: { requestId: "req_123" },
      error: null,
    });
    expect(healthEnvelope.data.status).toBe("ok");
  });
});
