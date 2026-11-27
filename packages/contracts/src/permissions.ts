import { definePermissions, type PermissionKeyOf } from "@monorise-team/permissions";

/**
 * Uprawnienia HiraHR deklarowane w kodzie produktu (ADR-0036, ADR-0104, karta produktu HiraHR).
 * Manifest i gotowe role są rejestrowane w MonoriseCore poleceniem `pnpm permissions:register`.
 * Zakres (`ORGANIZATION` albo jednostki Core) ogranicza, czyje kartoteki, wnioski i dokumenty widać.
 * `sensitive.*` HiraHR uznaje wyłącznie w zakresie całej firmy (ADR-0033, ADR-0104).
 */
export const HIRAHR_PERMISSIONS = definePermissions("hirahr", {
  "employees.read": "Podgląd kartotek pracowników w dostępnych jednostkach, bez danych wrażliwych",
  "employees.update": "Edycja kartotek, umów i stanowisk pracowników w dostępnych jednostkach",
  "sensitive.read": "Podgląd danych wrażliwych (PESEL, rachunek, wynagrodzenie); tylko w zakresie całej firmy",
  "sensitive.update": "Edycja danych wrażliwych (PESEL, rachunek, wynagrodzenie); tylko w zakresie całej firmy",
  "leave.request": "Składanie własnych wniosków urlopowych",
  "leave.approve": "Akceptacja wniosków urlopowych w dostępnych jednostkach",
  "leave.manage": "Rodzaje nieobecności, salda i korekty urlopów",
  "documents.read": "Podgląd akt osobowych w dostępnych jednostkach",
  "documents.manage": "Dodawanie i usuwanie dokumentów w aktach osobowych",
  "settings.manage": "Ustawienia HiraHR: stanowiska i polityki urlopowe",
});

export const HIRAHR_PERMISSION_MANIFEST = HIRAHR_PERMISSIONS.manifest;

export type HirahrPermissionKey = PermissionKeyOf<typeof HIRAHR_PERMISSIONS>;

/** Uprawnienia, które HiraHR uznaje tylko przy zakresie całej firmy (`ORGANIZATION`). */
export const HIRAHR_ORGANIZATION_ONLY_PERMISSIONS: readonly HirahrPermissionKey[] = [
  HIRAHR_PERMISSIONS.keys["sensitive.read"],
  HIRAHR_PERMISSIONS.keys["sensitive.update"],
];

export interface HirahrRoleTemplate {
  readonly key: `hirahr.${string}`;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly [HirahrPermissionKey, ...HirahrPermissionKey[]];
}

/**
 * Gotowe role (szablony) HiraHR wysyłane do MonoriseCore zaraz po manifeście uprawnień (ADR-0033, ADR-0036).
 * Samoobsługa (własna kartoteka, saldo i wnioski) działa dla każdej osoby z dostępem do HiraHR bez ról.
 */
export const HIRAHR_ROLE_TEMPLATES = [
  {
    key: "hirahr.employee",
    name: "Pracownik",
    description: "Składa własne wnioski urlopowe i przegląda swoją kartotekę",
    permissions: [HIRAHR_PERMISSIONS.keys["leave.request"]],
  },
  {
    key: "hirahr.manager",
    name: "Kierownik",
    description: "Przegląda kartoteki i akceptuje wnioski urlopowe w swoich jednostkach",
    permissions: [
      HIRAHR_PERMISSIONS.keys["employees.read"],
      HIRAHR_PERMISSIONS.keys["leave.request"],
      HIRAHR_PERMISSIONS.keys["leave.approve"],
    ],
  },
  {
    key: "hirahr.hr",
    name: "Kadry",
    description:
      "Prowadzi kartoteki, urlopy, dokumenty i ustawienia; dane wrażliwe tylko przy przypisaniu w zakresie całej firmy",
    permissions: [
      HIRAHR_PERMISSIONS.keys["employees.read"],
      HIRAHR_PERMISSIONS.keys["employees.update"],
      HIRAHR_PERMISSIONS.keys["sensitive.read"],
      HIRAHR_PERMISSIONS.keys["sensitive.update"],
      HIRAHR_PERMISSIONS.keys["leave.request"],
      HIRAHR_PERMISSIONS.keys["leave.approve"],
      HIRAHR_PERMISSIONS.keys["leave.manage"],
      HIRAHR_PERMISSIONS.keys["documents.read"],
      HIRAHR_PERMISSIONS.keys["documents.manage"],
      HIRAHR_PERMISSIONS.keys["settings.manage"],
    ],
  },
] as const satisfies readonly HirahrRoleTemplate[];
