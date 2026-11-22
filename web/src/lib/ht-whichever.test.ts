import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { computeScenario } from "./model-math";
import type { Scenario, WhatifData, WhatifHtItem } from "./whatif-types";

// SPEC 1 and 5.1: hard-time items are due at whichever limit comes first.
// In the what-if (SPEC 8.6) usage limits (FH, EFH, cycles, landings) move with
// utilisation while calendar limits do not, so the governing limit can change.

const DATA = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public", "data", "whatif.json"), "utf-8")
) as WhatifData;

function scenario(over: Partial<Scenario>): Scenario {
  return { ...DATA.default_scenario, horizon_months: 12, ...over };
}

function expectedDue(item: WhatifHtItem, mult: number) {
  let best = Infinity;
  let gov: string | null = null;
  for (const lim of item.limits) {
    const d = lim.scales_with_use ? lim.baseline_days / mult : lim.baseline_days;
    if (d < best) {
      best = d;
      gov = lim.governing;
    }
  }
  return { days: best, governing: gov };
}

describe("hard time, whichever comes first (what-if)", () => {
  it("has real multi-limit items to exercise", () => {
    expect(DATA.ht_items.length).toBeGreaterThan(0);
    expect(DATA.ht_items.some((it) => it.limits.length > 1)).toBe(true);
  });

  for (const [label, util] of [
    ["baseline", 0],
    ["utilisation plus 50%", 50],
    ["utilisation minus 30%", -30],
  ] as const) {
    it(`every due item takes its soonest limit (${label})`, () => {
      const result = computeScenario(DATA, scenario({ utilisation_change_pct: util, utilisation_type: "all" }));
      const mult = 1 + util / 100;
      const byKey = new Map(DATA.ht_items.map((it) => [`${it.tail}|${it.serial}`, it]));
      for (const due of result.ht_due) {
        const item = byKey.get(`${due.tail}|${due.serial}`)!;
        expect(item, `${due.tail} ${due.serial}`).toBeDefined();
        const exp = expectedDue(item, mult);
        expect(due.governing).toBe(exp.governing);
        expect(Math.abs(due.days_to_due - exp.days)).toBeLessThanOrEqual(1e-9);
      }
    });
  }

  it("raising utilisation brings usage limits forward but never calendar limits", () => {
    const base = computeScenario(DATA, scenario({ utilisation_change_pct: 0 }));
    const busy = computeScenario(DATA, scenario({ utilisation_change_pct: 50, utilisation_type: "all" }));
    expect(busy.ht_due.length).toBeGreaterThanOrEqual(base.ht_due.length);
    const baseDays = new Map(base.ht_due.map((d) => [`${d.tail}|${d.serial}`, d.days_to_due]));
    for (const d of busy.ht_due) {
      const before = baseDays.get(`${d.tail}|${d.serial}`);
      if (before !== undefined) expect(d.days_to_due).toBeLessThanOrEqual(before + 1e-9);
    }
  });

  it("switches the governing limit when usage overtakes the calendar", () => {
    const tail = DATA.aircraft[0].tail;
    const synthetic: WhatifHtItem = {
      tail,
      type: DATA.aircraft[0].type,
      serial: "ZZ-9999",
      part_number: "32-0000-00",
      position: "1",
      component: "Test item",
      limits: [
        { governing: "Landings", remaining: 100, baseline_days: 120, scales_with_use: true },
        { governing: "Calendar", remaining: 3.3, baseline_days: 100, scales_with_use: false },
      ],
      man_hours: 1,
    };
    const data: WhatifData = { ...DATA, ht_items: [synthetic] };
    const at = (util: number) =>
      computeScenario(data, { ...scenario({ utilisation_change_pct: util, utilisation_type: "all" }) }).ht_due[0];

    expect(at(0).governing).toBe("Calendar");
    expect(at(0).days_to_due).toBeCloseTo(100, 9);
    // 120 days / 1.5 = 80 days: the landings limit now comes first.
    expect(at(50).governing).toBe("Landings");
    expect(at(50).days_to_due).toBeCloseTo(80, 9);
    // Flying less pushes usage out; the calendar limit still governs at 100 days.
    expect(at(-30).governing).toBe("Calendar");
    expect(at(-30).days_to_due).toBeCloseTo(100, 9);
  });
});
