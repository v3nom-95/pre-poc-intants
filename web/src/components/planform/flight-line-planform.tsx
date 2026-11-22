"use client";

import { VIEWBOX } from "./geometry";
import { PLANFORM_GEOMETRY, PLANFORM_TYPE_NAME, type PlanformType } from "./type-geometry";
import { STATUS_VAR, type Status } from "@/lib/domain-types";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/** Small flight-line planform: the type's own outline, no grid, colored by status. */
export function FlightLinePlanform({
  status,
  type = "fighter",
  animate = false,
  delayMs = 0,
  className,
}: {
  status: Status;
  type?: PlanformType;
  animate?: boolean;
  delayMs?: number;
  className?: string;
}) {
  const g = PLANFORM_GEOMETRY[type];
  const color = STATUS_VAR[status];
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animate && !reducedMotion;

  // pathLength="1" normalises stroke-dasharray/dashoffset to a 0-1 range
  // regardless of the path's real geometric length, so the draw-in
  // animation needs no JS measurement (and no render-order race) at all.
  const animStyle = shouldAnimate
    ? ({ animation: `pre-draw-in 350ms ease-out ${delayMs}ms both` } as React.CSSProperties)
    : undefined;
  const drawProps = {
    pathLength: 1,
    strokeDasharray: shouldAnimate ? 1 : undefined,
    strokeDashoffset: shouldAnimate ? 1 : 0,
    style: animStyle,
  };

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
      className={className}
      role="img"
      aria-label={`${PLANFORM_TYPE_NAME[type]}, status ${status}`}
    >
      <path d={g.outlinePath} fill="none" stroke={color} strokeWidth={16} strokeLinejoin="round" {...drawProps} />
      {g.details.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} {...drawProps} />
      ))}
      {g.canopy && (
        <ellipse cx={g.canopy.cx} cy={g.canopy.cy} rx={g.canopy.rx} ry={g.canopy.ry} fill="none" stroke={color} strokeWidth={12} opacity={0.85} />
      )}
      <rect
        x={g.verticalTail.x - 5}
        y={g.verticalTail.y}
        width={g.verticalTail.width + 10}
        height={g.verticalTail.height}
        rx={g.verticalTail.rx}
        fill={color}
        opacity={0.6}
      />
    </svg>
  );
}
