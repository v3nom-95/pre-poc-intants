"use client";

import { formatNumber } from "@/lib/format";

/**
 * Horizontal axis in FH since install. Solid segment = hours used.
 * Beyond "now": a soft band across the 80% interval for FH-to-tau, with a
 * marker at the point estimate. One glance shows where risk sits relative
 * to the unit's current age.
 */
export function LifeStrip({
  fhExposure,
  fhToTau,
  fhToTauP10,
  fhToTauP90,
  unit = "FH",
}: {
  fhExposure: number;
  fhToTau: number;
  fhToTauP10: number;
  fhToTauP90: number;
  /** Exposure unit of this part: FH, or APU hours for the APU. */
  unit?: string;
}) {
  const fmt = (v: number) => `${formatNumber(v, 0)} ${unit}`;
  const totalSpan = fhExposure + fhToTauP90 * 1.15;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / totalSpan) * 100))}%`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-8 w-full overflow-hidden rounded-[4px] bg-(--paper)">
        <div className="absolute inset-y-0 left-0 bg-(--ink-2) opacity-20" style={{ width: pct(fhExposure) }} />
        <div
          className="absolute inset-y-0 bg-(--status-action-due) opacity-25"
          style={{ left: pct(fhExposure + fhToTauP10), width: pct(fhToTauP90 - fhToTauP10) }}
        />
        <div
          className="absolute inset-y-0 w-[2px] bg-(--status-critical)"
          style={{ left: pct(fhExposure + fhToTau) }}
        />
        <div className="absolute inset-y-0 w-[2px] bg-(--ink)" style={{ left: pct(fhExposure) }} />
      </div>
      <div className="flex justify-between text-[11px] text-(--ink-2)">
        <span>0 {unit}</span>
        <span>Now: {fmt(fhExposure)}</span>
        <span>Risk threshold: {fmt(fhExposure + fhToTau)} (80% interval {fmt(fhExposure + fhToTauP10)} to {fmt(fhExposure + fhToTauP90)})</span>
      </div>
    </div>
  );
}
