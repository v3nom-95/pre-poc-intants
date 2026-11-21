"use client";

import { useMemo } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import type { DotPlotDatum } from "./chart-types";

const MARGIN = { top: 8, right: 24, bottom: 24, left: 190 };

export function DotPlot({
  data,
  rowHeight = 26,
  valueFormat = (v: number) => String(v),
}: {
  data: DotPlotDatum[];
  rowHeight?: number;
  valueFormat?: (v: number) => string;
}) {
  const width = 640;
  const height = data.length * rowHeight + MARGIN.top + MARGIN.bottom;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const allVals = data.flatMap((d) => [d.value, d.yLow ?? d.value, d.yHigh ?? d.value]);
  const xDomain: [number, number] = [Math.min(0, ...allVals), Math.max(...allVals) * 1.08];

  const yScale = useMemo(
    () => scaleBand().domain(data.map((d) => d.label)).range([0, innerH]).padding(0.4),
    [data, innerH]
  );
  const xScale = useMemo(() => scaleLinear().domain(xDomain).range([0, innerW]), [xDomain[0], xDomain[1], innerW]);
  const xTicks = xScale.ticks(5);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Dot plot" style={{ minWidth: 480 }}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {xTicks.map((t) => (
            <line key={t} x1={xScale(t)} x2={xScale(t)} y1={0} y2={innerH} stroke="var(--rule)" strokeWidth={1} />
          ))}
          {data.map((d) => {
            const y = (yScale(d.label) ?? 0) + yScale.bandwidth() / 2;
            const hasRange = d.yLow !== undefined && d.yHigh !== undefined;
            return (
              <g key={d.label}>
                <text x={-10} y={y} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--ink)">
                  {d.label}
                </text>
                {hasRange && (
                  <line
                    x1={xScale(d.yLow!)}
                    x2={xScale(d.yHigh!)}
                    y1={y}
                    y2={y}
                    stroke={d.color ?? "var(--chart-cat-1)"}
                    strokeWidth={2}
                    opacity={0.35}
                  />
                )}
                <circle cx={xScale(d.value)} cy={y} r={4.5} fill={d.color ?? "var(--chart-cat-1)"} />
              </g>
            );
          })}
          {xTicks.map((t) => (
            <text key={t} x={xScale(t)} y={innerH + 16} textAnchor="middle" fontSize={11} className="tabular" fill="var(--ink-2)">
              {valueFormat(t)}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
