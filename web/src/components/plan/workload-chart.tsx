"use client";

import { useMemo, useState } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { ChartFrame, ChartLegend } from "@/components/charts/chart-frame";
import { ChartTable } from "@/components/charts/chart-table";
import { LineChart } from "@/components/charts/line-chart";
import { formatDate, formatNumber, formatPct } from "@/lib/format";
import type { PlanWeek } from "@/lib/plan-types";

const MARGIN = { top: 12, right: 16, bottom: 28, left: 48 };
const WIDTH = 640;
const SCHEDULED = { label: "Scheduled servicing", color: "var(--chart-cat-1)" };
const RECOMMENDED = { label: "Recommended tasks", color: "var(--chart-cat-2)" };

export function WorkloadChart({ weekly }: { weekly: PlanWeek[] }) {
  const [active, setActive] = useState<number | null>(null);
  const height = 230;
  const innerW = WIDTH - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const totals = weekly.map((w) => w.scheduled_man_hours + w.recommended_man_hours);
  const yMax = Math.max(10, ...totals) * 1.1;
  const x = useMemo(
    () => scaleBand<number>().domain(weekly.map((_, i) => i)).range([0, innerW]).padding(0.3),
    [weekly, innerW]
  );
  const y = useMemo(() => scaleLinear().domain([0, yMax]).range([innerH, 0]), [yMax, innerH]);
  const bw = x.bandwidth();
  const w = active !== null ? weekly[active] : null;

  const chart = (
    <div className="relative w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        role="group"
        aria-label="Weekly maintenance workload in man-hours, scheduled servicing and recommended tasks"
        style={{ minWidth: 480 }}
        onMouseLeave={() => setActive(null)}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {y.ticks(4).map((t) => (
            <g key={t}>
              <line x1={0} x2={innerW} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-2)" className="tabular">
                {formatNumber(t)}
              </text>
            </g>
          ))}
          {weekly.map((wk, i) => {
            const x0 = x(i) ?? 0;
            const sTop = y(wk.scheduled_man_hours);
            const rTop = y(wk.scheduled_man_hours + wk.recommended_man_hours);
            const hasRec = wk.recommended_man_hours > 0;
            return (
              <g
                key={wk.week_start}
                tabIndex={0}
                role="button"
                aria-label={`Week of ${formatDate(wk.week_start)}: ${formatNumber(wk.scheduled_man_hours, 1)} scheduled and ${formatNumber(wk.recommended_man_hours, 1)} recommended man-hours`}
                className="outline-none"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                <rect x={x0 - 4} y={0} width={bw + 8} height={innerH} fill={active === i ? "var(--paper)" : "transparent"} />
                {wk.scheduled_man_hours > 0 && (
                  <rect
                    x={x0}
                    y={sTop}
                    width={bw}
                    height={innerH - sTop}
                    fill={SCHEDULED.color}
                    rx={hasRec ? 0 : 4}
                  />
                )}
                {hasRec && (
                  <rect
                    x={x0}
                    y={rTop}
                    width={bw}
                    height={Math.max(0, sTop - rTop - (wk.scheduled_man_hours > 0 ? 2 : 0))}
                    fill={RECOMMENDED.color}
                    rx={4}
                  />
                )}
                {i % 3 === 0 && (
                  <text x={x0 + bw / 2} y={innerH + 18} textAnchor="middle" fontSize={11} fill="var(--ink-2)" className="tabular">
                    {formatDate(wk.week_start)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {w && active !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-[6px] border border-(--rule) bg-(--sheet) p-2 text-[12px] shadow-md"
          style={{ left: `${Math.min(((MARGIN.left + (x(active) ?? 0)) / WIDTH) * 100, 62)}%` }}
        >
          <div className="font-semibold text-(--ink)">Week of {formatDate(w.week_start)}</div>
          <div className="tabular text-(--ink-2)">Scheduled: {formatNumber(w.scheduled_man_hours, 1)} man-hours</div>
          <div className="tabular text-(--ink-2)">Recommended: {formatNumber(w.recommended_man_hours, 1)} man-hours</div>
          <div className="tabular text-(--ink)">
            Total: {formatNumber(w.scheduled_man_hours + w.recommended_man_hours, 1)} man-hours
          </div>
        </div>
      )}
    </div>
  );

  return (
    <ChartFrame
      title="Weekly workload (man-hours)"
      legend={<ChartLegend items={[SCHEDULED, RECOMMENDED]} />}
      chart={chart}
      table={
        <ChartTable
          columns={["Week of", "Scheduled (man-hours)", "Recommended (man-hours)", "Total (man-hours)"]}
          rows={weekly.map((wk) => [
            formatDate(wk.week_start),
            formatNumber(wk.scheduled_man_hours, 1),
            formatNumber(wk.recommended_man_hours, 1),
            formatNumber(wk.scheduled_man_hours + wk.recommended_man_hours, 1),
          ])}
        />
      }
    />
  );
}

export function AvailabilityChart({ weekly, fleetSize }: { weekly: PlanWeek[]; fleetSize: number }) {
  const series = [
    {
      id: "availability",
      label: "Projected availability",
      color: "var(--chart-cat-1)",
      points: weekly.map((wk, i) => ({ x: i, y: wk.availability_pct })),
    },
  ];
  return (
    <ChartFrame
      title="Projected fleet availability (%)"
      chart={
        <div>
          <LineChart
            series={series}
            height={230}
            yMin={Math.max(0, Math.floor((Math.min(...weekly.map((w) => w.availability_pct)) - 10) / 10) * 10)}
            yMax={100}
            yTickFormat={(v) => formatPct(v)}
            xTickFormat={(i) => (weekly[i] ? formatDate(weekly[i].week_start) : "")}
          />
          <p className="text-[11px] text-(--ink-2)">
            Share of the {fleetSize} aircraft not in a planned input, averaged over each week. Unscheduled failures are not included.
          </p>
        </div>
      }
      table={
        <ChartTable
          columns={["Week of", "Aircraft in maintenance (average)", "Availability"]}
          rows={weekly.map((wk) => [
            formatDate(wk.week_start),
            formatNumber(wk.aircraft_in_maintenance, 1),
            formatPct(wk.availability_pct, 1),
          ])}
        />
      }
    />
  );
}
