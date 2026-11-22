// What-if model maths. Mirrors engine/src/pre_engine/whatif.py
// (compute_scenario and helpers) line for line, so the browser recomputes a
// scenario from the exported inputs exactly as Python does (parity test in
// model-math.test.ts, tolerance 1e-6). Every number used here comes from
// whatif.json; this file holds no fleet or model constants.
import type { PbSummary, Scenario, ScenarioMonth, ScenarioResult, WhatifInputs, WhatifSurvival } from "./whatif-types";

/** Weibull survival S(t) = exp(-(t / lambda)^rho), the lifelines AFT form. */
export function weibullSurvival(t: number, lambda: number, rho: number): number {
  return Math.exp(-Math.pow(Math.max(t, 0) / lambda, rho));
}

/** P(fail within [t, t + horizon] given survival to t). */
export function conditionalFailureProb(t: number, lambda: number, rho: number, horizon: number): number {
  return 1 - Math.exp(-(Math.pow((t + horizon) / lambda, rho) - Math.pow(t / lambda, rho)));
}

/** AFT scale lambda = exp(intercept + sum(beta_c * x_c)). */
export function aftLambda(par: WhatifSurvival, x: Record<string, number>): number {
  let s = par.intercept;
  for (const c of par.covariates) s += (par.coefficients[c] ?? 0) * (x[c] ?? 0);
  return Math.exp(s);
}

