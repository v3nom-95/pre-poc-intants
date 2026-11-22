"use client";

import { useMemo, useState } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { ChartFrame, ChartLegend } from "@/components/charts/chart-frame";
import { ChartTable } from "@/components/charts/chart-table";
import { formatDate, formatNumber } from "@/lib/format";
import type { ScenarioMonth } from "@/lib/whatif-types";

const MARGIN = { top: 12, right: 16, bottom: 30, left: 52 };
const SCHED = "var(--chart-cat-1)";
const UNSCHED = "var(--chart-cat-2)";

function shortDate(iso: string): string {
  // "16 Dec" from "2026-12-16"; the table view gives the full date.
  return formatDate(iso).split(" ").slice(0, 2).join(" ");
}

/** Monthly workload, baseline and scenario side by side, stacked scheduled
 * and unscheduled man-hours. One y-axis, shared by both bars. */
export function WorkloadCompareChart({ baseline, scenario }: { baseline: ScenarioMonth[]; scenario: ScenarioMonth[] }) {
  const width = 640;
  const height = 240;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const [hover, setHover] = useState<number | null>(null);

  const cats = scenario.map((m) => m.start);
  const yMax = Math.max(
    1,
    ...baseline.map((m) => m.scheduled_man_hours + m.unscheduled_man_hours),
    ...scenario.map((m) => m.scheduled_man_hours + m.unscheduled_man_hours)
  ) * 1.1;
  const x = useMemo(() => scaleBand().domain(cats).range([0, innerW]).padding(0.3), [cats, innerW]);
  const y = useMemo(() => scaleLinear().domain([0, yMax]).range([innerH, 0]), [yMax, innerH]);
  const bw = Math.min(14, (x.bandwidth() - 2) / 2);

  function bar(m: ScenarioMonth, x0: number, faded: boolean, key: string) {
    const ySched = y(m.scheduled_man_hours);
    const yTop = y(m.scheduled_man_hours + m.unscheduled_man_hours);
    const op = faded ? 0.45 : 1;
    const schedH = Math.max(0, innerH - ySched);
    const unschedH = Math.max(0, ySched - yTop - (m.unscheduled_man_hours > 0 && schedH > 0 ? 2 : 0));
    return (
      <g key={key} opacity={op}>
        {schedH > 0 && (
          <rect x={x0} y={ySched} width={bw} height={schedH} fill={SCHED} rx={unschedH > 0.5 ? 0 : 3} />
        )}
        {unschedH > 0.5 && <rect x={x0} y={yTop} width={bw} height={unschedH} fill={UNSCHED} rx={3} />}
      </g>
    );
  }

  const chart = (
    <div className="relative w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ minWidth: 480 }} role="group"
        aria-label="Monthly maintenance workload in man-hours, baseline and scenario, scheduled and unscheduled">
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {y.ticks(4).map((t) => (
            <g key={t}>
              <line x1={0} x2={innerW} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-2)" className="tabular">
                {formatNumber(t)}
              </text>
            </g>
          ))}
          {scenario.map((m, i) => {
            const x0 = x(m.start) ?? 0;
            return (
              <g key={m.start}>
                {bar(baseline[i], x0 + x.bandwidth() / 2 - bw - 1, true, "b")}
                {bar(m, x0 + x.bandwidth() / 2 + 1, false, "s")}
                <text x={x0 + x.bandwidth() / 2} y={innerH + 18} textAnchor="middle" fontSize={11} fill="var(--ink-2)">
                  {shortDate(m.start)}
                </text>
                <rect
                  x={x0 - (x.step() - x.bandwidth()) / 2}
                  y={0}
                  width={x.step()}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`Month from ${formatDate(m.start)}: baseline ${formatNumber(baseline[i].scheduled_man_hours + baseline[i].unscheduled_man_hours)} man-hours, scenario ${formatNumber(m.scheduled_man_hours + m.unscheduled_man_hours)} man-hours`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none focus-visible:stroke-(--accent)"
                />
              </g>
            );
          })}
          <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--ink-2)" strokeWidth={1} />
        </g>
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-2 right-2 rounded-[6px] border border-(--rule) bg-(--sheet) px-3 py-2 text-[12px] shadow-md">
          <div className="mb-1 font-semibold text-(--ink)">From {formatDate(scenario[hover].start)}</div>
          <div className="tabular text-(--ink-2)">
            Baseline: {formatNumber(baseline[hover].scheduled_man_hours)} scheduled,{" "}
            {formatNumber(baseline[hover].unscheduled_man_hours, 1)} unscheduled man-hours
          </div>
          <div className="tabular text-(--ink)">
            Scenario: {formatNumber(scenario[hover].scheduled_man_hours)} scheduled,{" "}
            {formatNumber(scenario[hover].unscheduled_man_hours, 1)} unscheduled man-hours
          </div>
        </div>
      )}
    </div>
  );

  return (
    <ChartFrame
      title="Maintenance workload per month (man-hours)"
      legend={
        <ChartLegend
          items={[
            { label: "Scheduled", color: SCHED },
            { label: "Unscheduled", color: UNSCHED },
          ]}
        />
      }
      chart={
        <div className="flex flex-col gap-1">
          {chart}
          <p className="text-[11px] text-(--ink-3)">Left bar of each pair: baseline (lighter). Right bar: scenario.</p>
        </div>
      }
      table={
        <ChartTable
          columns={["Month from", "Baseline scheduled", "Baseline unscheduled", "Scenario scheduled", "Scenario unscheduled"]}
          rows={scenario.map((m, i) => [
            formatDate(m.start),
            `${formatNumber(baseline[i].scheduled_man_hours)} man-hours`,
            `${formatNumber(baseline[i].unscheduled_man_hours, 1)} man-hours`,
            `${formatNumber(m.scheduled_man_hours)} man-hours`,
            `${formatNumber(m.unscheduled_man_hours, 1)} man-hours`,
          ])}
        />
      }
    />
  );
}
