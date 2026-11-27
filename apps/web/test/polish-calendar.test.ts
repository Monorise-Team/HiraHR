import { describe, expect, it } from "vitest";
import { countWorkingDays, easterSunday, polishHolidays } from "@/lib/polish-calendar";
import { suggestEntitledDays } from "@/server/leave-service";

describe("polskie dni ustawowo wolne", () => {
  it("liczy Wielkanoc i święta ruchome (Zielone Świątki, Boże Ciało)", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2025)).toBe("2025-04-20");
    const holidays2026 = polishHolidays(2026);
    expect(holidays2026.size).toBe(14);
    for (const day of ["2026-04-06", "2026-05-24", "2026-06-04", "2026-12-24", "2026-11-11"]) {
      expect(holidays2026.has(day)).toBe(true);
    }
  });
});

describe("dni pracy z wymiaru pracy", () => {
  it("pomija weekend i święta w tygodniu, a wylicza święta, które wypadły w dni pracy", () => {
    // 21–31 grudnia 2026: Wigilia (czwartek) i Boże Narodzenie (piątek) wolne, 26 grudnia to sobota
    expect(countWorkingDays("2026-12-21", "2026-12-31", null)).toEqual({
      workingDays: 7,
      holidays: ["2026-12-24", "2026-12-25"],
    });
  });

  it("korzysta z wymiaru pracy z Core (np. 3 dni w tygodniu), a pusty wymiar zastępuje poniedziałkiem–piątkiem", () => {
    const partTime = { "1": 480, "2": 480, "3": 240 };
    // 4–10 stycznia 2027: Trzech Króli wypada w środę
    expect(countWorkingDays("2027-01-04", "2027-01-10", partTime)).toEqual({
      workingDays: 2,
      holidays: ["2027-01-06"],
    });
    expect(countWorkingDays("2027-01-04", "2027-01-10", { "1": 0, "6": 0 }).workingDays).toBe(4);
    expect(countWorkingDays("2027-01-09", "2027-01-10", null).workingDays).toBe(0);
  });
});

describe("podpowiedź wymiaru urlopu", () => {
  it("dzieli podstawę przez etat i zaokrągla w górę, bez umowy o pracę nic nie podpowiada", () => {
    expect(suggestEntitledDays(26, { fteNumerator: 1, fteDenominator: 1 })).toBe(26);
    expect(suggestEntitledDays(26, { fteNumerator: 1, fteDenominator: 2 })).toBe(13);
    expect(suggestEntitledDays(20, { fteNumerator: 3, fteDenominator: 4 })).toBe(15);
    expect(suggestEntitledDays(26, { fteNumerator: 3, fteDenominator: 4 })).toBe(20);
    expect(suggestEntitledDays(20, null)).toBeNull();
    expect(suggestEntitledDays(null, { fteNumerator: 1, fteDenominator: 1 })).toBeNull();
  });

  it("interfejs liczy tę samą podpowiedź z etatu zapisanego jako ułamek", async () => {
    const ui = await import("@/app/app/leave-ui");
    expect(ui.suggestEntitledDays(26, "3/4")).toBe(20);
    expect(ui.suggestEntitledDays(20, "1/1")).toBe(20);
    expect(ui.suggestEntitledDays(20, null)).toBeNull();
    expect(ui.formatDays(1)).toBe("1 dzień");
    expect(ui.formatDays(5)).toBe("5 dni");
    expect(ui.formatLeavePeriod("2098-08-04", "2098-08-08")).toBe("4 sierpnia – 8 sierpnia 2098");
    expect(ui.formatLeavePeriod("2098-12-30", "2099-01-03")).toBe("30 grudnia 2098 – 3 stycznia 2099");
    expect(ui.monthRange(2028, 2).days).toHaveLength(29);
    expect(ui.shiftMonth({ year: 2026, month: 12 }, 1)).toMatchObject({ year: 2027, month: 1, from: "2027-01-01" });
  });
});
