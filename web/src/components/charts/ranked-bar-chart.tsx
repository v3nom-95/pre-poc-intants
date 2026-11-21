"use client";

import { useMemo } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import type { RankedBarDatum } from "./chart-types";

const MARGIN = { top: 8, right: 56, bottom: 8, left: 160 };

export function RankedBarChart({
  data,
  rowHeight = 28,
  valueFormat = (v: number) => String(v),
  showCumulativeShare = false,
}: {
  data: RankedBarDatum[];
  rowHeight?: number;
  valueFormat?: (v: number) => string;
  showCumulativeShare?: boolean;
}) {
  const width = 640;
  const height = data.length * rowHeight + MARGIN.top + MARGIN.bottom;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const total = data.reduce((a, d) => a + d.value, 0);
  const max = Math.max(...data.map((d) => d.value));

  const yScale = useMemo(
    () => scaleBand().domain(data.map((d) => d.label)).range([0, innerH]).padding(0.3),
    [data, innerH]
  );
  const xScale = useMemo(() => scaleLinear().domain([0, max * 1.05]).range([0, innerW]), [max, innerW]);

  let cum = 0;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Ranked bar chart" style={{ minWidth: 480 }}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {data.map((d) => {
            cum += d.value;
            const share = total ? (cum / total) * 100 : 0;
            const bh = yScale.bandwidth();
            const y = yScale(d.label) ?? 0;
            const w = xScale(d.value);
            return (
              <g key={d.label}>
                <text x={-10} y={y + bh / 2} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--ink)">
                  {d.label}
                </text>
                <rect x={0} y={y} width={w} height={bh} rx={4} fill={d.color ?? "var(--chart-cat-1)"} />
                <text x={w + 8} y={y + bh / 2} dy="0.32em" fontSize={11} className="tabular" fill="var(--ink-2)">
                  {valueFormat(d.value)}
                  {showCumulativeShare ? ` · ${share.toFixed(0)}%` : ""}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