/** Exact Poisson-binomial distribution of the number of events. */
export function poissonBinomial(probs: number[]): number[] {
  let dist = [1];
  for (const p of probs) {
    const next = new Array<number>(dist.length + 1).fill(0);
    const q = 1 - p;
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * q;
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}

/** Smallest k with cumulative probability at or above q. */
export function pbQuantile(dist: number[], q: number): number {
  let c = 0;
  for (let k = 0; k < dist.length; k++) {
    c += dist[k];
    if (c >= q) return k;
  }
  return dist.length - 1;
}

function pbSummary(probs: number[]): PbSummary {
  const dist = poissonBinomial(probs);
  let mean = 0;
  for (const p of probs) mean += p;
  return { mean, p10: pbQuantile(dist, 0.1), p90: pbQuantile(dist, 0.9) };
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function defaultScenario(inp: WhatifInputs): Scenario {
  return {
    utilisation_change_pct: 0,
    utilisation_type: "all",
    acm_share_change_pts: 0,
    detachment_size: inp.detachment.baseline_size,
    horizon_months: 6,
  };
}

export function computeScenario(inp: WhatifInputs, sc: Scenario): ScenarioResult {
  const nb = Math.trunc(sc.horizon_months);
  const bd = inp.bucket_days;
  const hDays = nb * bd;
  const util = sc.utilisation_change_pct / 100;
  const sel = sc.utilisation_type;
  const acmDelta = sc.acm_share_change_pts / 100;
  const detN = Math.trunc(sc.detachment_size);
  const det = inp.detachment;
  const types = inp.types.map((t) => t.key);
  const zeros = () => new Array<number>(nb).fill(0);

  const schedMh = zeros();
  const unschedMh = zeros();
  const schedDown = zeros();
  const unschedDown = zeros();
  const expFail = zeros();
  const fleetFh = zeros();
  const byType: Record<string, { schedMh: number; unschedMh: number; down: number; fh: number; probs: number[] }> = {};
  for (const t of types) byType[t] = { schedMh: 0, unschedMh: 0, down: 0, fh: 0, probs: [] };

  const acFh: Record<string, number[]> = {};
  const acHot: Record<string, number[]> = {};
  const acMult: Record<string, number> = {};
  const acAcm: Record<string, number> = {};

  for (const ac of inp.aircraft) {
    const mult = sel === "all" || sel === ac.type ? 1 + util : 1;
    const rate = ac.fh_per_day * mult;
    const isFighter = ac.type === "fighter";
    let acmNew = ac.acm_share;
    if (isFighter) acmNew = Math.min(Math.max(ac.acm_share + acmDelta, 0), ac.acm_share + ac.gen_share);
    acMult[ac.tail] = mult;
    acAcm[ac.tail] = acmNew;
    const prog = inp.programme[ac.type];
    const canDetach = isFighter && ac.base === det.home_base;
    let sincePhase = ac.since_phase;
    let sincePeriodic = ac.since_periodic;
    let busy = ac.busy_days;
    const fhB = zeros();
    const hotB = zeros();
    const bt = byType[ac.type];
    for (let k = 0; k < hDays; k++) {
      const b = Math.floor(k / bd);
      if (busy > 0) {
        schedDown[b] += 1;
        bt.down += 1;
        busy -= 1;
        continue;
      }
      if (sincePhase >= prog.phase_interval_fh) {
        schedMh[b] += prog.phase_man_hours;
        bt.schedMh += prog.phase_man_hours;
        sincePhase = 0;
        sincePeriodic = 0;
        busy = prog.phase_days - 1;
        schedDown[b] += 1;
        bt.down += 1;
        continue;
      }
      if (sincePeriodic >= prog.periodic_interval_fh) {
        schedMh[b] += prog.periodic_man_hours;
        bt.schedMh += prog.periodic_man_hours;
        sincePeriodic = 0;
        busy = prog.periodic_days - 1;
        schedDown[b] += 1;
        bt.down += 1;
        continue;
      }
      if (rate <= 0) continue;
      sincePhase += rate;
      sincePeriodic += rate;
      fhB[b] += rate;
      const month = inp.day_month[k];
      let base = ac.base;
      if (canDetach && det.months.includes(month)) {
        const tails = det.rotation[String(inp.day_year[k])] ?? [];
        if (tails.slice(0, detN).includes(ac.tail)) base = det.base;
      }
      if (inp.bases.hot[base][month - 1]) hotB[b] += rate;
    }
    acFh[ac.tail] = fhB;
    acHot[ac.tail] = hotB;
    for (let b = 0; b < nb; b++) {
      fleetFh[b] += fhB[b];
      bt.fh += fhB[b];
    }
  }

  const aog = inp.aog_days_per_unscheduled_removal;
  const unitProbs: number[] = [];
  for (const u of inp.units) {
    const par = inp.survival[u.part_number];
    const rho = par.rho;
    const t = u.t;
    const fhB = acFh[u.tail];
    const hotB = acHot[u.tail];
    const bt = byType[u.type];
    let cumFh = 0;
    let cumHot = 0;
    let pPrev = 0;
    for (let b = 0; b < nb; b++) {
      cumFh += fhB[b];
      cumHot += hotB[b];
      if (cumFh <= 0) continue;
      // Covariates are lifetime exposure shares: update them to the end of
      // this bucket, then take the standard AFT conditional probability.
      const x: Record<string, number> = { ...u.x };
      if (par.covariates.includes("hot_share")) x.hot_share = (u.x.hot_share * t + cumHot) / (t + cumFh);
      if (par.covariates.includes("acm_share")) x.acm_share = (u.x.acm_share * t + acAcm[u.tail] * cumFh) / (t + cumFh);
      const lam = aftLambda(par, x);
      const pCum = 1 - Math.exp(-(Math.pow((t + cumFh) / lam, rho) - Math.pow(t / lam, rho)));
      const pB = pCum - pPrev;
      expFail[b] += pB;
      unschedMh[b] += pB * u.man_hours;
      unschedDown[b] += pB * aog;
      bt.unschedMh += pB * u.man_hours;
      bt.down += pB * aog;
      pPrev = pCum;
    }
    unitProbs.push(pPrev);
    bt.probs.push(pPrev);
  }

  const htDue: ScenarioResult["ht_due"] = [];
  for (const it of inp.ht_items) {
    const mult = acMult[it.tail];
    let best = Infinity;
    let gov: string | null = null;
    for (const lim of it.limits) {
      const d = lim.scales_with_use ? lim.baseline_days / mult : lim.baseline_days;
      if (d < best) {
        best = d;
        gov = lim.governing;
      }
    }
    if (best <= hDays) {
      const b = Math.min(Math.max(Math.floor(best / bd), 0), nb - 1);
      schedMh[b] += it.man_hours;
      byType[it.type].schedMh += it.man_hours;
      htDue.push({
        tail: it.tail,
        type: it.type,
        serial: it.serial,
        component: it.component,
        part_number: it.part_number,
        position: it.position,
        governing: gov,
        days_to_due: best,
      });
    }
  }
  htDue.sort((a, b) =>
    a.days_to_due !== b.days_to_due
      ? a.days_to_due - b.days_to_due
      : a.tail !== b.tail
        ? (a.tail < b.tail ? -1 : 1)
        : a.serial < b.serial
          ? -1
          : a.serial > b.serial
            ? 1
            : 0
  );

  const nAc = inp.aircraft.length;
  const months: ScenarioMonth[] = [];
  for (let b = 0; b < nb; b++) {
    months.push({
      start: inp.bucket_starts[b],
      fh: fleetFh[b],
      scheduled_man_hours: schedMh[b],
      unscheduled_man_hours: unschedMh[b],
      expected_failures: expFail[b],
      scheduled_down_days: schedDown[b],
      unscheduled_down_days: unschedDown[b],
      serviceability_pct: Math.max(0, 100 * (1 - (schedDown[b] + unschedDown[b]) / (nAc * bd))),
    });
  }

  const ffi = inp.fighter_fi;
  const fi: ScenarioResult["fi"] = inp.aircraft.map((ac) => {
    let daysBase: number | null = null;
    let daysScen: number | null = null;
    if (ac.fi_trailing_12mo > 0 && ac.fh_trailing_12mo > 0) {
      const fiPerFh = ac.fi_trailing_12mo / ac.fh_trailing_12mo;
      const fhDay = ac.fh_trailing_12mo / 365;
      let fiPerFhS = fiPerFh;
      if (ac.type === "fighter") {
        fiPerFhS = fiPerFh + (acAcm[ac.tail] - ac.acm_share) * (ffi.fi_per_fh_acm - ffi.fi_per_fh_gen);
      }
      const perDayBase = fiPerFh * fhDay;
      const perDayScen = fiPerFhS * fhDay * acMult[ac.tail];
      const remaining = inp.fi_limit - ac.fi_now;
      daysBase = perDayBase > 0 ? Math.max(remaining / perDayBase, 0) : null;
      daysScen = perDayScen > 0 ? Math.max(remaining / perDayScen, 0) : null;
    }
    return {
      tail: ac.tail,
      type: ac.type,
      fi_now: ac.fi_now,
      baseline_days: daysBase,
      scenario_days: daysScen,
      planned_withdrawal_year: ac.planned_withdrawal_year,
    };
  });

  const byTypeRows: ScenarioResult["by_type"] = types.map((t) => {
    const bt = byType[t];
    const nT = inp.aircraft.filter((a) => a.type === t).length;
    return {
      type: t,
      fh: bt.fh,
      scheduled_man_hours: bt.schedMh,
      unscheduled_man_hours: bt.unschedMh,
      serviceability_pct: nT ? Math.max(0, 100 * (1 - bt.down / (nT * hDays))) : 0,
      units: bt.probs.length,
      expected_failures: pbSummary(bt.probs),
    };
  });

  return {
    horizon_days: hDays,
    expected_failures: pbSummary(unitProbs),
    months,
    by_type: byTypeRows,
    ht_due: htDue,
    fi,
    totals: { fh: sum(fleetFh), scheduled_man_hours: sum(schedMh), unscheduled_man_hours: sum(unschedMh) },
  };
}

/** ISO date `days` whole days after an ISO date (UTC, no clock). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) + Math.floor(days) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
