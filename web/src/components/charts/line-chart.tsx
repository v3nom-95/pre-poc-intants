"use client";

import { useMemo, useState } from "react";
import { scaleLinear } from "d3-scale";
import { line as d3line, area as d3area, curveLinear, curveMonotoneX, curveStepAfter } from "d3-shape";
import type { Series } from "./chart-types";

interface LineChartProps {
  series: Series[];
  height?: number;
  xTickFormat?: (x: number) => string;
  yTickFormat?: (y: number) => string;
  yMin?: number;
  yMax?: number;
  markers?: { x: number; label: string; color?: string }[];
  /** Straight segments between points instead of a smoothed curve (use when points are sparse measurements). */
  linear?: boolean;
  /** Draw a dot at each data point. */
  showPoints?: boolean;
  /** Unit written after the last x tick only (keeps dense tick labels from colliding). */
  xUnit?: string;
  /** Series ids drawn as steps (for example a Kaplan-Meier estimate). */
  stepSeries?: string[];
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 44 };

export function LineChart({
  series,
  height = 220,
  xTickFormat = (x) => String(x),
  yTickFormat = (y) => String(y),
  yMin,
  yMax,
  markers = [],
  linear = false,
  showPoints = false,
  xUnit,
  stepSeries = [],
}: LineChartProps) {
  const curve = linear ? curveLinear : curveMonotoneX;
  const width = 640;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const allPoints = series.flatMap((s) => s.points);
  // Markers (e.g. a withdrawal-year reference line) must stay inside the
  // plotted domain even if they fall beyond the series data itself.
  const xs = allPoints.map((p) => Number(p.x)).concat(markers.map((m) => m.x));
  const ysRaw = allPoints.flatMap((p) => [p.y, p.yLow ?? p.y, p.yHigh ?? p.y]);

  const xDomain: [number, number] = [Math.min(...xs), Math.max(...xs)];
  const yDomain: [number, number] = [
    yMin ?? Math.min(0, ...ysRaw),
    yMax ?? Math.max(...ysRaw) * 1.08,
  ];

  const xScale = useMemo(
    () => scaleLinear().domain(xDomain).range([0, innerW]),
    [xDomain[0], xDomain[1], innerW]
  );
  const yScale = useMemo(
    () => scaleLinear().domain(yDomain).range([innerH, 0]),
    [yDomain[0], yDomain[1], innerH]
  );

  const [hoverX, setHoverX] = useState<number | null>(null);

  const yTicks = yScale.ticks(4);
  const xTicks = xScale.ticks(Math.min(8, xDomain[1] - xDomain[0] + 1));

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    setHoverX(xScale.invert(px));
  }

  const nearestByX = (xVal: number) =>
    allPoints.reduce((best, p) => {
      const dp = Math.abs(Number(p.x) - xVal);
      const db = Math.abs(Number(best.x) - xVal);
      return dp < db ? p : best;
    }, allPoints[0]);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Line chart"
        style={{ minWidth: 480 }}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={0}
                x2={innerW}
                y1={yScale(t)}
                y2={yScale(t)}
                stroke="var(--rule)"
                strokeWidth={1}
              />
              <text x={-8} y={yScale(t)} dy="0.32em" textAnchor="end" className="tabular" fontSize={11} fill="var(--ink-2)">
                {yTickFormat(t)}
              </text>
            </g>
          ))}
          {(() => {
            // With an x unit, the unit is an axis title at the right end of the
            // axis; ticks that would run into it are skipped.
            const unitWidth = xUnit ? xUnit.length * 6 + 24 : 0;
            const shown = xUnit ? xTicks.filter((t) => xScale(t) < innerW - unitWidth) : xTicks;
            return (
              <>
                {shown.map((t) => (
                  <text key={t} x={xScale(t)} y={innerH + 20} textAnchor="middle" className="tabular" fontSize={11} fill="var(--ink-2)">
                    {xTickFormat(t)}
                  </text>
                ))}
                {xUnit && (
                  <text x={innerW} y={innerH + 20} textAnchor="end" fontSize={11} fill="var(--ink-2)">
                    {xUnit}
                  </text>
                )}
              </>
            );
          })()}

          {series.map((s) => {
            const hasBand = s.points.some((p) => p.yLow !== undefined && p.yHigh !== undefined);
            const lineGen = d3line<typeof s.points[number]>()
              .x((p) => xScale(Number(p.x)))
              .y((p) => yScale(p.y))
              .curve(stepSeries.includes(s.id) ? curveStepAfter : curve);
            const areaGen = d3area<typeof s.points[number]>()
              .x((p) => xScale(Number(p.x)))
              .y0((p) => yScale(p.yLow ?? p.y))
              .y1((p) => yScale(p.yHigh ?? p.y))
              .curve(curve);

            return (
              <g key={s.id}>
                {hasBand && (
                  <path d={areaGen(s.points) ?? undefined} fill={s.color} opacity={0.17} stroke="none" />
                )}
                <path
                  d={lineGen(s.points) ?? undefined}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {showPoints &&
                  s.points.map((p, i) => (
                    <circle key={i} cx={xScale(Number(p.x))} cy={yScale(p.y)} r={3.5} fill={s.color} stroke="var(--sheet)" strokeWidth={1.5} />
                  ))}
              </g>
            );
          })}

          {markers.map((m) => {
            const mx = xScale(m.x);
            const anchor = mx > innerW - 50 ? "end" : mx < 50 ? "start" : "middle";
            return (
              <g key={m.label}>
                <line
                  x1={mx}
                  x2={mx}
                  y1={0}
                  y2={innerH}
                  stroke={m.color ?? "var(--ink-2)"}
                  strokeWidth={1.5}
                  strokeOpacity={0.7}
                />
                <text x={mx} y={-2} fontSize={10} fill={m.color ?? "var(--ink-3)"} textAnchor={anchor}>
                  {m.label}
                </text>
              </g>
            );
          })}

          {hoverX !== null && (
            <line x1={xScale(hoverX)} x2={xScale(hoverX)} y1={0} y2={innerH} stroke="var(--ink-3)" strokeWidth={1} />
          )}

          <rect
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverX(null)}
          />

          {hoverX !== null &&
            series.map((s) => {
              const p = nearestByX(hoverX);
              if (!s.points.includes(p)) return null;
              return (
                <g key={s.id} transform={`translate(${xScale(Number(p.x))},${yScale(p.y)})`}>
                  <circle r={3.5} fill={s.color} stroke="var(--sheet)" strokeWidth={1.5} />
                </g>
              );
            })}
        </g>
      </svg>
      {hoverX !== null && (
        <div className="pointer-events-none -mt-2 flex flex-wrap gap-3 px-2 text-[11px] text-(--ink-2)">
          {series.map((s) => {
            const p = nearestByX(hoverX);
            return (
              <span key={s.id} className="tabular">
                <span className="mr-1 inline-block size-2 rounded-full" style={{ background: s.color }} />
                {s.label}: {yTickFormat(p.y)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
