import { describe, expect, it } from "vitest";
import { decryptWith, encryptWith, generateKeyEntry, parseKeyring } from "@/server/field-encryption";
import { scopeCoversPerson } from "@/server/people-access";
import { normalizeForSearch, todayInPoland } from "@/server/people-service";

const context = { organizationId: "org-1", recordId: "emp-1", field: "pesel" };

describe("szyfrowanie pól wrażliwych (AES-256-GCM)", () => {
  it("szyfruje losowo i odszyfrowuje tylko z tym samym kontekstem (firma, rekord, pole)", () => {
    const ring = parseKeyring([generateKeyEntry("k1")])!;
    const first = encryptWith(ring, "90010112318", context);
    const second = encryptWith(ring, "90010112318", context);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toContain("90010112318");
    expect(decryptWith(ring, first, context)).toBe("90010112318");

    // Szyfrogram przeniesiony do innej osoby, pola albo firmy się nie odszyfruje
    expect(() => decryptWith(ring, first, { ...context, recordId: "emp-2" })).toThrow();
    expect(() => decryptWith(ring, first, { ...context, field: "bankAccount" })).toThrow();
    expect(() => decryptWith(ring, first, { ...context, organizationId: "org-2" })).toThrow();

    // Zmieniony bajt szyfrogramu wykrywa znacznik GCM
    const parts = first.split(".");
    const tampered = [...parts.slice(0, 3), `${parts[3]!.slice(0, -2)}AA`, parts[4]].join(".");
    expect(() => decryptWith(ring, tampered, context)).toThrow();
  });

  it("po wymianie klucza szyfruje nowym, a stare wartości nadal odczytuje", () => {
    const oldEntry = generateKeyEntry("k1");
    const oldRing = parseKeyring([oldEntry])!;
    const stored = encryptWith(oldRing, "PL61109010140000071219812874", context);
    const rotated = parseKeyring([generateKeyEntry("k2"), oldEntry])!;
    expect(rotated.activeKeyId).toBe("k2");
    expect(decryptWith(rotated, stored, context)).toBe("PL61109010140000071219812874");
    expect(encryptWith(rotated, "x", context)).toMatch(/^v1\.k2\./);
    expect(() => decryptWith(parseKeyring([generateKeyEntry("k3")])!, stored, context)).toThrow();
  });

  it("odrzuca błędną konfigurację kluczy bez ujawniania ich treści", () => {
    expect(parseKeyring([])).toBeNull();
    expect(() => parseKeyring(["k1:krotki"])).toThrow(/32 bajtami/);
    expect(() => parseKeyring(["bez-dwukropka"])).toThrow();
    const entry = generateKeyEntry("k1");
    expect(() => parseKeyring([entry, entry])).toThrow(/Powtórzony/);
    try {
      parseKeyring([`k1:${Buffer.alloc(16).toString("base64")}`]);
    } catch (error) {
      expect(String(error)).not.toContain(Buffer.alloc(16).toString("base64"));
    }
  });
});

describe("zasięg kartotek i wyszukiwanie", () => {
  it("zakres firmy obejmuje wszystkich, jednostek tylko członków, RESOURCE pojedyncze osoby", () => {
    expect(scopeCoversPerson({ type: "ORGANIZATION" }, "e1", [])).toBe(true);
    expect(scopeCoversPerson({ type: "NONE" }, "e1", ["u1"])).toBe(false);
    const limited = { type: "LIMITED" as const, unitIds: ["u1"], resourceIds: ["e9"] };
    expect(scopeCoversPerson(limited, "e1", ["u1", "u2"])).toBe(true);
    expect(scopeCoversPerson(limited, "e1", ["u2"])).toBe(false);
    expect(scopeCoversPerson(limited, "e9", [])).toBe(true);
  });

  it("szuka bez polskich znaków i liczy dzisiejszą datę według Polski", () => {
    expect(normalizeForSearch("Żółkiewski Łukasz")).toBe("zolkiewski lukasz");
    // 23:30 UTC 31 grudnia to już 1 stycznia w Polsce
    expect(todayInPoland(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});
