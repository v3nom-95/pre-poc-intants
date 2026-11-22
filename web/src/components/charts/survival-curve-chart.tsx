"use client";

import { ChartFrame } from "./chart-frame";
import { LineChart } from "./line-chart";
import { ChartTable } from "./chart-table";
import { formatNumber, formatPct } from "@/lib/format";
import type { Series } from "./chart-types";

type Pt = { fh: number; survival: number };

export function SurvivalCurveChart({
  points,
  weibull = [],
  unitFhExposure,
  unit = "FH",
  method = "Kaplan-Meier",
}: {
  points: Pt[];
  /** Weibull AFT fit at the part number's fleet-average covariates (SPEC 8.3 overlay). */
  weibull?: Pt[];
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
  if (weibull.length > 0) {
    series.push({ id: "weibull", label: "Weibull fit", color: "var(--chart-cat-2)", points: weibull.map((p) => ({ x: p.fh, y: p.survival })) });
  }
  const markers = unitFhExposure != null ? [{ x: unitFhExposure, label: "This unit" }] : [];

  // Table view: both series on the union of their x values.
  const xs = Array.from(new Set([...points.map((p) => p.fh), ...weibull.map((p) => p.fh)])).sort((a, b) => a - b);
  const km = new Map(points.map((p) => [p.fh, p.survival]));
  const wb = new Map(weibull.map((p) => [p.fh, p.survival]));
  const columns = weibull.length > 0 ? [unit, method, "Weibull fit"] : [unit, method];
  const rows = xs.map((x) => {
    const r = [formatNumber(x, 1), km.has(x) ? formatPct(km.get(x)! * 100, 1) : ""];
    if (weibull.length > 0) r.push(wb.has(x) ? formatPct(wb.get(x)! * 100, 1) : "");
    return r;
  });

  return (
    <ChartFrame
      title={`Survival curve for this part number (${method} steps, delayed entry${weibull.length > 0 ? ", with Weibull fit" : ""})`}
      legend={
        weibull.length > 0 ? (
          <div className="flex items-center gap-3 text-[12px] text-(--ink-2)">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--chart-cat-1)" }} />{method}</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--chart-cat-2)" }} />Weibull fit (fleet-average covariates)</span>
          </div>
        ) : undefined
      }
      chart={
        <LineChart
          series={series}
          stepSeries={["km"]}
          yMin={0}
          yMax={1}
          markers={markers}
          xTickFormat={(x) => `${formatNumber(x, 0)} ${unit}`}
          yTickFormat={(y) => formatPct(y * 100)}
        />
      }
      table={<ChartTable columns={columns} rows={rows} />}
    />
  );
}
