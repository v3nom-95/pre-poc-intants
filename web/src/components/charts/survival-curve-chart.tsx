"use client";

import { ChartFrame } from "./chart-frame";
import { LineChart } from "./line-chart";
import { ChartTable } from "./chart-table";
import { formatNumber, formatPct } from "@/lib/format";
import type { Series } from "./chart-types";

export function SurvivalCurveChart({
  points,
  unitFhExposure,
  unit = "FH",
  method = "Kaplan-Meier",
}: {
  points: { fh: number; survival: number }[];
  unitFhExposure: number | null;
  /** Exposure unit of the part number: FH, or APU hours for the APU. */
  unit?: string;
  /** Nonparametric estimator used by the export (delayed entry). */
  method?: string;
}) {
  if (points.length === 0) return <p className="text-[12px] text-(--ink-2)">Not enough fleet-wide events to fit a survival curve for this part number.</p>;
  const series: Series[] = [
    { id: "km", label: method, color: "var(--chart-cat-1)", points: points.map((p) => ({ x: p.fh, y: p.survival })) },
  ];
  const markers = unitFhExposure != null ? [{ x: unitFhExposure, label: "This unit" }] : [];

  return (
    <ChartFrame
      title={`Survival curve for this part number (${method}, delayed entry)`}
      chart={<LineChart series={series} yMin={0} yMax={1} markers={markers} xTickFormat={(x) => `${formatNumber(x, 0)} ${unit}`} yTickFormat={(y) => formatPct(y * 100)} />}
      table={<ChartTable columns={[unit, "Survival"]} rows={points.map((p) => [formatNumber(p.fh, 1), formatPct(p.survival * 100, 1)])} />}
    />
  );
}
