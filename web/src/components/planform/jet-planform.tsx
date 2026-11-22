"use client";

import { HOTSPOTS } from "./geometry";
import { PlanformDrawing, type ZoneComponentMap } from "./planform-drawing";
import type { Status } from "@/lib/domain-types";

export interface ComponentStatusMap {
  [componentKey: string]: { label: string; status: Status };
}

/**
 * Fighter planform keyed by component key (the original single-type API).
 * Kept for backward compatibility; it maps the fighter hotspot component
 * keys onto zones and renders the generic PlanformDrawing.
 */
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
  const zones: ZoneComponentMap = {};
  for (const h of HOTSPOTS) {
    zones[h.id] = h.componentKeys.map((k) => ({
      key: k,
      label: componentStatus[k]?.label ?? k,
      status: componentStatus[k]?.status ?? ("Serviceable" as Status),
    }));
  }
  return (
    <PlanformDrawing
      type="fighter"
      zones={zones}
      onSelectComponent={onSelectComponent}
      showGrid={showGrid}
      className={className}
    />
  );
}
