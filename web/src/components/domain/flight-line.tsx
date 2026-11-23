"use client";

import Link from "next/link";
import { useState } from "react";
import { FlightLinePlanform } from "@/components/planform/flight-line-planform";
import { TailNumber } from "@/components/domain/tail-number";
import { StatusTag } from "@/components/domain/status-tag";
import { FilterSelect } from "@/components/shell/filter-select";
import type { AircraftTypeKey, FleetData, FleetKpis } from "@/lib/data";
import { formatFH, formatNumber, formatPct } from "@/lib/format";

type Aircraft = FleetData["aircraft"][number];
type TypeKpis = FleetKpis & { aircraft: number };

// Worst first, the order an engineer scans the line in.
const STATUS_ORDER: Aircraft["status"][] = ["Critical", "Action due", "Monitor", "Serviceable"];

function openRecs(k: FleetKpis) {
  return Object.values(k.open_recs_by_priority).reduce((a, b) => a + b, 0);
}

/** The flight line on Fleet overview, grouped by type, with type, base and status filters. */
export function FlightLine({
  aircraft,
  types,
  kpisByType,
}: {
  aircraft: Aircraft[];
  types: { key: AircraftTypeKey; name: string; role: string }[];
  kpisByType: Partial<Record<AircraftTypeKey, TypeKpis>>;
}) {
  const [typeFilter, setTypeFilter] = useState("All");
  const [baseFilter, setBaseFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  // The draw-in is the page's one orchestrated moment (SPEC 7.5): it plays on
  // first load only, never again when a filter brings planforms back.
  const [interacted, setInteracted] = useState(false);

  const typeName = new Map(types.map((t) => [t.key as string, t.name]));
  const bases = [...new Set(aircraft.map((a) => a.base))].sort();
  const statuses = STATUS_ORDER.filter((s) => aircraft.some((a) => a.status === s));

  const shown = aircraft.filter(
    (a) =>
      (typeFilter === "All" || a.type === typeFilter) &&
      (baseFilter === "All" || a.base === baseFilter) &&
      (statusFilter === "All" || a.status === statusFilter)
  );
  const filtered = typeFilter !== "All" || baseFilter !== "All" || statusFilter !== "All";

  function set(setter: (v: string) => void) {
    return (v: string) => {
      setInteracted(true);
      setter(v);
    };
  }

  let drawIndex = 0;

  return (
    <section aria-label="Flight line" className="flex flex-col gap-4 rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Aircraft type"
          value={typeFilter}
          onChange={set(setTypeFilter)}
          options={types.map((t) => t.key)}
          optionLabel={(k) => typeName.get(k) ?? k}
        />
        <FilterSelect label="Base" value={baseFilter} onChange={set(setBaseFilter)} options={bases} />
        <FilterSelect label="Status" value={statusFilter} onChange={set(setStatusFilter)} options={statuses} />
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setTypeFilter("All");
              setBaseFilter("All");
              setStatusFilter("All");
            }}
            className="rounded-[6px] px-2 py-1 text-[12px] text-(--accent) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[12px] tabular text-(--ink-2)" aria-live="polite">
          Showing {formatNumber(shown.length)} of {formatNumber(aircraft.length)} aircraft
        </span>
      </div>

      {shown.length === 0 && (
        <p className="py-6 text-center text-[13px] text-(--ink-2)">
          No aircraft match these filters. Clear a filter to see more of the fleet.
        </p>
      )}

      {types.map((t) => {
        const group = shown.filter((a) => a.type === t.key);
        const k = kpisByType[t.key];
        if (group.length === 0) return null;
        const total = aircraft.filter((a) => a.type === t.key).length;
        return (
          <div key={t.key} className="flex flex-col gap-2 border-t border-(--rule) pt-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-[15px] font-semibold text-(--ink)">
                {t.name}{" "}
                <span className="text-[13px] font-normal text-(--ink-2)">
                  {t.role}, {group.length === total ? `${total} aircraft` : `${group.length} of ${total} aircraft`}
                </span>
              </h2>
              {k && (
                <p className="text-[12px] tabular text-(--ink-2)">
                  {formatFH(k.fleet_fh_12mo)} in 12 months, serviceability {formatPct(k.serviceability_pct)},{" "}
                  {openRecs(k)} open recommendation{openRecs(k) === 1 ? "" : "s"}, {k.due_30_days_count} due in 30 days
                </p>
              )}
            </div>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {group.map((a) => {
                const i = drawIndex++;
                return (
                  <Link
                    key={a.tail}
                    href={`/aircraft/${a.tail}`}
                    className="group flex flex-col items-center gap-1 rounded-[6px] p-1.5 text-center transition-all duration-150 ease-out hover:-translate-y-0.5 hover:bg-(--paper) focus-visible:-translate-y-0.5 focus-visible:bg-(--paper) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                  >
                    <FlightLinePlanform
                      status={a.status}
                      type={a.type}
                      animate={!interacted}
                      delayMs={i * 25}
                      className="h-16 w-12 transition-transform duration-150 group-hover:scale-105"
                    />
                    <TailNumber tail={a.tail} className="text-[13px]" />
                    <span className="sr-only">
                      {t.name}, {a.base}
                    </span>
                    <StatusTag status={a.status} className="scale-[0.85]" />
                    <span className="text-[11px] tabular text-(--ink-2)">{formatFH(a.airframe_fh)}</span>
                    <div
                      className="h-1 w-full max-w-14 overflow-hidden rounded-full bg-(--rule)"
                      title={`Fatigue index ${formatNumber(a.fi, 1)} of 100`}
                    >
                      <div className="h-full rounded-full bg-(--accent)" style={{ width: `${Math.min(a.fi, 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-(--ink-3)">
                      {a.open_recs_count} open rec{a.open_recs_count === 1 ? "" : "s"}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
