"use client";

import { ChartFrame } from "./chart-frame";
import { ChartLegend } from "./chart-frame";
import { LineChart } from "./line-chart";
import { ChartTable } from "./chart-table";
import { formatFH } from "@/lib/format";
import type { Series } from "./chart-types";

export function UtilisationChart({
  months,
}: {
  months: { month: string; base_a_fh: number; base_b_fh: number }[];
}) {
  const series: Series[] = [
    {
      id: "base-a",
      label: "Base A",
      color: "var(--chart-cat-1)",
      points: months.map((m, i) => ({ x: i, y: m.base_a_fh })),
    },
    {
      id: "base-b",
      label: "Base B",
      color: "var(--chart-cat-2)",
      points: months.map((m, i) => ({ x: i, y: m.base_b_fh })),
    },
  ];
  const monthLabel = (idx: number) => months[Math.round(idx)]?.month ?? "";

  return (
    <ChartFrame
      title="Utilisation: monthly flight hours by base (24 months)"
      legend={<ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      chart={<LineChart series={series} xTickFormat={monthLabel} yTickFormat={(y) => String(y)} />}
      table={
        <ChartTable
          columns={["Month", "Base A (FH)", "Base B (FH)"]}
          rows={months.map((m) => [m.month, formatFH(m.base_a_fh), formatFH(m.base_b_fh)])}
        />
      }
    />
  );
}
