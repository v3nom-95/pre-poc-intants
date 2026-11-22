"use client";

import { VIEWBOX, CENTERLINE_X } from "./geometry";
import { PLANFORM_GEOMETRY, PLANFORM_TYPE_NAME, type PlanformType } from "./type-geometry";
import { HotspotMarker } from "./hotspot-marker";
import { worstStatus } from "./status-utils";
import type { Status } from "@/lib/domain-types";

export interface ZoneComponent {
  key: string;
  label: string;
  status: Status;
}

/** Components grouped by planform zone id (SPEC 14.1). */
export type ZoneComponentMap = Record<string, ZoneComponent[]>;

/**
 * Detailed engineering planform for any aircraft type. A hotspot is drawn
 * for every zone that has at least one component; its marker shows the worst
 * status of those components.
 */
export function PlanformDrawing({
  type = "fighter",
  zones,
  onSelectComponent,
  showGrid = true,
  className,
}: {
  type?: PlanformType;
  zones: ZoneComponentMap;
  onSelectComponent?: (key: string) => void;
  showGrid?: boolean;
  className?: string;
}) {
  const g = PLANFORM_GEOMETRY[type];

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
      className={className}
      role="group"
      aria-label={`${PLANFORM_TYPE_NAME[type]} planform diagram with component status hotspots`}
    >
      {showGrid && (
        <g stroke="var(--ink-3)" strokeWidth={0.5} opacity={0.6}>
          {g.stationLines.map((y) => (
            <g key={`fs-${y}`}>
              <line x1={20} x2={VIEWBOX.w - 20} y1={y} y2={y} />
              <text x={24} y={y - 4} fontSize={10} fill="var(--ink-3)">
                FS {y}
              </text>
            </g>
          ))}
          {g.buttLines.map((dx) => (
            <g key={`bl-${dx}`}>
              <line x1={CENTERLINE_X + dx} x2={CENTERLINE_X + dx} y1={30} y2={VIEWBOX.h - 30} />
              <text x={CENTERLINE_X + dx + 3} y={44} fontSize={10} fill="var(--ink-3)">
                BL {Math.abs(dx)}
              </text>
            </g>
          ))}
          {g.zoneBoundariesY.map((y) => (
            <line key={`zone-${y}`} x1={30} x2={VIEWBOX.w - 30} y1={y} y2={y} strokeDasharray="4 4" opacity={0.5} />
          ))}
        </g>
      )}

      <path d={g.outlinePath} fill="var(--ink-2)" fillOpacity={0.03} stroke="var(--ink-2)" strokeWidth={1.25} strokeLinejoin="round" />
      {g.details.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--ink-2)" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {g.canopy && (
        <ellipse cx={g.canopy.cx} cy={g.canopy.cy} rx={g.canopy.rx} ry={g.canopy.ry} fill="none" stroke="var(--ink-2)" strokeWidth={1.25} />
      )}
      <rect
        x={g.verticalTail.x}
        y={g.verticalTail.y}
        width={g.verticalTail.width}
        height={g.verticalTail.height}
        rx={g.verticalTail.rx}
        fill="var(--ink-2)"
        fillOpacity={0.12}
        stroke="var(--ink-2)"
        strokeWidth={1.25}
      />

      {g.hotspots.map((h) => {
        const comps = zones[h.id];
        if (!comps || comps.length === 0) return null;
        return (
          <HotspotMarker
            key={h.id}
            hotspot={h}
            status={worstStatus(comps.map((c) => c.status))}
            componentStatuses={comps}
            onSelectComponent={onSelectComponent}
          />
        );
      })}
    </svg>
  );
}
