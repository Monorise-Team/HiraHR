import type { Capabilities } from "@hirahr/client";

export type AppView = "profile" | "people" | "leave" | "appearance";

export const VIEW_HASHES: Record<AppView, string> = {
  profile: "#moj-profil",
  people: "#ludzie",
  leave: "#urlopy",
  appearance: "#wyglad",
};

export const DEFAULT_NO_ACCESS_MESSAGE = "HiraHR nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.";

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  expired: "Sesja logowania wygasła. Spróbuj zalogować się ponownie.",
  denied: "Logowanie zostało przerwane.",
  unavailable: "Serwer logowania Monorise jest chwilowo niedostępny.",
  failed: "Nie udało się dokończyć logowania. Spróbuj ponownie.",
};

/**
 * Zwraca komunikat blokady, gdy konto nie ma dostępu do HiraHR. Samoobsługa (własna kartoteka, saldo
 * i wnioski) działa bez ról, więc do korzystania z aplikacji wystarcza dostęp do produktu (ADR-0104).
 * Zwraca `null`, gdy osoba może korzystać z aplikacji.
 */
export function resolveAccessDenialMessage(capabilities: Capabilities): string | null {
  if (!capabilities.hasProductAccess) {
    return DEFAULT_NO_ACCESS_MESSAGE;
  }
  return null;
}

/**
 * Zamienia fragment adresu (`#moj-profil`, `#ludzie`, `#urlopy`, `#wyglad`) na aktywny widok aplikacji.
 * Nieznany albo pusty fragment wraca do widoku „Mój profil”.
 */
export function parseViewFromHash(hash: string): AppView {
  const normalized = hash.trim().toLowerCase();
  if (normalized === VIEW_HASHES.appearance) return "appearance";
  if (normalized === VIEW_HASHES.people) return "people";
  if (normalized === VIEW_HASHES.leave) return "leave";
  return "profile";
}

/** Usuwa przedrostek `/app` (przepisanie na hoście aplikacji), zapytanie i fragment ze ścieżki. */
export function normalizeAppPathname(pathname: string): string {
  const clean = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (clean === "/app" || clean === "/app/") return "/";
  if (clean.startsWith("/app/")) return clean.slice(4);
  return clean || "/";
}

/** Bezpieczny adres powrotu po zalogowaniu: tylko ścieżka w tej aplikacji, nigdy `//host`. */
export function sanitizeReturnTo(pathname: string, search = ""): string {
  const normalized = normalizeAppPathname(pathname);
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    return "/";
  }
  return search ? `${normalized}${search.startsWith("?") ? search : `?${search}`}` : normalized;
}
