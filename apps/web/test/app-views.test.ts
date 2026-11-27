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

describe("trasy kartoteki", () => {
  it("rozpoznaje kartę osoby i stanowiska, a błędny identyfikator wraca do listy ludzi", async () => {
    const { parseRouteFromHash, personHash } = await import("@/app/app/app-views");
    const id = "01a20ff0-0000-7000-8000-00000000e001";
    expect(personHash(id)).toBe(`#osoba/${id}`);
    expect(parseRouteFromHash(`#osoba/${id}`)).toEqual({ view: "person", employeeId: id });
    expect(parseRouteFromHash("#osoba/nie-uuid")).toEqual({ view: "people", employeeId: null });
    expect(parseRouteFromHash("#stanowiska")).toEqual({ view: "positions", employeeId: null });
    expect(parseRouteFromHash("")).toEqual({ view: "profile", employeeId: null });
  });

  it("formatuje umowy, wynagrodzenia, adresy i rachunki po polsku", async () => {
    const ui = await import("@/app/app/people-ui");
    expect(ui.formatDate("2026-03-01")).toBe("1 marca 2026");
    expect(ui.formatContractPeriod("2026-01-01", null)).toBe("od 1 stycznia 2026");
    expect(ui.formatFte("1/1")).toBe("pełny etat");
    expect(ui.formatFte("1/2")).toBe("1/2 etatu");
    // Po polsku tysiące rozdziela się dopiero od pięciu cyfr (9200,00, ale 15 000,00)
    expect(ui.formatSalary({ amount: "9200.00", currency: "PLN", period: "MONTH" }).replace(/\s/g, " ")).toBe(
      "9200,00 zł brutto miesięcznie",
    );
    expect(ui.formatSalary({ amount: "15000", currency: "PLN", period: "HOUR" }).replace(/\s/g, " ")).toBe(
      "15 000,00 zł brutto za godzinę",
    );
    expect(ui.formatAddress({ street: "Długa 5/2", postalCode: "30-001", city: "Kraków", country: "Polska" })).toBe(
      "Długa 5/2, 30-001 Kraków",
    );
    expect(ui.formatIban("PL61109010140000071219812874")).toBe("PL61 1090 1014 0000 0712 1981 2874");
    expect(ui.formatSensitiveFields(["pesel", "salary"])).toBe("PESEL, wynagrodzenie");
  });
});
