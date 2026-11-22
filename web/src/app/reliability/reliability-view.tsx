"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ChartFrame } from "@/components/charts/chart-frame";
import { RankedBarChart } from "@/components/charts/ranked-bar-chart";
import { DotPlot } from "@/components/charts/dot-plot";
import { LineChart } from "@/components/charts/line-chart";
import { ChartTable } from "@/components/charts/chart-table";
import { TypeFilter } from "@/components/plan/type-filter";
import { formatDate, formatFH, formatNumber, formatPct } from "@/lib/format";
import type { ReliabilityData } from "@/lib/data";
import type { Series } from "@/components/charts/chart-types";

type TypeRef = { key: string; name: string; tails: number };

const TOP_PARTS = 15;

/** Flag cell: ink text plus a status icon, never status color alone. */
function FlagCell({ flagged }: { flagged: boolean }) {
  return flagged ? (
    <span className="inline-flex items-center gap-1 font-medium text-(--ink)">
      <AlertTriangle className="size-3.5 text-(--status-critical)" strokeWidth={2} aria-hidden />
      Yes
    </span>
  ) : (
    <span className="text-(--ink-2)">No</span>
  );
}

export function ReliabilityView({ data, types }: { data: ReliabilityData; types: TypeRef[] }) {
  const [typeFilter, setTypeFilter] = useState("All");
  const all = typeFilter === "All";
  const typeName = useMemo(() => new Map(types.map((t) => [t.key, t.name])), [types]);
  const scopeLabel = all ? "fleet, all types" : typeName.get(typeFilter) ?? typeFilter;
  const byType = <T extends { type: string | null }>(rows: T[]) => (all ? rows : rows.filter((r) => r.type === typeFilter));

  const snags = all
    ? data.snags_by_ata
    : data.snags_by_ata_by_type[typeFilter as keyof typeof data.snags_by_ata_by_type] ?? [];
  const ataData = snags.map((d) => ({ label: `ATA ${d.ata}`, value: d.count }));
  const mtbf = byType(data.mtbf_mtbur);
  const ratePerPart = byType(data.removal_rate_per_part)
    .filter((r) => r.fh_exposure > 0)
    .sort((a, b) => b.removal_rate_per_1000fh - a.removal_rate_per_1000fh);
  const lots = byType(data.lot_comparison);
  const env = byType(data.environmental_effects);
  const repeats = byType(data.repeat_nff);
  const showTypeCol = all;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Reliability</h1>
        <TypeFilter
          types={types.map((t) => ({ key: t.key, name: t.name, count: t.tails }))}
          value={typeFilter}
          onChange={setTypeFilter}
          allCount={types.reduce((s, t) => s + t.tails, 0)}
          label="Aircraft type (aircraft)"
        />
      </div>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <ChartFrame
          title={`Snags by ATA chapter (${scopeLabel})`}
          chart={
            ataData.length ? (
              <RankedBarChart data={ataData} showCumulativeShare valueFormat={(v) => formatNumber(v)} />
            ) : (
              <p className="text-[12px] text-(--ink-2)">No snags recorded for this aircraft type.</p>
            )
          }
          table={
            <ChartTable
              columns={["ATA", "Snags", "Cumulative share"]}
              rows={snags.map((d) => [`ATA ${d.ata}`, formatNumber(d.count), formatPct(d.cumulative_share * 100, 1)])}
            />
          }
        />
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">MTBF and MTBUR per part number ({scopeLabel})</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-medium">Part</th>
                {showTypeCol && <th className="pb-1.5 font-medium">Type</th>}
                <th className="pb-1.5 font-medium">Part number</th>
                <th className="pb-1.5 font-medium">MTBF</th>
                <th className="pb-1.5 font-medium">MTBUR</th>
                <th className="pb-1.5 font-medium">NFF rate</th>
              </tr>
            </thead>
            <tbody>
              {mtbf.map((r) => (
                <tr key={r.part_number} className="border-t border-(--rule)">
                  <td className="py-1.5 text-(--ink)">{r.name}</td>
                  {showTypeCol && <td className="py-1.5 text-(--ink-2)">{typeName.get(r.type) ?? r.type}</td>}
                  <td className="py-1.5 tabular text-(--ink-2)">{r.part_number}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.mtbf_fh !== null ? formatFH(r.mtbf_fh) : "No confirmed failures"}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.mtbur_fh !== null ? formatFH(r.mtbur_fh) : "No unscheduled removals"}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{formatPct(r.nff_rate * 100, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mtbf.some((r) => r.mtbf_fh !== null) && (
          <div className="mt-4 border-t border-(--rule) pt-4">
            <DotPlot
              data={mtbf
                .filter((r): r is typeof r & { mtbf_fh: number } => r.mtbf_fh !== null)
                .map((r) => ({ label: all ? `${r.name} (${typeName.get(r.type) ?? r.type})` : r.name, value: r.mtbf_fh }))}
              valueFormat={(v) => formatFH(v)}
            />
          </div>
        )}
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <ChartFrame
          title="Unscheduled removal rate per 1,000 FH (monthly, fleet, all types)"
          chart={
            <LineChart
              series={[
                {
                  id: "removal-rate",
                  label: "Removal rate",
                  color: "var(--chart-cat-1)",
                  points: data.removal_rate_monthly.map((m, i) => ({ x: i, y: m.rate_per_1000fh })),
                },
              ] satisfies Series[]}
              xTickFormat={(i) => data.removal_rate_monthly[Math.round(i)]?.month ?? ""}
              yTickFormat={(y) => y.toFixed(1)}
            />
          }
          table={
            <ChartTable
              columns={["Month", "Removals per 1,000 FH"]}
              rows={data.removal_rate_monthly.map((m) => [m.month, m.rate_per_1000fh.toFixed(2)])}
            />
          }
        />
        <p className="mt-2 text-[11px] text-(--ink-2)">
          The monthly series is exported for the whole fleet. The chart below breaks the rate down by part number for
          the selected type.
        </p>
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <ChartFrame
          title={`Confirmed failure rate per 1,000 FH by part number, 5 years (${scopeLabel}${
            ratePerPart.length > TOP_PARTS ? `, highest ${TOP_PARTS} of ${ratePerPart.length}; table lists all` : ""
          })`}
          chart={
            ratePerPart.length ? (
              <RankedBarChart
                data={ratePerPart.slice(0, TOP_PARTS).map((r) => ({
                  label: all ? `${r.name ?? r.part_number} (${typeName.get(r.type ?? "") ?? r.type})` : r.name ?? r.part_number,
                  value: r.removal_rate_per_1000fh,
                }))}
                valueFormat={(v) => v.toFixed(2)}
              />
            ) : (
              <p className="text-[12px] text-(--ink-2)">No exposure recorded for this aircraft type.</p>
            )
          }
          table={
            <ChartTable
              columns={["Part", "Type", "Part number", "Confirmed failures", "Exposure", "Per 1,000 FH"]}
              rows={ratePerPart.map((r) => [
                r.name ?? r.part_number,
                typeName.get(r.type ?? "") ?? r.type ?? "",
                r.part_number,
                formatNumber(r.confirmed_failures),
                formatFH(r.fh_exposure),
                r.removal_rate_per_1000fh.toFixed(2),
              ])}
            />
          }
        />
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Manufacturing lot comparison ({scopeLabel})</h3>
        {lots.length === 0 ? (
          <p className="text-[12px] text-(--ink-2)">No lot comparison for this aircraft type: its part numbers have a single lot or too few units.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-(--ink-2)">
                  <th className="pb-1.5 font-medium">Part number</th>
                  {showTypeCol && <th className="pb-1.5 font-medium">Type</th>}
                  <th className="pb-1.5 font-medium">Lot</th>
                  <th className="pb-1.5 font-medium">Units</th>
                  <th className="pb-1.5 font-medium">Failures</th>
                  <th className="pb-1.5 font-medium">Per 1,000 FH</th>
                  <th className="pb-1.5 font-medium">Rest of fleet</th>
                  <th className="pb-1.5 font-medium">p-value (Bonferroni)</th>
                  <th className="pb-1.5 font-medium">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((r) => (
                  <tr
                    key={`${r.part_number}-${r.lot}`}
                    className={`border-t border-(--rule) ${r.flagged ? "bg-(--status-critical)/5" : ""}`}
                  >
                    <td className="py-1.5 tabular text-(--ink-2)">{r.part_number}</td>
                    {showTypeCol && <td className="py-1.5 text-(--ink-2)">{typeName.get(r.type) ?? r.type}</td>}
                    <td className="py-1.5 text-(--ink)">{r.lot}</td>
                    <td className="py-1.5 tabular text-(--ink-2)">{r.n_units}</td>
                    <td className="py-1.5 tabular text-(--ink-2)">{r.events}</td>
                    <td className="py-1.5 tabular font-medium text-(--ink)">{r.rate_per_1000fh.toFixed(2)}</td>
                    <td className="py-1.5 tabular text-(--ink-2)">{r.rest_of_fleet_rate_per_1000fh.toFixed(2)}</td>
                    <td className="py-1.5 tabular text-(--ink-2)">{r.p_value_bonferroni.toFixed(4)}</td>
                    <td className="py-1.5">
                      <FlagCell flagged={r.flagged} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-1 text-[13px] font-semibold text-(--ink)">Hot vs temperate exposure effect ({scopeLabel})</h3>
        <p className="mb-3 text-[11px] text-(--ink-2)">
          Survival model time ratio for a unit flown entirely at a hot base and month (35 °C or above). Below 1 means
          shorter life. Flagged when p is below 0.01.
        </p>
        {env.length === 0 ? (
          <p className="text-[12px] text-(--ink-2)">No hot-climate effect fitted for this aircraft type.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-(--ink-2)">
                  <th className="pb-1.5 font-medium">Part</th>
                  {showTypeCol && <th className="pb-1.5 font-medium">Type</th>}
                  <th className="pb-1.5 font-medium">Part number</th>
                  <th className="pb-1.5 font-medium">Time ratio (full hot exposure)</th>
                  <th className="pb-1.5 font-medium">p-value</th>
                  <th className="pb-1.5 font-medium">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {env.map((r) => (
                  <tr key={r.part_number} className="border-t border-(--rule)">
                    <td className="py-1.5 text-(--ink)">{r.name}</td>
                    {showTypeCol && <td className="py-1.5 text-(--ink-2)">{typeName.get(r.type) ?? r.type}</td>}
                    <td className="py-1.5 tabular text-(--ink-2)">{r.part_number}</td>
                    <td className="py-1.5 tabular text-(--ink-2)">x{r.time_ratio_full_hot_exposure.toFixed(2)}</td>
                    <td className="py-1.5 tabular text-(--ink-2)">{r.p_value.toFixed(4)}</td>
                    <td className="py-1.5">
                      <FlagCell flagged={r.flagged} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Repeat snags, no fault found pattern ({scopeLabel})</h3>
        {repeats.length === 0 ? (
          <p className="text-[12px] text-(--ink-2)">No repeat no-fault-found patterns detected for this aircraft type.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {repeats.map((r, i) => (
              <li key={i} className="rounded-[6px] border border-(--rule) p-2.5 text-[12px] text-(--ink)">
                <span className="font-semibold">{r.tail}</span> ({typeName.get(r.type) ?? r.type}), ATA {r.part_number.slice(0, 2)}{" "}
                part {r.part_number}, position {r.position}: {r.count} NFF removals within {r.window_days} days
                {"first_in_window" in r && r.first_in_window && "last_in_window" in r && r.last_in_window
                  ? `, ${formatDate(String(r.first_in_window))} to ${formatDate(String(r.last_in_window))}`
                  : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
