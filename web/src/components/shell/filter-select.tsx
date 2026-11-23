"use client";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Compact filter dropdown. "All" is the unfiltered value; the trigger shows the label until a value is picked. */
export function FilterSelect({
  label,
  value,
  onChange,
  options = [],
  groups,
  optionLabel = (o) => o,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options?: string[];
  groups?: { label: string; options: string[] }[];
  optionLabel?: (o: string) => string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "All")}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue placeholder={label}>{value === "All" ? label : optionLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="All">All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {optionLabel(o)}
          </SelectItem>
        ))}
        {groups?.map((g) => (
          <SelectGroup key={g.label}>
            <SelectLabel>{g.label}</SelectLabel>
            {g.options.map((o) => (
              <SelectItem key={o} value={o}>
                {optionLabel(o)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
