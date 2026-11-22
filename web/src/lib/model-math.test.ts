import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  addDaysIso,
  aftLambda,
  computeScenario,
  conditionalFailureProb,
  defaultScenario,
  pbQuantile,
  poissonBinomial,
  weibullSurvival,
} from "./model-math";
import type { WhatifData } from "./whatif-types";

const DATA = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public", "data", "whatif.json"), "utf-8")
) as WhatifData;

const TOL = 1e-6;

function expectClose(actual: unknown, expected: unknown, where: string) {
  if (typeof expected === "number") {
    expect(typeof actual, where).toBe("number");
    expect(Math.abs((actual as number) - expected), `${where}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOL);
  } else if (expected === null) {
    expect(actual, where).toBeNull();
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), where).toBe(true);
    expect((actual as unknown[]).length, `${where} length`).toBe(expected.length);
    expected.forEach((e, i) => expectClose((actual as unknown[])[i], e, `${where}[${i}]`));
  } else if (typeof expected === "object") {
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(expected as object)) {
      expectClose(a[k], (expected as Record<string, unknown>)[k], `${where}.${k}`);
    }
  } else {
    expect(actual, where).toBe(expected);
  }
}

describe("Weibull AFT maths", () => {
  it("survival is 1 at t=0 and exp(-1) at the scale", () => {
    expect(weibullSurvival(0, 1000, 1.8)).toBe(1);
    expect(Math.abs(weibullSurvival(1000, 1000, 1.8) - Math.exp(-1))).toBeLessThan(1e-12);
  });

  it("conditional failure probability equals 1 - S(t+h)/S(t)", () => {
    const [t, lam, rho, h] = [800, 1400, 1.8, 150];
    const direct = 1 - weibullSurvival(t + h, lam, rho) / weibullSurvival(t, lam, rho);
    expect(Math.abs(conditionalFailureProb(t, lam, rho, h) - direct)).toBeLessThan(1e-12);
  });

  it("rho = 1 is memoryless", () => {
    const a = conditionalFailureProb(0, 5000, 1, 100);
    const b = conditionalFailureProb(3000, 5000, 1, 100);
    expect(Math.abs(a - b)).toBeLessThan(1e-12);
  });

  it("lambda applies covariates in the log scale", () => {
    const par = { rho: 2, intercept: 7, covariates: ["hot_share"], coefficients: { hot_share: -1 } };
    expect(Math.abs(aftLambda(par, { hot_share: 0.5 }) - Math.exp(6.5))).toBeLessThan(1e-9);
  });
});

describe("Poisson-binomial", () => {
  it("sums to 1 and its mean equals the sum of probabilities", () => {
    const probs = [0.1, 0.5, 0.9, 0.25, 0.03];
    const dist = poissonBinomial(probs);
    expect(dist.length).toBe(probs.length + 1);
    expect(Math.abs(dist.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-12);
    const mean = dist.reduce((a, p, k) => a + k * p, 0);
    expect(Math.abs(mean - probs.reduce((a, b) => a + b, 0))).toBeLessThan(1e-12);
  });

  it("matches the binomial when all probabilities are equal", () => {
    const dist = poissonBinomial([0.3, 0.3, 0.3]);
    expect(Math.abs(dist[0] - 0.343)).toBeLessThan(1e-12);
    expect(Math.abs(dist[3] - 0.027)).toBeLessThan(1e-12);
  });

  it("quantiles are the smallest k reaching the level", () => {
    const dist = [0.05, 0.1, 0.7, 0.15];
    expect(pbQuantile(dist, 0.1)).toBe(1);
    expect(pbQuantile(dist, 0.9)).toBe(3);
  });
});

describe("Parity with Python (engine/src/pre_engine/whatif.py)", () => {
  it("has fixtures to check", () => {
    expect(DATA.parity_fixtures.length).toBeGreaterThanOrEqual(3);
  });

  for (const fx of DATA.parity_fixtures) {
    it(`matches Python for: ${fx.name}`, () => {
      const result = computeScenario(DATA, fx.scenario);
      expectClose(result, fx.result, fx.name);
    });
  }

  it("default scenario equals the exported default", () => {
    expect(defaultScenario(DATA)).toEqual(DATA.default_scenario);
  });

  it("baseline outputs are sane", () => {
    const r = computeScenario(DATA, DATA.default_scenario);
    expect(r.expected_failures.p10).toBeLessThanOrEqual(r.expected_failures.mean);
    expect(r.expected_failures.p90).toBeGreaterThanOrEqual(r.expected_failures.mean);
    for (const m of r.months) {
      expect(m.expected_failures).toBeGreaterThanOrEqual(0);
      expect(m.serviceability_pct).toBeGreaterThanOrEqual(0);
      expect(m.serviceability_pct).toBeLessThanOrEqual(100);
    }
  });

  it("more utilisation never lowers expected failures or workload", () => {
    const base = computeScenario(DATA, DATA.default_scenario);
    const up = computeScenario(DATA, { ...DATA.default_scenario, utilisation_change_pct: 25 });
    expect(up.expected_failures.mean).toBeGreaterThan(base.expected_failures.mean);
    expect(up.totals.fh).toBeGreaterThan(base.totals.fh);
    expect(up.ht_due.length).toBeGreaterThanOrEqual(base.ht_due.length);
  });
});

describe("dates", () => {
  it("adds whole days in UTC", () => {
    expect(addDaysIso("2026-11-15", 16)).toBe("2026-12-01");
    expect(addDaysIso("2026-11-15", 46.9)).toBe("2026-12-31");
  });
});
