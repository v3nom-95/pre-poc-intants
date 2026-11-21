"use client";

import { useRouter } from "next/navigation";
import { JetPlanform, type ComponentStatusMap } from "@/components/planform/jet-planform";
import { planformKeyFor } from "@/lib/component-keys";
import type { AircraftData } from "@/lib/data";
import type { Priority } from "@/lib/domain-types";

const PRIORITY_TO_STATUS: Record<Priority, "Critical" | "Action due" | "Monitor"> = {
  Critical: "Critical",
  High: "Action due",
  Medium: "Monitor",
  Low: "Monitor",
};

export function AircraftPlanform({ aircraft }: { aircraft: AircraftData }) {
  const router = useRouter();

  const openRecBySerial = new Map<string, Priority>();
  for (const r of aircraft.recommendations) {
    if (r.status !== "Open" || !r.serial) continue;
    const existing = openRecBySerial.get(r.serial);
    const order: Priority[] = ["Critical", "High", "Medium", "Low"];
    if (!existing || order.indexOf(r.priority) < order.indexOf(existing)) {
      openRecBySerial.set(r.serial, r.priority);
    }
  }

  const componentStatus: ComponentStatusMap = {};
  const keyToSerial: Record<string, string> = {};
  for (const c of aircraft.components) {
    const planformKey = planformKeyFor(c.part_number, c.position);
    const priority = openRecBySerial.get(c.serial);
    const status = priority ? PRIORITY_TO_STATUS[priority] : "Serviceable";
    componentStatus[planformKey] = { label: c.component, status };
    keyToSerial[planformKey] = c.serial;
  }

  return (
    <JetPlanform
      componentStatus={componentStatus}
      onSelectComponent={(key) => {
        const serial = keyToSerial[key];
        if (serial) router.push(`/components/${serial}`);
      }}
      className="h-full w-full"
    />
  );
}
