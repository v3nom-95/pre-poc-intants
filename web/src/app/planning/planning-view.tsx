"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TailNumber } from "@/components/domain/tail-number";
import { ChartFrame, ChartLegend } from "@/components/charts/chart-frame";
import { ChartTable } from "@/components/charts/chart-table";
import { LineChart } from "@/components/charts/line-chart";
import { formatDate, formatFH, formatNumber, formatPct } from "@/lib/format";
import { addDaysIso, computeScenario } from "@/lib/model-math";
import type { Scenario, ScenarioResult, WhatifInputs } from "@/lib/whatif-types";
import { WorkloadCompareChart } from "./workload-compare-chart";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BASELINE_COLOR = "var(--chart-cat-1)";
const SCENARIO_COLOR = "var(--chart-cat-2)";

function sliderValue(v: number | readonly number[]): number {
  return (Array.isArray(v) ? v[0] : v) as number;
}

function signed(n: number, unit: string): string {
  return `${n > 0 ? "plus " : n < 0 ? "minus " : ""}${formatNumber(Math.abs(n))}${unit}`;
}

function shortDate(iso: string): string {
  return formatDate(iso).split(" ").slice(0, 2).join(" ");
}

function monthList(months: number[]): string {
  const names = months.map((m) => MONTH_NAMES[m - 1]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function totalWorkload(r: ScenarioResult): number {
  return r.totals.scheduled_man_hours + r.totals.unscheduled_man_hours;
}

function meanServiceability(r: ScenarioResult): number {
  return r.months.reduce((a, m) => a + m.serviceability_pct, 0) / Math.max(r.months.length, 1);
}

function minServiceability(r: ScenarioResult): number {
  return Math.min(...r.months.map((m) => m.serviceability_pct));
}

export function PlanningView({ inputs, defaultScenario }: { inputs: WhatifInputs; defaultScenario: Scenario }) {
  const [utilPct, setUtilPct] = useState(defaultScenario.utilisation_change_pct);
  const [utilType, setUtilType] = useState(defaultScenario.utilisation_type);
  const [acmPts, setAcmPts] = useState(defaultScenario.acm_share_change_pts);
  const [detachment, setDetachment] = useState(defaultScenario.detachment_size);
  const [horizon, setHorizon] = useState(String(defaultScenario.horizon_months));

  const horizonMonths = Number(horizon);
  const typeName = useMemo(() => new Map(inputs.types.map((t) => [t.key, t.name])), [inputs.types]);
  const hasFighters = inputs.types.some((t) => t.key === "fighter");

  const baselineScenario: Scenario = useMemo(
    () => ({ ...defaultScenario, horizon_months: horizonMonths }),
    [defaultScenario, horizonMonths]
  );
  const scenario: Scenario = {
    utilisation_change_pct: utilPct,
    utilisation_type: utilType,
    acm_share_change_pts: acmPts,
    detachment_size: detachment,
    horizon_months: horizonMonths,
  };
  const baseline = useMemo(() => computeScenario(inputs, baselineScenario), [inputs, baselineScenario]);
  // Recomputed on every control change: the model runs in a few milliseconds.
  const result = useMemo(
    () => computeScenario(inputs, scenario),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputs, utilPct, utilType, acmPts, detachment, horizonMonths]
  );
  const isBaseline =
    utilPct === defaultScenario.utilisation_change_pct &&
    acmPts === defaultScenario.acm_share_change_pts &&
    detachment === defaultScenario.detachment_size;

  function reset() {
    setUtilPct(defaultScenario.utilisation_change_pct);
    setUtilType(defaultScenario.utilisation_type);
    setAcmPts(defaultScenario.acm_share_change_pts);
    setDetachment(defaultScenario.detachment_size);
  }

  const horizonEnd = addDaysIso(inputs.as_of, result.horizon_days);
  const baseHt = new Map(baseline.ht_due.map((d) => [`${d.tail}|${d.serial}`, d.days_to_due]));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title text-[28px] font-semibold text-(--ink)">Planning: what-if</h1>
        <p className="max-w-[920px] text-[13px] text-(--ink-2)">
          Change utilisation, mission mix or the summer detachment and see expected unscheduled removals, hard-time
          items falling due, workload, serviceability and fatigue index dates move. Recomputed in the browser from the
          exported survival model parameters, hard-time limits and maintenance programme, with the same maths as the
          engine (checked by a parity test). Baseline and scenario are always shown side by side.
        </p>
      </header>

      <section
        aria-label="Scenario controls"
        className="grid grid-cols-1 gap-x-6 gap-y-5 rounded-[8px] border border-(--rule) bg-(--sheet) p-4 md:grid-cols-2 xl:grid-cols-4"
      >
        <Control label={`Utilisation change: ${signed(utilPct, "%")}`}>
          <Slider
            aria-label="Utilisation change in percent"
            value={[utilPct]}
            min={-30}
            max={50}
            step={5}
            onValueChange={(v) => setUtilPct(sliderValue(v))}
          />
          <Select value={utilType} onValueChange={(v) => v && setUtilType(v)}>
            <SelectTrigger size="sm" aria-label="Aircraft types the utilisation change applies to" className="h-8 w-full border-(--rule) bg-(--paper) text-[12px]">
              <SelectValue>{(v: string) => (v === "all" ? "Applies to all types" : `Applies to ${typeName.get(v) ?? v}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Applies to all types</SelectItem>
              {inputs.types.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  Applies to {t.name} ({t.aircraft} aircraft)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Control>
        <Control label={`ACM share change: ${signed(acmPts, " points")}`} note={hasFighters ? "Fighters only, moved to or from general flying" : "No fighters in this fleet"}>
          <Slider
            aria-label="Air combat manoeuvring share change in points"
            value={[acmPts]}
            min={-15}
            max={15}
            step={1}
            disabled={!hasFighters}
            onValueChange={(v) => setAcmPts(sliderValue(v))}
          />
        </Control>
        <Control
          label={`Summer detachment to ${inputs.detachment.base}: ${detachment} aircraft`}
          note={`Fighters from ${inputs.detachment.home_base}, ${monthList(inputs.detachment.months)}. Baseline ${inputs.detachment.baseline_size}.`}
        >
          <Slider
            aria-label="Summer detachment size in aircraft"
            value={[detachment]}
            min={0}
            max={inputs.detachment.max_size}
            step={1}
            disabled={!hasFighters}
            onValueChange={(v) => setDetachment(sliderValue(v))}
          />
        </Control>
        <Control label="Horizon" note={`${formatDate(addDaysIso(inputs.as_of, 1))} to ${formatDate(horizonEnd)}`}>
          <Select value={horizon} onValueChange={(v) => v && setHorizon(v)}>
            <SelectTrigger size="sm" aria-label="Planning horizon" className="h-8 w-full border-(--rule) bg-(--paper) text-[12px]">
              <SelectValue>{(v: string) => `Next ${v} months`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3">Next 3 months</SelectItem>
              <SelectItem value="6">Next 6 months</SelectItem>
              <SelectItem value="12">Next 12 months</SelectItem>
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={reset}
            disabled={isBaseline && utilType === defaultScenario.utilisation_type}
            className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-[6px] border border-(--rule) px-2.5 py-1 text-[12px] text-(--ink-2) hover:text-(--ink) disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" aria-hidden strokeWidth={1.75} />
            Reset to baseline
          </button>
        </Control>
      </section>

      <section aria-label="Baseline and scenario figures" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Compare
          title="Expected unscheduled removals"
          unitNote="Confirmed failures, 80% interval"
          baseline={`${formatNumber(baseline.expected_failures.mean, 1)}`}
          baselineSub={`${baseline.expected_failures.p10} to ${baseline.expected_failures.p90}`}
          scenario={`${formatNumber(result.expected_failures.mean, 1)}`}
          scenarioSub={`${result.expected_failures.p10} to ${result.expected_failures.p90}`}
        />
        <Compare
          title="Hard-time items falling due"
          unitNote="Whichever limit comes first"
          baseline={formatNumber(baseline.ht_due.length)}
          scenario={formatNumber(result.ht_due.length)}
        />
        <Compare
          title="Maintenance workload"
          unitNote="Man-hours over the horizon"
          baseline={formatNumber(totalWorkload(baseline))}
          baselineSub={`${formatNumber(baseline.totals.unscheduled_man_hours)} unscheduled`}
          scenario={formatNumber(totalWorkload(result))}
          scenarioSub={`${formatNumber(result.totals.unscheduled_man_hours)} unscheduled`}
        />
        <Compare
          title="Projected serviceability"
          unitNote="Mean of monthly values, lowest month below"
          baseline={formatPct(meanServiceability(baseline), 1)}
          baselineSub={`Lowest ${formatPct(minServiceability(baseline), 1)}`}
          scenario={formatPct(meanServiceability(result), 1)}
          scenarioSub={`Lowest ${formatPct(minServiceability(result), 1)}`}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <WorkloadCompareChart baseline={baseline.months} scenario={result.months} />
        </section>
        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <ChartFrame
            title="Projected serviceability per month (%)"
            legend={
              <ChartLegend
                items={[
                  { label: "Baseline", color: BASELINE_COLOR },
                  { label: "Scenario", color: SCENARIO_COLOR },
                ]}
              />
            }
            chart={
              <LineChart
                height={240}
                series={[
                  {
                    id: "baseline",
                    label: "Baseline",
                    color: BASELINE_COLOR,
                    points: baseline.months.map((m, i) => ({ x: i + 1, y: m.serviceability_pct })),
                  },
                  {
                    id: "scenario",
                    label: "Scenario",
                    color: SCENARIO_COLOR,
                    points: result.months.map((m, i) => ({ x: i + 1, y: m.serviceability_pct })),
                  },
                ]}
                yMin={Math.max(0, Math.floor(Math.min(minServiceability(baseline), minServiceability(result)) / 10) * 10 - 10)}
                yMax={100}
                xTickFormat={(x) => (result.months[x - 1] ? shortDate(result.months[x - 1].start) : "")}
                yTickFormat={(y) => `${formatNumber(y)}%`}
              />
            }
            table={
              <ChartTable
                columns={["Month from", "Baseline", "Scenario", "Scenario input days", "Scenario expected removals"]}
                rows={result.months.map((m, i) => [
                  formatDate(m.start),
                  formatPct(baseline.months[i].serviceability_pct, 1),
                  formatPct(m.serviceability_pct, 1),
                  `${formatNumber(m.scheduled_down_days)} days`,
                  formatNumber(m.expected_failures, 2),
                ])}
              />
            }
          />
        </section>
      </div>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="by-type">
        <h2 id="by-type" className="mb-3 text-[15px] font-semibold text-(--ink)">By aircraft type</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-2 font-semibold">Type</th>
                <th className="pb-2 font-semibold">Fleet FH flown</th>
                <th className="pb-2 font-semibold">Expected removals (80% interval)</th>
                <th className="pb-2 font-semibold">Workload</th>
                <th className="pb-2 font-semibold">Serviceability</th>
              </tr>
            </thead>
            <tbody>
              {result.by_type.map((t, i) => {
                const b = baseline.by_type[i];
                return (
                  <tr key={t.type} className="border-t border-(--rule) align-top">
                    <td className="py-2 pr-4 text-(--ink)">
                      {typeName.get(t.type) ?? t.type}
                      <span className="block text-[11px] text-(--ink-3)">{t.units} monitored units</span>
                    </td>
                    <Pair base={formatFH(b.fh)} scen={formatFH(t.fh)} />
                    <Pair
                      base={`${formatNumber(b.expected_failures.mean, 1)} (${b.expected_failures.p10} to ${b.expected_failures.p90})`}
                      scen={`${formatNumber(t.expected_failures.mean, 1)} (${t.expected_failures.p10} to ${t.expected_failures.p90})`}
                    />
                    <Pair
                      base={`${formatNumber(b.scheduled_man_hours + b.unscheduled_man_hours)} man-hours`}
                      scen={`${formatNumber(t.scheduled_man_hours + t.unscheduled_man_hours)} man-hours`}
                    />
                    <Pair base={formatPct(b.serviceability_pct, 1)} scen={formatPct(t.serviceability_pct, 1)} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="ht-due">
          <h2 id="ht-due" className="mb-1 text-[15px] font-semibold text-(--ink)">Hard-time items falling due in the horizon</h2>
          <p className="mb-3 text-[12px] text-(--ink-2)">
            Scenario list, {formatNumber(result.ht_due.length)} items. Calendar limits do not move with utilisation.
          </p>
          {result.ht_due.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">No hard-time item falls due in this horizon under this scenario.</p>
          ) : (
            <div className="max-h-[420px] overflow-auto" tabIndex={0} role="region" aria-labelledby="ht-due">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-(--sheet)">
                  <tr className="text-left text-(--ink-2)">
                    <th className="pb-2 font-semibold">Aircraft</th>
                    <th className="pb-2 font-semibold">Item</th>
                    <th className="pb-2 font-semibold">Governing limit</th>
                    <th className="pb-2 font-semibold">Baseline due</th>
                    <th className="pb-2 font-semibold">Scenario due</th>
                  </tr>
                </thead>
                <tbody>
                  {result.ht_due.map((d) => {
                    const bd = baseHt.get(`${d.tail}|${d.serial}`);
                    return (
                      <tr key={`${d.tail}-${d.serial}`} className="border-t border-(--rule) align-top">
                        <td className="py-1.5 pr-3">
                          <TailNumber tail={d.tail} className="text-[12px]" />
                        </td>
                        <td className="py-1.5 pr-3 text-(--ink)">
                          {d.component}
                          <span className="block text-[11px] text-(--ink-3)">
                            {d.serial}
                            {d.position && d.position !== "1" ? `, position ${d.position}` : ""}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 text-(--ink-2)">{d.governing}</td>
                        <td className="tabular py-1.5 pr-3 text-(--ink-2)">
                          {bd === undefined ? "After horizon" : formatDate(addDaysIso(inputs.as_of, bd))}
                        </td>
                        <td className="tabular py-1.5 font-medium text-(--ink)">{formatDate(addDaysIso(inputs.as_of, d.days_to_due))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="fi-dates">
          <h2 id="fi-dates" className="mb-1 text-[15px] font-semibold text-(--ink)">Fatigue index 100 dates</h2>
          <p className="mb-3 text-[12px] text-(--ink-2)">
            Trailing 12-month FI per FH at scenario utilisation. Dates before the planned withdrawal year are flagged.
          </p>
          <div className="max-h-[420px] overflow-auto" tabIndex={0} role="region" aria-labelledby="fi-dates">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-(--sheet)">
                <tr className="text-left text-(--ink-2)">
                  <th className="pb-2 pr-3 font-semibold">Aircraft</th>
                  <th className="pb-2 pr-3 font-semibold">FI now</th>
                  <th className="pb-2 pr-3 font-semibold">Baseline</th>
                  <th className="pb-2 pr-3 font-semibold">Scenario</th>
                  <th className="pb-2 font-semibold">Withdrawal</th>
                </tr>
              </thead>
              <tbody>
                {[...result.fi]
                  .sort((a, b) => (a.scenario_days ?? Infinity) - (b.scenario_days ?? Infinity))
                  .map((f) => {
                    const b = baseline.fi.find((x) => x.tail === f.tail);
                    const scenDate = fiDate(inputs.as_of, f.scenario_days);
                    const early = scenDate !== null && Number(scenDate.slice(0, 4)) < f.planned_withdrawal_year;
                    return (
                      <tr key={f.tail} className="border-t border-(--rule)">
                        <td className="py-1.5 pr-3">
                          <TailNumber tail={f.tail} className="text-[12px]" />
                          {inputs.types.length > 1 && (
                            <span className="ml-2 text-[11px] text-(--ink-3)">{typeName.get(f.type) ?? f.type}</span>
                          )}
                        </td>
                        <td className="tabular py-1.5 pr-3 text-(--ink-2)">{formatNumber(f.fi_now, 1)}</td>
                        <td className="tabular whitespace-nowrap py-1.5 pr-3 text-(--ink-2)">{fiLabel(fiDate(inputs.as_of, b?.baseline_days ?? null))}</td>
                        <td className="tabular whitespace-nowrap py-1.5 pr-3 font-medium text-(--ink)">
                          {early && (
                            <AlertTriangle
                              className="mr-1 inline size-3.5 align-[-2px] text-(--status-critical)"
                              strokeWidth={2}
                              aria-hidden
                            />
                          )}
                          {fiLabel(scenDate)}
                          {early && <span className="ml-1.5 text-[11px] font-normal">(before withdrawal)</span>}
                        </td>
                        <td className="tabular py-1.5 text-(--ink-2)">{f.planned_withdrawal_year}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="assumptions">
        <h2 id="assumptions" className="mb-2 text-[15px] font-semibold text-(--ink)">Assumptions</h2>
        <ul className="flex max-w-[1100px] list-disc flex-col gap-1.5 pl-5 text-[12px] text-(--ink-2)">
          <li>
            Each aircraft flies its trailing 90-day FH per day, times the utilisation change, on every day it is not in a
            scheduled input. Periodic servicing and phase inspection start when their FH counters reach the interval
            {inputs.types
              .map((t) => {
                const p = inputs.programme[t.key];
                return ` (${t.name}: ${formatFH(p.periodic_interval_fh)} and ${formatFH(p.phase_interval_fh)}, ${p.periodic_days} and ${p.phase_days} days, ${formatNumber(p.periodic_man_hours)} and ${formatNumber(p.phase_man_hours)} man-hours)`;
              })
              .join(";")}
            . A phase inspection also covers the periodic servicing.
          </li>
          <li>
            Unscheduled removals come from the Weibull AFT survival model of each part number:{" "}
            {formatNumber(inputs.units.length)} in-service on-condition and condition-monitored units (tyres and brakes
            excluded{inputs.units_excluded_no_model ? `, ${inputs.units_excluded_no_model} units without a fitted model excluded` : ""}).
            The model covariates are lifetime exposure shares, so each month updates a unit&apos;s hot-climate and ACM
            shares before taking the conditional failure probability. The interval is the exact Poisson-binomial 10th to
            90th percentile. NFF removals are not included.
          </li>
          <li>
            Hot-climate FH: flying at a base whose monthly mean temperature is {formatNumber(inputs.bases.hot_threshold_c)} °C
            or more (
            {Object.entries(inputs.bases.hot)
              .map(([base, months]) => {
                const hot = months.map((h, i) => (h ? i + 1 : 0)).filter((m) => m > 0);
                return `${base}: ${hot.length ? monthList(hot) : "none"}`;
              })
              .join("; ")}
            ). Detached fighters are at {inputs.detachment.base} in {monthList(inputs.detachment.months)}, chosen by the
            same yearly rotation as the historical record.
          </li>
          <li>
            Each expected unscheduled removal grounds the aircraft for {formatNumber(inputs.aog_days_per_unscheduled_removal, 1)} days,
            measured from the last 24 months of data ({formatNumber(inputs.aog_sample_size)} removals). Remove and install
            man-hours come from {inputs.man_hours_source}.
          </li>
          <li>
            Hard-time items: days to each limit at the scenario rate, whichever comes first, as in the rules engine. Fighter
            fatigue: ACM share change moves FH between {inputs.fighter_fi.acm_mission.toLowerCase()} (
            {formatNumber(inputs.fighter_fi.fi_per_fh_acm, 4)} FI per FH) and {inputs.fighter_fi.gen_mission.toLowerCase()} (
            {formatNumber(inputs.fighter_fi.fi_per_fh_gen, 4)} FI per FH), both measured from the sortie log.
          </li>
        </ul>
      </section>
    </div>
  );
}

function fiDate(asOf: string, days: number | null | undefined): string | null {
  if (days === null || days === undefined || !isFinite(days)) return null;
  return addDaysIso(asOf, days);
}

function fiLabel(iso: string | null): string {
  if (iso === null) return "Not projected";
  return Number(iso.slice(0, 4)) > 2100 ? "After 2100" : formatDate(iso);
}

function Control({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] font-medium text-(--ink)">{label}</span>
      {children}
      {note && <span className="text-[11px] text-(--ink-3)">{note}</span>}
    </div>
  );
}

function Compare({
  title,
  unitNote,
  baseline,
  baselineSub,
  scenario,
  scenarioSub,
}: {
  title: string;
  unitNote: string;
  baseline: string;
  baselineSub?: string;
  scenario: string;
  scenarioSub?: string;
}) {
  return (
    <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
      <h3 className="text-[13px] font-semibold text-(--ink)">{title}</h3>
      <p className="mb-2 text-[11px] text-(--ink-3)">{unitNote}</p>
      <div className="flex items-end gap-6">
        <div>
          <span className="block text-[11px] text-(--ink-2)">Baseline</span>
          <span className="text-[22px] tabular text-(--ink-2)">{baseline}</span>
          {baselineSub && <span className="block text-[11px] text-(--ink-3)">{baselineSub}</span>}
        </div>
        <div aria-live="polite">
          <span className="block text-[11px] text-(--ink-2)">Scenario</span>
          <span className="figure-display text-[22px] font-semibold text-(--ink)">{scenario}</span>
          {scenarioSub && <span className="block text-[11px] text-(--ink-2)">{scenarioSub}</span>}
        </div>
      </div>
    </div>
  );
}

function Pair({ base, scen }: { base: string; scen: string }) {
  return (
    <td className="py-2 pr-4">
      <span className="tabular block text-(--ink)">{scen}</span>
      <span className="tabular block text-[11px] text-(--ink-3)">Baseline {base}</span>
    </td>
  );
}
