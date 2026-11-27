import "server-only";
import {
  can,
  createPermissionCache,
  scopeOf,
  type AccessScope,
  type PermissionCacheFilter,
  type PermissionSnapshot,
} from "@monorise-team/permissions";
import { HIRAHR_PERMISSIONS, type Capabilities, type HirahrPermissionKey } from "@hirahr/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getMachineCoreClient } from "./core";

/**
 * Komunikat zwracany, gdy produkt `hirahr` nie znajduje się w `snapshot.products` (brak dostępu firmy
 * albo brak włączonego HiraHR na koncie; z samej migawki nie da się tych sytuacji rozróżnić).
 */
export const PRODUCT_ACCESS_REQUIRED_MESSAGE =
  "HiraHR nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.";

type PermissionCache = ReturnType<typeof createPermissionCache>;

/**
 * Jedna pamięć na proces. Next.js wczytuje `instrumentation.ts` (pobieranie zdarzeń z Core) i trasy API
 * jako osobne kopie modułów, więc zwykła zmienna modułu dałaby dwie różne pamięci: zdarzenie czyściłoby
 * nie tę, z której korzystają trasy.
 */
const processGlobal = globalThis as typeof globalThis & { __hirahrPermissionCache?: PermissionCache };
const permissionCache = (processGlobal.__hirahrPermissionCache ??= createPermissionCache({
  load: ({ organizationId, accountId }) =>
    getMachineCoreClient().getProductPermissionSnapshot({
      path: { productKey: HIRAHR_PERMISSIONS.product },
      query: { organizationId, accountId },
    }),
}));

/**
 * Pobiera migawkę uprawnień z pamięci podręcznej (5 min, odświeżana od razu przy wyższym `authz_rev`).
 * `organizationId`, `accountId` i `authzRevision` pochodzą wyłącznie ze zweryfikowanego tokenu/sesji.
 */
export function getPermissionSnapshot(caller: Caller): Promise<PermissionSnapshot> {
  return permissionCache.get({
    organizationId: caller.organizationId,
    accountId: caller.accountId,
    authzRevision: caller.context.authzRevision,
  });
}

/** Czyści pamięć podręczną migawek uprawnień (np. w testach lub po zdarzeniu zmiany uprawnień). */
export function invalidatePermissionCache(filter?: PermissionCacheFilter): void {
  permissionCache.invalidate(filter);
}

export function assertProductAccess(snapshot: PermissionSnapshot): void {
  if (!snapshot.products.includes(HIRAHR_PERMISSIONS.product)) {
    throw new ApiFailure(403, "PRODUCT_ACCESS_REQUIRED", PRODUCT_ACCESS_REQUIRED_MESSAGE);
  }
}

/**
 * Wylicza możliwości widoczne w interfejsie HiraHR na podstawie migawki uprawnień z Core.
 */
export function capabilitiesFromSnapshot(snapshot: PermissionSnapshot): Capabilities {
  const keys = HIRAHR_PERMISSIONS.keys;
  return {
    hasProductAccess: snapshot.products.includes(HIRAHR_PERMISSIONS.product),
    readEmployees: can(snapshot, keys["employees.read"]),
    updateEmployees: can(snapshot, keys["employees.update"]),
    readSensitive: canOrganizationWide(snapshot, keys["sensitive.read"]),
    updateSensitive: canOrganizationWide(snapshot, keys["sensitive.update"]),
    requestLeave: can(snapshot, keys["leave.request"]),
    approveLeave: can(snapshot, keys["leave.approve"]),
    manageLeave: can(snapshot, keys["leave.manage"]),
    readDocuments: can(snapshot, keys["documents.read"]),
    manageDocuments: can(snapshot, keys["documents.manage"]),
    manageSettings: can(snapshot, keys["settings.manage"]),
  };
}

/**
 * Czy uprawnienie obowiązuje w zakresie całej firmy (`ORGANIZATION`). Dane wrażliwe (`sensitive.*`)
 * HiraHR uznaje tylko w takim zakresie: przypisanie ograniczone do jednostek nie daje dostępu (ADR-0104).
 */
export function canOrganizationWide(snapshot: PermissionSnapshot, permission: HirahrPermissionKey): boolean {
  return (
    snapshot.products.includes(HIRAHR_PERMISSIONS.product) && scopeOf(snapshot, permission).type === "ORGANIZATION"
  );
}

/**
 * Wymaga uprawnienia w zakresie całej firmy (`403 PERMISSION_DENIED` przy zakresie ograniczonym albo braku).
 * Używane dla danych wrażliwych (`hirahr.sensitive.*`).
 */
export async function assertOrganizationWidePermission(
  caller: Caller,
  permission: HirahrPermissionKey,
): Promise<PermissionSnapshot> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  if (!canOrganizationWide(snapshot, permission)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
  return snapshot;
}

/** Zwraca możliwości zalogowanej osoby dla trasy `GET /api/v1/me`. */
export async function getUserCapabilities(caller: Caller): Promise<Capabilities> {
  const snapshot = await getPermissionSnapshot(caller);
  return capabilitiesFromSnapshot(snapshot);
}

/**
 * Jedyny punkt sprawdzania uprawnień po stronie serwera HiraHR (ADR-0036).
 * Sprawdza obecność produktu `hirahr` w migawce (`403 PRODUCT_ACCESS_REQUIRED`)
 * oraz wskazane uprawnienie (`403 PERMISSION_DENIED`).
 */
export async function assertPermission(caller: Caller, permission: HirahrPermissionKey): Promise<PermissionSnapshot> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  if (!can(snapshot, permission)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
  return snapshot;
}

/**
 * Zwraca efektywny zakres uprawnienia (`ORGANIZATION` albo `LIMITED`: `unitIds` / `resourceIds`).
 * Brak produktu daje `403 PRODUCT_ACCESS_REQUIRED`, a zakres `NONE` daje `403 PERMISSION_DENIED`.
 */
export async function assertPermissionScope(
  caller: Caller,
  permission: HirahrPermissionKey,
): Promise<Exclude<AccessScope, { type: "NONE" }>> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const scope = scopeOf(snapshot, permission);
  if (scope.type === "NONE") {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
  return scope;
}
