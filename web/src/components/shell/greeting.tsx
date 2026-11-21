"use client";

import { useEffect, useState } from "react";
import { useUiStore } from "@/lib/ui-store";

function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Greeting() {
  const role = useUiStore((s) => s.role);
  const [greeting, setGreeting] = useState("Welcome");

  useEffect(() => {
    setGreeting(timeOfDayGreeting());
  }, []);

  return (
    <span className="hidden text-[13px] text-(--ink-2) lg:inline">
      {greeting}, <span className="font-medium text-(--ink)">{role.toLowerCase()}</span>
    </span>
  );
}
