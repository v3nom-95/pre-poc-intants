"use client";

import { Button } from "@/components/ui/button";
import { TailNumber } from "@/components/domain/tail-number";
import { PriorityTag } from "@/components/domain/status-tag";
import { formatFH, formatNumber, formatPct, formatDate } from "@/lib/format";
import type { FleetData, ReliabilityData } from "@/lib/data";

export function ReportsView({ fleet, reliability }: { fleet: FleetData; reliability: ReliabilityData }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex items-center justify-between">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Reports</h1>
        <Button onClick={() => window.print()}>Print or save as PDF</Button>
      </div>

      <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-6 print:border-0 print:p-0">
        <header className="mb-6 flex items-baseline justify-between border-b border-(--rule) pb-3">
          <div>
            <h2 className="text-[18px] font-semibold text-(--ink)">Fleet report</h2>
            <p className="text-[12px] text-(--ink-2)">Predictive Recommendation Engine (PRE): data as of {formatDate(fleet.as_of)}</p>
          </div>
          <p className="text-[11px] text-(--ink-3)">Proof of concept. All aircraft, data and figures are fictional.</p>
        </header>

        <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Figure label="Fleet FH (12 mo)" value={formatFH(fleet.kpis.fleet_fh_12mo)} />
          <Figure label="Serviceability" value={formatPct(fleet.kpis.serviceability_pct)} />
          <Figure label="Open recommendations" value={formatNumber(Object.values(fleet.kpis.open_recs_by_priority).reduce((a, b) => a + b, 0))} />
          <Figure label="Due in 30 days" value={formatNumber(fleet.kpis.due_30_days_count)} />
          <Figure label="Unscheduled removals / 1,000 FH" value={formatNumber(fleet.kpis.unscheduled_removal_rate_per_1000fh, 1)} />
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Fleet status</h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-(--rule) text-left text-(--ink-2)">
                <th className="py-1 font-medium">Tail</th>
                <th className="py-1 font-medium">Base</th>
                <th className="py-1 font-medium">Status</th>
                <th className="py-1 font-medium">Airframe FH</th>
                <th className="py-1 font-medium">FI</th>
                <th className="py-1 font-medium">Open recs</th>
              </tr>
            </thead>
            <tbody>
              {fleet.aircraft.map((a) => (
                <tr key={a.tail} className="border-b border-(--rule)">
                  <td className="py-1">
                    <TailNumber tail={a.tail} className="text-[12px]" />
                  </td>
                  <td className="py-1 text-(--ink-2)">{a.base}</td>
                  <td className="py-1 text-(--ink-2)">{a.status}</td>
                  <td className="py-1 tabular text-(--ink-2)">{formatFH(a.airframe_fh)}</td>
                  <td className="py-1 tabular text-(--ink-2)">{formatNumber(a.fi, 1)}</td>
                  <td className="py-1 tabular text-(--ink-2)">{a.open_recs_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Top recommendations</h3>
          <ul className="flex flex-col gap-1.5">
            {fleet.top_recommendations.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 border-b border-(--rule) py-1.5 text-[12px]">
                <div className="flex items-center gap-2">
                  <PriorityTag priority={r.priority as "Critical" | "High" | "Medium" | "Low"} />
                  <span className="text-(--ink)">{r.title}</span>
                </div>
                {r.tail && <TailNumber tail={r.tail} className="text-[12px]" />}
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Due in the next 90 days</h3>
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {fleet.due_90_days.slice(0, 10).map((d, i) => (
              <li key={i} className="flex items-center justify-between border-b border-(--rule) py-1.5">
                <span>
                  <TailNumber tail={d.tail} className="mr-2 text-[12px]" />
                  {d.item}
                </span>
                <span className="tabular text-(--ink-2)">{d.date ? formatDate(d.date) : "N/A"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Reliability highlights</h3>
          <ul className="flex flex-col gap-1.5 text-[12px] text-(--ink)">
            {reliability.lot_comparison.filter((l) => l.flagged).map((l) => (
              <li key={`${l.part_number}-${l.lot}`}>
                Lot {l.lot} ({l.part_number}): {l.rate_per_1000fh.toFixed(2)}/1,000 FH vs {l.rest_of_fleet_rate_per_1000fh.toFixed(2)} fleet rest
                (p={l.p_value_bonferroni.toFixed(4)})
              </li>
            ))}
            {reliability.repeat_nff.map((r, i) => (
              <li key={i}>
                {r.tail} position {r.position}: {r.count} NFF removals within {r.window_days} days ({r.part_number})
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] text-(--ink-2)">{label}</span>
      <span className="text-[16px] font-semibold tabular text-(--ink)">{value}</span>
    </div>
  );
}
