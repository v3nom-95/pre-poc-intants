"use client";

import { useMemo } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import type { StackedBarDatum } from "./chart-types";

const MARGIN = { top: 12, right: 16, bottom: 28, left: 44 };

export function StackedBarChart({
  data,
  height = 220,
  xTickFormat = (x: string | number) => String(x),
  yTickFormat = (y: number) => String(y),
}: {
  data: StackedBarDatum[];
  height?: number;
  xTickFormat?: (x: string | number) => string;
  yTickFormat?: (y: number) => string;
}) {
  const width = 640;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const totals = data.map((d) => d.segments.reduce((a, s) => a + s.value, 0));
  const yMax = Math.max(...totals) * 1.1;

  const xScale = useMemo(
    () =>
      scaleBand()
        .domain(data.map((d) => String(d.category)))
        .range([0, innerW])
        .padding(0.28),
    [data, innerW]
  );
  const yScale = useMemo(() => scaleLinear().domain([0, yMax]).range([innerH, 0]), [yMax, innerH]);
  const yTicks = yScale.ticks(4);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Stacked bar chart" style={{ minWidth: 480 }}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={0} x2={innerW} y1={yScale(t)} y2={yScale(t)} stroke="var(--rule)" strokeWidth={1} />
              <text x={-8} y={yScale(t)} dy="0.32em" textAnchor="end" className="tabular" fontSize={11} fill="var(--ink-2)">
                {yTickFormat(t)}
              </text>
            </g>
          ))}
          {data.map((d) => {
            const bw = xScale.bandwidth();
            let cum = 0;
            return (
              <g key={String(d.category)}>
                {d.segments.map((seg, i) => {
                  const y0 = yScale(cum);
                  cum += seg.value;
                  const y1 = yScale(cum);
                  const h = Math.max(0, y0 - y1);
                  const isTop = i === d.segments.length - 1;
                  return (
                    <rect
                      key={seg.key}
                      x={xScale(String(d.category))}
                      y={y1}
                      width={bw}
                      height={h}
                      fill={seg.color}
                      rx={isTop ? 4 : 0}
                      ry={isTop ? 4 : 0}
                    />
                  );
                })}
                <text
                  x={(xScale(String(d.category)) ?? 0) + bw / 2}
                  y={innerH + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--ink-2)"
                >
                  {xTickFormat(d.category)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
