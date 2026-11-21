"use client";

import { useMemo, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TailNumber } from "@/components/domain/tail-number";
import { formatFH, formatNumber, formatPct, formatDate } from "@/lib/format";
import type { FleetData } from "@/lib/data";

// Static domain constants mirroring engine/src/pre_engine/config.py (fixed
// mission-mix factors, not computed data) so FI projections can be
// recomputed live in the browser for arbitrary slider positions.
const FI_BASE_RATE_PER_FH = 100 / 7500;
const ACM_FI_FACTOR = 2.2;
const GEN_FI_FACTOR = 1.0;

interface AircraftFatigue {
  tail: string;
  fi_now: number;
  fh_trailing_12mo: number;
  fi_per_fh: number;
  acm_share_trailing: number;
  planned_withdrawal_year: number;
}

export function PlanningView({
  fleet,
  fatigue,
}: {
  fleet: FleetData;
  fatigue: AircraftFatigue[];
}) {
  const [utilPct, setUtilPct] = useState(0);
  const [acmShift, setAcmShift] = useState(0);
  const [detachment, setDetachment] = useState(3);
  const [horizon, setHorizon] = useState("6");

  const horizonMonths = Number(horizon);
  const horizonDays = horizonMonths * 30;
  const utilMultiplier = 1 + utilPct / 100;

  const baseline = useMemo(() => {
    const fh = (fleet.kpis.fleet_fh_12mo / 365) * horizonDays;
    const removals = (fleet.kpis.unscheduled_removal_rate_per_1000fh / 1000) * fh;
    return { fh, removals };
  }, [fleet, horizonDays]);

  const scenario = useMemo(() => {
    const fh = baseline.fh * utilMultiplier;
    // Rough, disclosed elasticity: shifting ACM share up/down nudges wear
    // rate by 0.5% per point (ACM is the heaviest-wear mission in config.py).
    const rateMultiplier = 1 + (acmShift / 100) * 0.5;
    const removals = baseline.removals * utilMultiplier * rateMultiplier;
    const removalsDelta = removals - baseline.removals;
    const lo = Math.max(0, removals - 1.28 * Math.sqrt(removals));
    const hi = removals + 1.28 * Math.sqrt(removals);

    // Workload: scheduled portion scales with FH flown; unscheduled portion
    // scales with removal count at an approximate 6 man-hours/removal.
    const baselineWorkload = baseline.fh * 0.9 + baseline.removals * 6;
    const scenarioWorkload = fh * 0.9 + removals * 6;

    const serviceabilityDelta = -(removalsDelta * 0.35);
    const serviceability = Math.max(50, Math.min(100, fleet.kpis.serviceability_pct + serviceabilityDelta));

    return { fh, removals, removalsDelta, lo, hi, baselineWorkload, scenarioWorkload, serviceability };
  }, [baseline, utilMultiplier, acmShift, fleet]);

  const fiProjections = useMemo(() => {
    return fatigue
      .map((a) => {
        const dailyFhBaseline = a.fh_trailing_12mo / 365;
        const dailyFhScenario = dailyFhBaseline * utilMultiplier;
        const acmShareDelta = acmShift / 100;
        const fiPerFhScenario = Math.max(
          0.0001,
          a.fi_per_fh + acmShareDelta * (GEN_FI_FACTOR - ACM_FI_FACTOR) * FI_BASE_RATE_PER_FH
        );
        const baselineDays = a.fi_per_fh > 0 ? (100 - a.fi_now) / (a.fi_per_fh * dailyFhBaseline) : Infinity;
        const scenarioDays = (100 - a.fi_now) / (fiPerFhScenario * dailyFhScenario);
        const baselineDate = addDays(baselineDays);
        const scenarioDate = addDays(scenarioDays);
        return { tail: a.tail, withdrawalYear: a.planned_withdrawal_year, baselineDate, scenarioDate };
      })
      .sort((a, b) => a.scenarioDate.getTime() - b.scenarioDate.getTime());
  }, [fatigue, utilMultiplier, acmShift]);

  const htDue = fleet.due_90_days.filter((d) => {
    if (d.days_to_due == null) return false;
    return d.days_to_due / utilMultiplier <= horizonDays;
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[28px] font-semibold text-(--ink) page-title">Planning: what-if</h1>
      <p className="text-[11px] text-(--ink-3)">
        Recomputed instantly in the browser from exported model parameters. Removal, workload and serviceability
        figures use a simplified elasticity model (disclosed below); fatigue-index projections use the same formula
        as the engine.
      </p>

      <section className="grid grid-cols-1 gap-6 rounded-[8px] border border-(--rule) bg-(--sheet) p-4 md:grid-cols-4">
        <Control label={`Utilisation change: ${utilPct > 0 ? "+" : ""}${utilPct}%`}>
          <Slider value={[utilPct]} min={-30} max={50} step={5} onValueChange={(v) => setUtilPct((Array.isArray(v) ? v[0] : v) as number)} />
        </Control>
        <Control label={`ACM share change: ${acmShift > 0 ? "+" : ""}${acmShift} pts`}>
          <Slider value={[acmShift]} min={-15} max={15} step={1} onValueChange={(v) => setAcmShift((Array.isArray(v) ? v[0] : v) as number)} />
        </Control>
        <Control label={`Summer detachment to Base B: ${detachment} aircraft`}>
          <Slider value={[detachment]} min={0} max={6} step={1} onValueChange={(v) => setDetachment((Array.isArray(v) ? v[0] : v) as number)} />
        </Control>
        <Control label="Horizon">
          <Select value={horizon} onValueChange={(v) => v && setHorizon(v)}>
            <SelectTrigger size="sm" className="h-8 w-full border-(--rule) bg-(--paper) text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3">Next 3 months</SelectItem>
              <SelectItem value="6">Next 6 months</SelectItem>
              <SelectItem value="12">Next 12 months</SelectItem>
            </SelectContent>
          </Select>
        </Control>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Compare
          title="Expected unscheduled removals (flight-safety and mission parts)"
          baseline={`${formatNumber(baseline.removals, 1)}`}
          scenario={`${formatNumber(scenario.removals, 1)} (${formatNumber(scenario.lo, 1)} to ${formatNumber(scenario.hi, 1)}, 80% interval)`}
        />
        <Compare
          title="Maintenance workload (man-hours, horizon total)"
          baseline={formatNumber(baseline.fh * 0.9, 0)}
          scenario={formatNumber(scenario.scenarioWorkload, 0)}
        />
        <Compare
          title="Projected fleet FH"
          baseline={formatFH(baseline.fh, 0)}
          scenario={formatFH(scenario.fh, 0)}
        />
        <Compare
          title="Projected serviceability"
          baseline={formatPct(fleet.kpis.serviceability_pct, 1)}
          scenario={formatPct(scenario.serviceability, 1)}
        />
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Hard-time items falling due in horizon</h3>
        {htDue.length === 0 ? (
          <p className="text-[12px] text-(--ink-2)">No hard-time items fall due in this horizon at this utilisation.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {htDue.map((d, i) => (
              <li key={i} className="flex items-center justify-between rounded-[6px] border border-(--rule) px-3 py-2">
                <span>
                  <TailNumber tail={d.tail} className="mr-2 text-[12px]" />
                  {d.item}
                </span>
                <span className="tabular text-(--ink-2)">{d.date ? formatDate(d.date) : "N/A"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Fatigue index 100 dates: baseline vs scenario</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-medium">Tail</th>
                <th className="pb-1.5 font-medium">Baseline</th>
                <th className="pb-1.5 font-medium">Scenario</th>
                <th className="pb-1.5 font-medium">Withdrawal year</th>
              </tr>
            </thead>
            <tbody>
              {fiProjections.map((p) => (
                <tr key={p.tail} className="border-t border-(--rule)">
                  <td className="py-1.5">
                    <TailNumber tail={p.tail} className="text-[12px]" />
                  </td>
                  <td className="py-1.5 tabular text-(--ink-2)">{isFinite(p.baselineDate.getTime()) ? formatDate(p.baselineDate) : "N/A"}</td>
                  <td
                    className={`py-1.5 tabular font-medium ${p.scenarioDate.getFullYear() < p.withdrawalYear ? "text-(--status-critical)" : "text-(--ink)"}`}
                  >
                    {isFinite(p.scenarioDate.getTime()) ? formatDate(p.scenarioDate) : "N/A"}
                  </td>
                  <td className="py-1.5 tabular text-(--ink-2)">{p.withdrawalYear}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function addDays(days: number): Date {
  const d = new Date(2026, 10, 15);
  d.setDate(d.getDate() + Math.min(Math.max(days, 0), 365 * 50));
  return d;
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[12px] font-medium text-(--ink)">{label}</label>
      {children}
    </div>
  );
}

function Compare({ title, baseline, scenario }: { title: string; baseline: string; scenario: string }) {
  return (
    <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
      <h4 className="mb-2 text-[12px] font-semibold text-(--ink-2)">{title}</h4>
      <div className="flex items-end gap-6">
        <div>
          <span className="block text-[10.5px] text-(--ink-3)">Baseline</span>
          <span className="text-[18px] tabular text-(--ink)">{baseline}</span>
        </div>
        <div>
          <span className="block text-[10.5px] text-(--ink-3)">Scenario</span>
          <span className="text-[18px] font-semibold tabular text-(--accent) figure-display">{scenario}</span>
        </div>
      </div>
    </div>
  );
}
