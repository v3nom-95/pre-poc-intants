"use client";

import { useState } from "react";
import { ChartFrame, ChartLegend } from "./chart-frame";
// ChartLegend is still used by the fatigue and engine charts below.
import { LineChart } from "./line-chart";
import { StackedBarChart } from "./stacked-bar-chart";
import { ChartTable } from "./chart-table";
import { formatFH, formatDate, formatMonth, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Series, StackedBarDatum } from "./chart-types";
import type { AircraftData, InstalledEngine } from "@/lib/data";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Mission colours follow the mission's slot (1 to 6) within its aircraft type (SPEC 14.1). */
function missionColor(slot: number) {
  return `var(--chart-cat-${Math.min(Math.max(slot, 1), 6)})`;
}

export function MissionMixChart({
  utilisation,
  missions,
}: {
  utilisation: AircraftData["utilisation_monthly"];
  /** The aircraft type's missions in slot order, from types.json. */
  missions: { name: string; slot: number }[];
}) {
  const ordered = [...missions].sort((a, b) => a.slot - b.slot);
  // Every month's data is still in the table view; the chart only labels
  // every 3rd bar (quarterly) since 24 monthly labels packed into one
  // chart width overlap into illegible text.
  const sparseLabel = new Map(
    utilisation.map((u, i) => [String(u.month), i % 3 === 0 ? formatMonth(String(u.month)) : ""])
  );
  const data: StackedBarDatum[] = utilisation.map((u) => ({
    category: String(u.month),
    segments: ordered
      .filter((m) => Number(u[m.name] ?? 0) > 0)
      .map((m) => ({ key: m.name, value: Number(u[m.name] ?? 0), color: missionColor(m.slot), label: m.name })),
  }));

  return (
    <ChartFrame
      title={`Utilisation by mission (${utilisation.length} months)`}
      chart={
        <div className="flex flex-col gap-2">
          {/* Legend on its own wrapping row: six mission names do not fit beside the title. */}
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {ordered.map((m) => (
              <li key={m.name} className="flex items-center gap-1.5 text-[11px] text-(--ink-2)">
                <span className="inline-block size-2 rounded-full" style={{ background: missionColor(m.slot) }} />
                {m.name}
              </li>
            ))}
          </ul>
          <StackedBarChart data={data} xTickFormat={(x) => sparseLabel.get(String(x)) ?? ""} />
        </div>
      }
      table={
        <ChartTable
          columns={["Month", ...ordered.map((m) => `${m.name} (FH)`), "Total (FH)"]}
          rows={utilisation.map((u) => [
            formatMonth(String(u.month)),
            ...ordered.map((m) => formatFH(Number(u[m.name] ?? 0), 1)),
            formatFH(ordered.reduce((s, m) => s + Number(u[m.name] ?? 0), 0), 1),
          ])}
        />
      }
    />
  );
}

