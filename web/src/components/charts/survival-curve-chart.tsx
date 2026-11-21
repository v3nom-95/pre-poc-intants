"use client";

import { ChartFrame } from "./chart-frame";
import { LineChart } from "./line-chart";
import { ChartTable } from "./chart-table";
import { formatPct } from "@/lib/format";
import type { Series } from "./chart-types";

export function SurvivalCurveChart({
  points,
  unitFhExposure,
}: {
  points: { fh: number; survival: number }[];
  unitFhExposure: number | null;
}) {
  if (points.length === 0) return <p className="text-[12px] text-(--ink-2)">Not enough fleet-wide events to fit a survival curve for this part number.</p>;
  const series: Series[] = [
    { id: "km", label: "Kaplan-Meier", color: "var(--chart-cat-1)", points: points.map((p) => ({ x: p.fh, y: p.survival })) },
  ];
  const markers = unitFhExposure != null ? [{ x: unitFhExposure, label: "This unit" }] : [];

  return (
    <ChartFrame
      title="Survival curve for this part number (Kaplan-Meier)"
      chart={<LineChart series={series} yMin={0} yMax={1} markers={markers} xTickFormat={(x) => `${Math.round(x)}`} yTickFormat={(y) => formatPct(y * 100)} />}
      table={<ChartTable columns={["FH", "Survival"]} rows={points.map((p) => [p.fh.toFixed(1), formatPct(p.survival * 100, 1)])} />}
    />
  );
}
