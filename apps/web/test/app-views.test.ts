import type { Capabilities } from "@hirahr/client";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NO_ACCESS_MESSAGE,
  normalizeAppPathname,
  parseViewFromHash,
  resolveAccessDenialMessage,
  sanitizeReturnTo,
} from "@/app/app/app-views";

const NO_PERMISSIONS: Capabilities = {
  hasProductAccess: false,
  readEmployees: false,
  updateEmployees: false,
  readSensitive: false,
  updateSensitive: false,
  requestLeave: false,
  approveLeave: false,
  manageLeave: false,
  readDocuments: false,
  manageDocuments: false,
  manageSettings: false,
};

describe("rozpoznawanie widoku z fragmentu adresu (hash)", () => {
  it("domyślnie i dla nieznanych fragmentów wybiera widok Mój profil", () => {
    expect(parseViewFromHash("")).toBe("profile");
    expect(parseViewFromHash("#moj-profil")).toBe("profile");
    expect(parseViewFromHash("#nieznany")).toBe("profile");
  });

  it("rozpoznaje widoki Ludzie, Urlopy i Wygląd niezależnie od wielkości liter", () => {
    expect(parseViewFromHash("#ludzie")).toBe("people");
    expect(parseViewFromHash("#LUDZIE")).toBe("people");
    expect(parseViewFromHash("#urlopy")).toBe("leave");
    expect(parseViewFromHash("#wyglad")).toBe("appearance");
    expect(parseViewFromHash(" #WYGLAD ")).toBe("appearance");
  });
});

describe("stan dostępu do aplikacji na podstawie capabilities", () => {
  it("blokuje dostęp, gdy konto nie ma włączonego produktu HiraHR", () => {
    expect(resolveAccessDenialMessage(NO_PERMISSIONS)).toBe(DEFAULT_NO_ACCESS_MESSAGE);
  });

  it("wpuszcza osobę z dostępem do produktu nawet bez ról, bo samoobsługa nie wymaga uprawnień (ADR-0104)", () => {
    expect(resolveAccessDenialMessage({ ...NO_PERMISSIONS, hasProductAccess: true })).toBeNull();
    expect(
      resolveAccessDenialMessage({
        ...NO_PERMISSIONS,
        hasProductAccess: true,
        readEmployees: true,
        approveLeave: true,
        requestLeave: true,
      }),
    ).toBeNull();
  });
});

describe("adres powrotu po zalogowaniu", () => {
  it("usuwa przedrostek /app i zostawia tylko ścieżkę w aplikacji", () => {
    expect(normalizeAppPathname("/app")).toBe("/");
    expect(normalizeAppPathname("/app/ludzie?x=1#y")).toBe("/ludzie");
    expect(sanitizeReturnTo("/app/ludzie", "x=1")).toBe("/ludzie?x=1");
  });

  it("nigdy nie pozwala wrócić na inny host", () => {
    expect(sanitizeReturnTo("//evil.example")).toBe("/");
    expect(sanitizeReturnTo("https://evil.example/")).toBe("/");
  });
});
