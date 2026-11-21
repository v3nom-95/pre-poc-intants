"use client";

import { ChartFrame } from "@/components/charts/chart-frame";
import { RankedBarChart } from "@/components/charts/ranked-bar-chart";
import { DotPlot } from "@/components/charts/dot-plot";
import { LineChart } from "@/components/charts/line-chart";
import { ChartTable } from "@/components/charts/chart-table";
import { formatFH, formatNumber, formatPct } from "@/lib/format";
import type { ReliabilityData } from "@/lib/data";
import type { Series } from "@/components/charts/chart-types";

export function ReliabilityView({ data }: { data: ReliabilityData }) {
  const ataData = data.snags_by_ata.map((d) => ({ label: `ATA ${d.ata}`, value: d.count }));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[28px] font-semibold text-(--ink) page-title">Reliability</h1>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <ChartFrame
          title="Snags by ATA chapter"
          chart={<RankedBarChart data={ataData} showCumulativeShare valueFormat={(v) => formatNumber(v)} />}
          table={
            <ChartTable
              columns={["ATA", "Count", "Cumulative share"]}
              rows={data.snags_by_ata.map((d) => [`ATA ${d.ata}`, formatNumber(d.count), formatPct(d.cumulative_share * 100, 1)])}
            />
          }
        />
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">MTBF / MTBUR per part number</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-medium">Part</th>
                <th className="pb-1.5 font-medium">MTBF (FH)</th>
                <th className="pb-1.5 font-medium">MTBUR (FH)</th>
                <th className="pb-1.5 font-medium">NFF rate</th>
              </tr>
            </thead>
            <tbody>
              {data.mtbf_mtbur.map((r) => (
                <tr key={r.part_number} className="border-t border-(--rule)">
                  <td className="py-1.5 text-(--ink)">{r.name}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.mtbf_fh !== null ? formatFH(r.mtbf_fh) : "N/A"}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.mtbur_fh !== null ? formatFH(r.mtbur_fh) : "N/A"}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{formatPct(r.nff_rate * 100, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.mtbf_mtbur.some((r) => r.mtbf_fh !== null) && (
          <div className="mt-4 border-t border-(--rule) pt-4">
            <DotPlot
              data={data.mtbf_mtbur
                .filter((r): r is typeof r & { mtbf_fh: number } => r.mtbf_fh !== null)
                .map((r) => ({ label: r.name, value: r.mtbf_fh }))}
              valueFormat={(v) => formatFH(v)}
            />
          </div>
        )}
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <ChartFrame
          title="Unscheduled removal rate per 1,000 FH (monthly, fleet)"
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
              columns={["Month", "Rate / 1,000 FH"]}
              rows={data.removal_rate_monthly.map((m) => [m.month, m.rate_per_1000fh.toFixed(2)])}
            />
          }
        />
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Manufacturing lot comparison</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-medium">Part</th>
                <th className="pb-1.5 font-medium">Lot</th>
                <th className="pb-1.5 font-medium">Units</th>
                <th className="pb-1.5 font-medium">Events</th>
                <th className="pb-1.5 font-medium">Rate / 1,000 FH</th>
                <th className="pb-1.5 font-medium">Rest of fleet</th>
                <th className="pb-1.5 font-medium">p-value</th>
                <th className="pb-1.5 font-medium">Flagged</th>
              </tr>
            </thead>
            <tbody>
              {data.lot_comparison.map((r) => (
                <tr key={`${r.part_number}-${r.lot}`} className={`border-t border-(--rule) ${r.flagged ? "bg-(--status-critical)/5" : ""}`}>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.part_number}</td>
                  <td className="py-1.5 text-(--ink)">{r.lot}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.n_units}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.events}</td>
                  <td className="py-1.5 tabular font-medium text-(--ink)">{r.rate_per_1000fh.toFixed(2)}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.rest_of_fleet_rate_per_1000fh.toFixed(2)}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.p_value_bonferroni.toFixed(4)}</td>
                  <td className="py-1.5">{r.flagged ? <span className="text-(--status-critical)">Yes</span> : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Hot vs temperate exposure effect</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-medium">Part</th>
                <th className="pb-1.5 font-medium">Time ratio (full hot exposure)</th>
                <th className="pb-1.5 font-medium">p-value</th>
                <th className="pb-1.5 font-medium">Flagged</th>
              </tr>
            </thead>
            <tbody>
              {data.environmental_effects.map((r) => (
                <tr key={r.part_number} className="border-t border-(--rule)">
                  <td className="py-1.5 text-(--ink)">{r.name}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">x{r.time_ratio_full_hot_exposure.toFixed(2)}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{r.p_value.toFixed(4)}</td>
                  <td className="py-1.5">{r.flagged ? <span className="text-(--status-critical)">Yes</span> : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Repeat snags (no-fault-found pattern)</h3>
        {data.repeat_nff.length === 0 ? (
          <p className="text-[12px] text-(--ink-2)">No repeat no-fault-found patterns detected.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.repeat_nff.map((r, i) => (
              <li key={i} className="rounded-[6px] border border-(--rule) p-2.5 text-[12px] text-(--ink)">
                {r.tail}, position {r.position}: {r.count} NFF removals within {r.window_days} days ({r.part_number})
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
