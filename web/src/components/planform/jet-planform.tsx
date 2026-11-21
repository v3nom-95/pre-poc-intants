"use client";

import {
  VIEWBOX,
  CENTERLINE_X,
  OUTLINE_PATH,
  CANOPY,
  VERTICAL_TAIL,
  STATION_LINES,
  BUTT_LINES,
  ZONE_BOUNDARIES_Y,
  HOTSPOTS,
} from "./geometry";
import { HotspotMarker } from "./hotspot-marker";
import { worstStatus } from "./status-utils";
import type { Status } from "@/lib/domain-types";

export interface ComponentStatusMap {
  [componentKey: string]: { label: string; status: Status };
}

export function JetPlanform({
  componentStatus,
  onSelectComponent,
  showGrid = true,
  className,
}: {
  componentStatus: ComponentStatusMap;
  onSelectComponent?: (key: string) => void;
  showGrid?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
      className={className}
      role="img"
      aria-label="Aircraft planform diagram with component status hotspots"
    >
      {showGrid && (
        <g stroke="var(--ink-3)" strokeWidth={0.5} opacity={0.6}>
          {STATION_LINES.map((y) => (
            <g key={`fs-${y}`}>
              <line x1={20} x2={VIEWBOX.w - 20} y1={y} y2={y} />
              <text x={24} y={y - 4} fontSize={10} fill="var(--ink-3)">
                FS {y}
              </text>
            </g>
          ))}
          {BUTT_LINES.map((dx) => (
            <g key={`bl-${dx}`}>
              <line x1={CENTERLINE_X + dx} x2={CENTERLINE_X + dx} y1={30} y2={VIEWBOX.h - 30} />
              <text x={CENTERLINE_X + dx + 3} y={44} fontSize={10} fill="var(--ink-3)">
                BL {Math.abs(dx)}
              </text>
            </g>
          ))}
          {ZONE_BOUNDARIES_Y.map((y) => (
            <line
              key={`zone-${y}`}
              x1={30}
              x2={VIEWBOX.w - 30}
              y1={y}
              y2={y}
              strokeDasharray="4 4"
              opacity={0.5}
            />
          ))}
        </g>
      )}

      <path d={OUTLINE_PATH} fill="var(--ink-2)" fillOpacity={0.03} stroke="var(--ink-2)" strokeWidth={1.25} />
      <ellipse cx={CANOPY.cx} cy={CANOPY.cy} rx={CANOPY.rx} ry={CANOPY.ry} fill="none" stroke="var(--ink-2)" strokeWidth={1.25} />
      <rect
        x={VERTICAL_TAIL.x}
        y={VERTICAL_TAIL.y}
        width={VERTICAL_TAIL.width}
        height={VERTICAL_TAIL.height}
        rx={VERTICAL_TAIL.rx}
        fill="var(--ink-2)"
        fillOpacity={0.12}
        stroke="var(--ink-2)"
        strokeWidth={1.25}
      />

      {HOTSPOTS.map((h) => {
        const statuses = h.componentKeys.map((k) => componentStatus[k]?.status ?? "Serviceable");
        const status = worstStatus(statuses);
        const componentStatuses = h.componentKeys.map((k) => ({
          key: k,
          label: componentStatus[k]?.label ?? k,
          status: componentStatus[k]?.status ?? ("Serviceable" as Status),
        }));
        return (
          <HotspotMarker
            key={h.id}
            hotspot={h}
            status={status}
            componentStatuses={componentStatuses}
            onSelectComponent={onSelectComponent}
          />
        );
      })}
    </svg>
  );
}
