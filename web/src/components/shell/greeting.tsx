"use client";

import { useUiStore } from "@/lib/ui-store";

// No time-of-day greeting: the POC never reads the system clock (SPEC 0,
// CLAUDE.md). The greeting only reflects the simulated role.
export function Greeting() {
  const role = useUiStore((s) => s.role);

  return (
    <span className="hidden text-[13px] text-(--ink-2) lg:inline">
      Signed in as <span className="font-medium text-(--ink)">{role.toLowerCase()}</span>
    </span>
  );
}
