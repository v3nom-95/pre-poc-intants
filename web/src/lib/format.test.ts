import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatFH,
  formatIsoDatesInText,
  formatMonth,
  formatNumber,
  formatPct,
  formatRemaining,
} from "./format";

// SPEC 0 rule 6: dates as "16 Nov 2026", thousands separators, units always shown.
describe("date formatting", () => {
  it("formats ISO dates as day, short month, year", () => {
    expect(formatDate("2026-11-16")).toBe("16 Nov 2026");
    expect(formatDate("2026-11-15")).toBe("15 Nov 2026");
    expect(formatDate("2027-01-01")).toBe("1 Jan 2027");
    expect(formatDate("2024-02-29")).toBe("29 Feb 2024");
  });

  it("never shifts the day for viewers west of UTC (reads UTC fields)", () => {
    expect(formatDate(new Date(Date.UTC(2026, 10, 15)))).toBe("15 Nov 2026");
    expect(formatDate(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe("31 Dec 2026");
  });

  it("uses no leading zero, no comma and no dashes", () => {
    const s = formatDate("2026-03-05");
    expect(s).toBe("5 Mar 2026");
    expect(s).not.toMatch(/[,–—]/);
  });

  it("formats months and rewrites ISO dates embedded in exported text", () => {
    expect(formatMonth("2026-11")).toBe("Nov 2026");
    expect(formatMonth("not-a-month")).toBe("not-a-month");
    expect(formatIsoDatesInText("Replace by 2027-04-02, review 2026-12-01")).toBe(
      "Replace by 2 Apr 2027, review 1 Dec 2026"
    );
  });
});

describe("numbers and units", () => {
  it("uses thousands separators", () => {
    expect(formatNumber(1240)).toBe("1,240");
    expect(formatNumber(1240.456, 1)).toBe("1,240.5");
    expect(formatFH(1240)).toBe("1,240 FH");
    expect(formatPct(81.25, 1)).toBe("81.3%");
  });

  it("shows hard-time remaining life in the governing limit's own unit", () => {
    expect(formatRemaining(3, "Calendar")).toBe("3.0 months");
    expect(formatRemaining(0.5, "Calendar")).toBe("15 days");
    expect(formatRemaining(1210, "FH")).toBe("1,210 FH");
    expect(formatRemaining(40, "EFH")).toBe("40 EFH");
    expect(formatRemaining(24, "Cycles")).toBe("24 LCF cycles");
    expect(formatRemaining(120, "Landings")).toBe("120 landings");
    expect(formatRemaining(300, "APU hours")).toBe("300 APU hours");
  });
});
