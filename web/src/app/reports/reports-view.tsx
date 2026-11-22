"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TailNumber } from "@/components/domain/tail-number";
import { PriorityTag } from "@/components/domain/status-tag";
import { formatFH, formatNumber, formatPct, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AircraftTypeInfo, AircraftTypeKey, FleetData, FleetKpis, ReliabilityData } from "@/lib/data";

type TypeFilter = "all" | AircraftTypeKey;

function openRecs(k: FleetKpis) {
  return Object.values(k.open_recs_by_priority).reduce((a, b) => a + b, 0);
}

export function ReportsView({
  fleet,
  reliability,
  types,
}: {
  fleet: FleetData;
  reliability: ReliabilityData;
  types: AircraftTypeInfo[];
}) {
  const [filter, setFilter] = useState<TypeFilter>("all");
  const typeName = Object.fromEntries(types.map((t) => [t.key, t.name])) as Record<string, string>;
  const shownTypes = filter === "all" ? types : types.filter((t) => t.key === filter);
  const inScope = (type: string | null | undefined) => filter === "all" || type === filter;
  const kpis: FleetKpis = filter === "all" ? fleet.kpis : fleet.kpis.by_type[filter];

  const relRows = reliability as ReliabilityData & {
    lot_comparison: (ReliabilityData["lot_comparison"][number] & { type?: string })[];
    environmental_effects: (ReliabilityData["environmental_effects"][number] & { type?: string })[];
    repeat_nff: (ReliabilityData["repeat_nff"][number] & { type?: string })[];
  };
  const flaggedLots = relRows.lot_comparison.filter((l) => l.flagged && inScope(l.type));
  const flaggedEnv = relRows.environmental_effects.filter((e) => e.flagged && inScope(e.type));
  const repeatNff = relRows.repeat_nff.filter((r) => inScope(r.type));
  const dueItems = fleet.due_90_days.filter((d) => inScope(d.type));
  const topRecs = fleet.top_recommendations.filter((r) => inScope(r.type));

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Reports</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Aircraft type" className="flex rounded-[6px] border border-(--rule) p-[2px] text-[12px]">
            {(["all", ...types.map((t) => t.key)] as TypeFilter[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
                className={cn(
                  "rounded-[4px] px-2.5 py-1 transition-colors",
                  filter === k ? "bg-(--accent) text-(--on-accent)" : "text-(--ink-2) hover:text-(--ink)"
                )}
              >
                {k === "all" ? "All types" : typeName[k]}
              </button>
            ))}
          </div>
          <Button onClick={() => window.print()}>Print or save as PDF</Button>
        </div>
      </div>

      <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-6 print:border-0 print:p-0">
        <header className="mb-6 flex items-baseline justify-between border-b border-(--rule) pb-3">
          <div>
            <h2 className="text-[18px] font-semibold text-(--ink)">
              Fleet report{filter === "all" ? "" : `: ${typeName[filter]}`}
            </h2>
            <p className="text-[12px] text-(--ink-2)">
              Predictive Recommendation Engine (PRE): data as of {formatDate(fleet.as_of)}
            </p>
          </div>
          <p className="text-[11px] text-(--ink-2)">Proof of concept. All aircraft, data and figures are fictional.</p>
        </header>

        <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Figure label="FH (12 mo)" value={formatFH(kpis.fleet_fh_12mo)} />
          <Figure label="Serviceability" value={formatPct(kpis.serviceability_pct, 1)} />
          <Figure label="Open recommendations" value={formatNumber(openRecs(kpis))} />
          <Figure label="Due in 30 days" value={formatNumber(kpis.due_30_days_count)} />
          <Figure label="Unscheduled removals / 1,000 FH" value={formatNumber(kpis.unscheduled_removal_rate_per_1000fh, 1)} />
        </section>

        {filter === "all" && (
          <section className="mb-6 break-inside-avoid">
            <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Figures by type</h3>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-(--rule) text-left text-(--ink-2)">
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 text-right font-medium">Aircraft</th>
                  <th className="py-1 text-right font-medium">FH (12 mo)</th>
                  <th className="py-1 text-right font-medium">Serviceability</th>
                  <th className="py-1 text-right font-medium">Open recommendations</th>
                  <th className="py-1 text-right font-medium">Due in 30 days</th>
                  <th className="py-1 text-right font-medium">Removals / 1,000 FH</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {types.map((t) => {
                  const k = fleet.kpis.by_type[t.key];
                  if (!k) return null;
                  return (
                    <tr key={t.key} className="border-b border-(--rule)">
                      <td className="py-1 text-(--ink)">{t.name}</td>
                      <td className="py-1 text-right text-(--ink-2)">{k.aircraft}</td>
                      <td className="py-1 text-right text-(--ink-2)">{formatFH(k.fleet_fh_12mo)}</td>
                      <td className="py-1 text-right text-(--ink-2)">{formatPct(k.serviceability_pct, 1)}</td>
                      <td className="py-1 text-right text-(--ink-2)">{openRecs(k)}</td>
                      <td className="py-1 text-right text-(--ink-2)">{k.due_30_days_count}</td>
                      <td className="py-1 text-right text-(--ink-2)">{formatNumber(k.unscheduled_removal_rate_per_1000fh, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        <section className="mb-6">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Fleet status</h3>
          {shownTypes.map((t) => {
            const aircraft = fleet.aircraft.filter((a) => a.type === t.key);
            if (aircraft.length === 0) return null;
            return (
              <div key={t.key} className="mb-4 break-inside-avoid">
                <h4 className="mb-1 text-[12px] font-semibold text-(--ink-2)">
                  {t.name}, {aircraft.length} aircraft
                </h4>
                <table className="w-full table-fixed text-[12px]">
                  <colgroup>
                    <col className="w-[14%]" />
                    <col className="w-[14%]" />
                    <col className="w-[20%]" />
                    <col className="w-[18%]" />
                    <col className="w-[12%]" />
                    <col className="w-[22%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-(--rule) text-left text-(--ink-2)">
                      <th className="py-1 font-medium">Tail</th>
                      <th className="py-1 font-medium">Base</th>
                      <th className="py-1 font-medium">Status</th>
                      <th className="py-1 text-right font-medium">Airframe FH</th>
                      <th className="py-1 text-right font-medium">FI</th>
                      <th className="py-1 text-right font-medium">Open recommendations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aircraft.map((a) => (
                      <tr key={a.tail} className="border-b border-(--rule)">
                        <td className="py-1">
                          <TailNumber tail={a.tail} className="text-[12px]" />
                        </td>
                        <td className="py-1 text-(--ink-2)">{a.base}</td>
                        <td className="py-1 text-(--ink-2)">{a.status}</td>
                        <td className="py-1 text-right tabular text-(--ink-2)">{formatFH(a.airframe_fh)}</td>
                        <td className="py-1 text-right tabular text-(--ink-2)">{formatNumber(a.fi, 1)}</td>
                        <td className="py-1 text-right tabular text-(--ink-2)">{a.open_recs_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>

        <section className="mb-6 break-inside-avoid">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Top recommendations</h3>
          {topRecs.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">None of the fleet&apos;s top recommendations are for this type.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {topRecs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 border-b border-(--rule) py-1.5 text-[12px]">
                  <div className="flex items-center gap-2">
                    <PriorityTag priority={r.priority as "Critical" | "High" | "Medium" | "Low"} />
                    <span className="text-(--ink)">{r.title}</span>
                  </div>
                  {r.tail && <TailNumber tail={r.tail} className="shrink-0 text-[12px]" />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-6 break-inside-avoid">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Due in the next 90 days</h3>
          {dueItems.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">No items due in the next 90 days.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-(--rule) text-left text-(--ink-2)">
                  <th className="py-1 font-medium">Tail</th>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 font-medium">Item</th>
                  <th className="py-1 text-right font-medium">Due</th>
                </tr>
              </thead>
              <tbody>
                {dueItems.map((d, i) => (
                  <tr key={i} className="border-b border-(--rule)">
                    <td className="py-1">
                      <TailNumber tail={d.tail} className="text-[12px]" />
                    </td>
                    <td className="py-1 text-(--ink-2)">{typeName[d.type] ?? d.type}</td>
                    <td className="py-1 text-(--ink)">{d.item}</td>
                    <td className="py-1 text-right tabular text-(--ink-2)">
                      {d.date
                        ? formatDate(d.date)
                        : d.fh_to_tau !== undefined && d.fh_to_tau !== null
                          ? `${formatFH(d.fh_to_tau)} to risk threshold`
                          : "Not dated"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="break-inside-avoid">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Reliability highlights</h3>
          <ul className="flex flex-col gap-1.5 text-[12px] text-(--ink)">
            {flaggedLots.map((l) => (
              <li key={`${l.part_number}-${l.lot}`}>
                Lot {l.lot} ({l.part_number}, {typeName[l.type ?? ""] ?? "fleet"}): {formatNumber(l.rate_per_1000fh, 2)} failures
                per 1,000 FH against {formatNumber(l.rest_of_fleet_rate_per_1000fh, 2)} for the rest of the fleet (p=
                {l.p_value_bonferroni.toFixed(4)}, Bonferroni corrected).
              </li>
            ))}
            {flaggedEnv.map((e) => (
              <li key={`env-${e.part_number}`}>
                Hot-climate effect on {e.name.toLowerCase()} ({e.part_number}, {typeName[e.type ?? ""] ?? "fleet"}): expected
                life x{formatNumber(e.time_ratio_full_hot_exposure, 2)} at full hot exposure (p={e.p_value.toFixed(4)}).
              </li>
            ))}
            {repeatNff.map((r, i) => (
              <li key={i}>
                {r.tail} position {r.position}: {r.count} NFF removals within {r.window_days} days ({r.part_number}).
              </li>
            ))}
            {flaggedLots.length + flaggedEnv.length + repeatNff.length === 0 && (
              <li className="text-(--ink-2)">No flagged lots, environmental effects or repeat NFF removals for this type.</li>
            )}
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
