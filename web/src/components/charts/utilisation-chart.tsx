"use client";

import { useState } from "react";
import { ChartFrame, ChartLegend } from "./chart-frame";
import { LineChart } from "./line-chart";
import { ChartTable } from "./chart-table";
import { formatDate, formatFH, formatMonth } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Series } from "./chart-types";

type Month = Record<string, string | number> & { month: string };

export interface UtilisationGroup {
  /** Column in utilisation_monthly, for example "fighter_fh" or "base_a_fh". */
  field: string;
  label: string;
}

/**
 * Monthly fleet flight hours, grouped either by aircraft type or by base.
 * Colours follow the entity: types take slots 1 to 3 in fleet order, bases
 * take slots 1 and 2, and switching grouping is an explicit user action.
 */
export function UtilisationChart({
  months,
  byType,
  byBase,
  asOf,
}: {
  months: Month[];
  /** As-of date, used to mark the last month as partial when it is the as-of month. */
  asOf?: string;
  byType: UtilisationGroup[];
  byBase: UtilisationGroup[];
}) {
  const [grouping, setGrouping] = useState<"type" | "base">("type");
  const groups = grouping === "type" ? byType : byBase;

  const series: Series[] = groups.map((g, i) => ({
    id: g.field,
    label: g.label,
    color: `var(--chart-cat-${i + 1})`,
    points: months.map((m, idx) => ({ x: idx, y: Number(m[g.field] ?? 0) })),
  }));
  const monthLabel = (idx: number) => {
    const m = months[Math.round(idx)];
    return m ? formatMonth(m.month) : "";
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-(--ink)">
          Utilisation: monthly flight hours by {grouping} ({months.length} months)
        </h3>
        <div role="group" aria-label="Group utilisation by" className="flex rounded-[6px] border border-(--rule) p-[2px] text-[11px]">
          {(["type", "base"] as const).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={grouping === g}
              onClick={() => setGrouping(g)}
              className={cn(
                "rounded-[4px] px-2 py-[3px] transition-colors",
                grouping === g ? "bg-(--accent) text-(--on-accent)" : "text-(--ink-2) hover:text-(--ink)"
              )}
            >
              By {g}
            </button>
          ))}
        </div>
      </div>
      <ChartFrame
        legend={<ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
        chart={<LineChart series={series} xTickFormat={monthLabel} yTickFormat={(y) => String(y)} />}
        table={
          <ChartTable
            columns={["Month", ...groups.map((g) => `${g.label} (FH)`)]}
            rows={months.map((m) => [formatMonth(m.month), ...groups.map((g) => formatFH(Number(m[g.field] ?? 0), 1))])}
          />
        }
      />
      {asOf && months.length > 0 && months[months.length - 1].month === asOf.slice(0, 7) && (
        <p className="text-[11px] text-(--ink-2)">
          {formatMonth(months[months.length - 1].month)} is a part month: data runs to {formatDate(asOf)}.
        </p>
      )}
    </div>
  );
}