export function FatigueChart({
  fiSeries,
  withdrawalYear,
  projectedFi100Date,
  fatigueModel,
}: {
  fiSeries: { date: string; fi: number }[];
  withdrawalYear: number;
  projectedFi100Date?: string | null;
  fatigueModel?: string;
}) {
  if (fiSeries.length === 0) return <p className="text-[12px] text-(--ink-2)">No fatigue data.</p>;
  const t0 = new Date(fiSeries[0].date).getTime();
  const dayOf = (d: string) => (new Date(d).getTime() - t0) / (1000 * 60 * 60 * 24);
  const lastPoint = fiSeries[fiSeries.length - 1];

  const series: Series[] = [
    { id: "fi", label: "Actual", color: "var(--chart-cat-1)", points: fiSeries.map((p) => ({ x: dayOf(p.date), y: p.fi })) },
  ];
  if (projectedFi100Date) {
    series.push({
      id: "projection",
      label: "Projected",
      color: "var(--status-action-due)",
      points: [
        { x: dayOf(lastPoint.date), y: lastPoint.fi },
        { x: dayOf(projectedFi100Date), y: 100 },
      ],
    });
  }
  const withdrawalDay = dayOf(`${withdrawalYear}-01-01`);
  const markers = [{ x: withdrawalDay, label: `Planned withdrawal ${withdrawalYear}`, color: "var(--ink-3)" }];

  // Convert the axis's auto-picked day-offset ticks straight back to a
  // calendar month (d3's "nice" tick values won't land on a data point).
  const dayTickFormat = (x: number) => {
    const d = new Date(t0 + x * 86400000);
    return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  return (
    <div className="flex flex-col gap-1">
      <ChartFrame
        title="Fatigue index: actual and projected"
        legend={<ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
        chart={<LineChart series={series} yMax={100} xTickFormat={dayTickFormat} yTickFormat={(y) => String(y)} markers={markers} />}
        table={<ChartTable columns={["Date", "FI (0 to 100)"]} rows={fiSeries.map((p) => [formatDate(p.date), p.fi.toFixed(1)])} />}
      />
      {fatigueModel && <p className="text-[11px] text-(--ink-2)">Fatigue model for this type: {fatigueModel}.</p>}
    </div>
  );
}

/** One engine's margin readings with the robust trend, its interval and the projection to the limit. */
function EngineTrendChart({ engine }: { engine: InstalledEngine }) {
  const { trend_points: points, trend_info: info, metric, threshold_c } = engine;
  if (points.length === 0) {
    return <p className="text-[12px] text-(--ink-2)">No {metric} readings for this engine since installation.</p>;
  }
  const xs = points.map((p) => p.efh);
  const xMin = Math.min(...xs);
  let xMax = Math.max(...xs);

  const series: Series[] = [
    { id: "readings", label: `${metric} readings`, color: "var(--chart-cat-1)", points: points.map((p) => ({ x: p.efh, y: p.margin })) },
  ];

  if (info) {
    // Trend fitted on the trailing window ending at the current EFH; shown
    // from the window start to the projected crossing (or the last reading
    // when the projection is far away), with the slope interval as a band.
    const end =
      info.projected_efh_to_limit !== null && info.projected_efh_to_limit <= 400
        ? info.current_efh + info.projected_efh_to_limit
        : info.current_efh;
    const start = Math.max(xMin, info.current_efh - 150);
    const at = (e: number, slope: number) => info.current_margin_c + slope * (e - info.current_efh);
    const steps = 12;
    const trendPts = Array.from({ length: steps + 1 }, (_, i) => {
      const e = start + ((end - start) * i) / steps;
      const a = at(e, info.slope_c_per_efh);
      const b1 = at(e, info.slope_ci_lo);
      const b2 = at(e, info.slope_ci_hi);
      return { x: e, y: a, yLow: Math.min(b1, b2), yHigh: Math.max(b1, b2) };
    });
    series.push({ id: "trend", label: "Robust trend (Theil-Sen, 95% interval)", color: "var(--chart-cat-2)", points: trendPts });
    xMax = Math.max(xMax, end);
  }
  series.push({
    id: "limit",
    label: `Limit ${formatNumber(threshold_c, 0)} °C`,
    color: "var(--status-critical)",
    points: [
      { x: xMin, y: threshold_c },
      { x: xMax, y: threshold_c },
    ],
  });

  return (
    <ChartFrame
      title={`${metric} against EFH, engine ${engine.position} (${engine.serial})`}
      legend={<ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      chart={
        <LineChart
          series={series}
          yMin={0}
          xTickFormat={(x) => `${formatNumber(x, 0)}`}
          yTickFormat={(y) => `${y} °C`}
        />
      }
      table={
        <ChartTable
          columns={["EFH", `${metric} (°C)`]}
          rows={points.map((p) => [formatNumber(p.efh, 1), formatNumber(p.margin, 1)])}
        />
      }
    />
  );
}

export function EnginePanel({ engines }: { engines: InstalledEngine[] }) {
  const [selected, setSelected] = useState(0);
  if (engines.length === 0) return <p className="text-[12px] text-(--ink-2)">No engine installed in the records.</p>;
  const engine = engines[Math.min(selected, engines.length - 1)];
  const info = engine.trend_info;

  return (
    <div className="flex flex-col gap-3">
      {engines.length > 1 && (
        <div role="group" aria-label="Select engine" className="flex w-fit rounded-[6px] border border-(--rule) p-[2px] text-[12px]">
          {engines.map((e, i) => (
            <button
              key={e.position}
              type="button"
              aria-pressed={i === selected}
              onClick={() => setSelected(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 transition-colors",
                i === selected ? "bg-(--accent) text-(--on-accent)" : "text-(--ink-2) hover:text-(--ink)"
              )}
            >
              Engine {e.position}
              {e.trend_info?.flagged && (
                <span className={cn("text-[10px] font-semibold", i === selected ? "text-(--on-accent)" : "text-(--status-critical)")}>
                  flagged
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <EngineTrendChart engine={engine} />
      {info ? (
        <p className="text-[12px] text-(--ink-2)">
          Slope {formatNumber(info.slope_c_per_efh, 3)} °C per EFH (95% interval {formatNumber(info.slope_ci_lo, 3)} to{" "}
          {formatNumber(info.slope_ci_hi, 3)}); fleet median for {info.metric} {formatNumber(info.fleet_median_slope, 3)} °C per
          EFH.{" "}
          {info.projected_efh_to_limit !== null
            ? `Projected to reach the ${formatNumber(info.limit_c, 0)} °C limit in ${formatNumber(info.projected_efh_to_limit, 0)} EFH.`
            : "No crossing of the limit is projected at this slope."}{" "}
          {info.flagged ? (
            <span className="font-medium text-(--status-critical)">
              Flagged: {info.flag_fleet_outlier ? "deteriorating faster than the fleet" : ""}
              {info.flag_fleet_outlier && info.flag_near_term ? " and " : ""}
              {info.flag_near_term ? "projected crossing under 100 EFH" : ""}.
            </span>
          ) : (
            "Not flagged."
          )}
        </p>
      ) : (
        <p className="text-[12px] text-(--ink-2)">
          Too little history since installation for a trend (needs at least 100 EFH and 30 readings).
        </p>
      )}
    </div>
  );
}
