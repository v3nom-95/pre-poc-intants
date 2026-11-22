"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export function ChartFrame({
  title,
  legend,
  chart,
  table,
  className,
}: {
  title?: string;
  legend?: React.ReactNode;
  chart: React.ReactNode;
  table: React.ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3">
        {title ? <h3 className="text-[13px] font-semibold text-(--ink)">{title}</h3> : <div />}
        <div className="flex items-center gap-3">
          {legend}
          <div
            role="group"
            aria-label="Chart view"
            className="flex rounded-[6px] border border-(--rule) p-[2px] text-[11px]"
          >
            {(["chart", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded-[4px] px-2 py-[3px] capitalize transition-colors",
                  view === v
                    ? "bg-(--accent) text-(--on-accent)"
                    : "text-(--ink-2) hover:text-(--ink)"
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>
      {view === "chart" ? chart : table}
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex items-center gap-3">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-[11px] text-(--ink-2)">
          <span className="inline-block size-2 rounded-full" style={{ background: it.color }} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
