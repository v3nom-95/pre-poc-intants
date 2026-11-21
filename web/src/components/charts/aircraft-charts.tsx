"use client";

import { ChartFrame, ChartLegend } from "./chart-frame";
import { LineChart } from "./line-chart";
import { StackedBarChart } from "./stacked-bar-chart";
import { ChartTable } from "./chart-table";
import { formatFH, formatDate } from "@/lib/format";
import type { Series, StackedBarDatum } from "./chart-types";
import type { AircraftData } from "@/lib/data";

const MISSION_COLORS: Record<string, string> = {
  "Air combat manoeuvring": "var(--chart-cat-1)",
  "Ground attack": "var(--chart-cat-2)",
  "Air defence": "var(--chart-cat-3)",
  "General flying": "var(--chart-cat-4)",
  "Navigation / ferry": "var(--chart-cat-5)",
  "Functional test flight": "var(--chart-cat-6)",
};

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export function MissionMixChart({ utilisation }: { utilisation: AircraftData["utilisation_monthly"] }) {
  const missions = Object.keys(MISSION_COLORS).filter((m) => utilisation.some((u) => m in u));
  // Every month's data is still in the table view; the chart only labels
  // every 3rd bar (quarterly) since 24 monthly labels packed into one
  // chart width overlap into illegible text.
  const sparseLabel = new Map(
    utilisation.map((u, i) => [String(u.month), i % 3 === 0 ? monthLabel(String(u.month)) : ""])
  );
  const data: StackedBarDatum[] = utilisation.map((u) => ({
    category: String(u.month),
    segments: missions
      .filter((m) => Number(u[m] ?? 0) > 0)
      .map((m) => ({ key: m, value: Number(u[m] ?? 0), color: MISSION_COLORS[m], label: m })),
  }));

  return (
    <ChartFrame
      title="Utilisation by mission (24 months)"
      legend={<ChartLegend items={missions.map((m) => ({ label: m, color: MISSION_COLORS[m] }))} />}
      chart={<StackedBarChart data={data} xTickFormat={(x) => sparseLabel.get(String(x)) ?? ""} />}
      table={
        <ChartTable
          columns={["Month", ...missions]}
          rows={utilisation.map((u) => [String(u.month), ...missions.map((m) => formatFH(Number(u[m] ?? 0)))])}
        />
      }
    />
  );
}

export function FatigueChart({
  fiSeries,
  withdrawalYear,
  projectedFi100Date,
}: {
  fiSeries: { date: string; fi: number }[];
  withdrawalYear: number;
  projectedFi100Date?: string | null;
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
  // calendar date (not a point lookup, since d3's "nice" tick values won't
  // land exactly on a data point's day offset).
  const dayTickFormat = (x: number) => {
    const d = new Date(t0 + x * 86400000);
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  };
  return (
    <ChartFrame
      title="Fatigue index: actual and projected"
      legend={<ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      chart={<LineChart series={series} yMax={100} xTickFormat={dayTickFormat} yTickFormat={(y) => String(y)} markers={markers} />}
      table={<ChartTable columns={["Date", "FI"]} rows={fiSeries.map((p) => [formatDate(p.date), p.fi.toFixed(1)])} />}
    />
  );
}

export function EngineTrendChart({ points }: { points: { efh: number; margin: number }[] }) {
  if (points.length === 0) return <p className="text-[12px] text-(--ink-2)">No engine trend data for the current engine.</p>;
  const series: Series[] = [
    { id: "egt", label: "EGT margin", color: "var(--chart-cat-1)", points: points.map((p) => ({ x: p.efh, y: p.margin })) },
  ];
  return (
    <ChartFrame
      title="EGT margin vs EFH since install"
      chart={<LineChart series={series} xTickFormat={(x) => `${Math.round(x)}`} yTickFormat={(y) => `${y}°C`} />}
      table={<ChartTable columns={["EFH", "EGT margin (°C)"]} rows={points.map((p) => [p.efh.toFixed(1), p.margin.toFixed(1)])} />}
    />
  );
}
