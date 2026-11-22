"use client";

import { cn } from "@/lib/utils";

export interface TypeOption {
  key: string;
  name: string;
  count?: number;
}

/**
 * Segmented aircraft-type filter shared by the action plan, reliability and
 * recommendation screens. "All" is the empty selection.
 */
export function TypeFilter({
  types,
  value,
  onChange,
  allCount,
  label = "Aircraft type",
  className,
}: {
  types: TypeOption[];
  value: string;
  onChange: (key: string) => void;
  allCount?: number;
  label?: string;
  className?: string;
}) {
  const options: TypeOption[] = [{ key: "All", name: "All types", count: allCount }, ...types];
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-1 text-[12px]", className)}>
      <span className="mr-1 text-(--ink-2)">{label}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "rounded-[6px] border px-2 py-1 transition-colors",
            value === o.key
              ? "border-(--accent) bg-(--accent)/10 text-(--accent)"
              : "border-(--rule) text-(--ink-2) hover:text-(--ink)"
          )}
        >
          {o.name}
          {o.count !== undefined ? ` (${o.count})` : ""}
        </button>
      ))}
    </div>
  );
}
