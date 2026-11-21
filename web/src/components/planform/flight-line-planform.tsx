"use client";

import { VIEWBOX, OUTLINE_PATH, CANOPY, VERTICAL_TAIL } from "./geometry";
import { STATUS_VAR, type Status } from "@/lib/domain-types";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

export function FlightLinePlanform({
  status,
  animate = false,
  delayMs = 0,
  className,
}: {
  status: Status;
  animate?: boolean;
  delayMs?: number;
  className?: string;
}) {
  const color = STATUS_VAR[status];
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animate && !reducedMotion;

  // pathLength="1" normalises stroke-dasharray/dashoffset to a 0-1 range
  // regardless of the path's real geometric length, so the draw-in
  // animation needs no JS measurement (and no render-order race) at all.
  const animStyle = shouldAnimate
    ? ({ animation: `pre-draw-in 350ms ease-out ${delayMs}ms both` } as React.CSSProperties)
    : undefined;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
      className={className}
      role="img"
      aria-label={`Aircraft, status ${status}`}
    >
      <path
        d={OUTLINE_PATH}
        pathLength={1}
        fill="none"
        stroke={color}
        strokeWidth={16}
        strokeLinejoin="round"
        strokeDasharray={shouldAnimate ? 1 : undefined}
        strokeDashoffset={shouldAnimate ? 1 : 0}
        style={animStyle}
      />
      <ellipse cx={CANOPY.cx} cy={CANOPY.cy} rx={CANOPY.rx} ry={CANOPY.ry} fill="none" stroke={color} strokeWidth={12} opacity={0.85} />
      <rect
        x={VERTICAL_TAIL.x - 5}
        y={VERTICAL_TAIL.y}
        width={VERTICAL_TAIL.width + 10}
        height={VERTICAL_TAIL.height}
        rx={VERTICAL_TAIL.rx}
        fill={color}
        opacity={0.6}
      />
    </svg>
  );
}
