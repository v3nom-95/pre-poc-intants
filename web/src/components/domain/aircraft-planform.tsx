"use client";

import { useRouter } from "next/navigation";
import { PlanformDrawing, type ZoneComponentMap } from "@/components/planform/planform-drawing";
import { HOTSPOTS } from "@/components/planform/geometry";
import { toPlanformType } from "@/components/planform/type-geometry";
import { planformKeyFor } from "@/lib/component-keys";
import type { AircraftData } from "@/lib/data";
import type { Priority, Status } from "@/lib/domain-types";

const PRIORITY_TO_STATUS: Record<Priority, "Critical" | "Action due" | "Monitor"> = {
  Critical: "Critical",
  High: "Action due",
  Medium: "Monitor",
  Low: "Monitor",
};

const PRIORITY_ORDER: Priority[] = ["Critical", "High", "Medium", "Low"];

// Fields added by the mixed-fleet export (SPEC 14.1). Older exports lack
// them, so both are optional here.
type MixedFleetAircraft = AircraftData & { type?: string | null; type_name?: string | null };
type MixedFleetComponent = AircraftData["components"][number] & { zone?: string | null };

// Legacy fighter data has no zone field: derive the zone from the fighter
// hotspot that lists the component's planform key.
const LEGACY_KEY_TO_ZONE: Record<string, string> = Object.fromEntries(
  HOTSPOTS.flatMap((h) => h.componentKeys.map((k) => [k, h.id]))
);

export function AircraftPlanform({ aircraft }: { aircraft: AircraftData }) {
  const router = useRouter();
  const ac = aircraft as MixedFleetAircraft;
  const type = toPlanformType(ac.type ?? ac.type_name);

  const openRecBySerial = new Map<string, Priority>();
  for (const r of aircraft.recommendations) {
    if (r.status !== "Open" || !r.serial) continue;
    const existing = openRecBySerial.get(r.serial);
    if (!existing || PRIORITY_ORDER.indexOf(r.priority) < PRIORITY_ORDER.indexOf(existing)) {
      openRecBySerial.set(r.serial, r.priority);
    }
  }

  const zones: ZoneComponentMap = {};
  for (const c of aircraft.components as MixedFleetComponent[]) {
    const zone = c.zone ?? LEGACY_KEY_TO_ZONE[planformKeyFor(c.part_number, c.position)];
    if (!zone) continue;
    const priority = openRecBySerial.get(c.serial);
    const status: Status = priority ? PRIORITY_TO_STATUS[priority] : "Serviceable";
    const positioned = c.position && c.position !== "1" ? `${c.component} (${c.position})` : c.component;
    (zones[zone] ??= []).push({ key: c.serial, label: positioned, status });
  }

  return (
    <PlanformDrawing
      type={type}
      zones={zones}
      onSelectComponent={(serial) => router.push(`/components/${serial}`)}
      className="h-full w-full"
    />
  );
}
