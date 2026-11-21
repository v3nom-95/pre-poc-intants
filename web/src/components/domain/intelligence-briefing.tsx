import { ScrollText } from "lucide-react";
import Link from "next/link";
import type { FleetData } from "@/lib/data";
import { formatNumber } from "@/lib/format";

/**
 * A proactive, assistant-voiced summary of what the pipeline found this
 * run. Every sentence here is built from the same computed fleet.json
 * fields the rest of the page renders — no live model call, just
 * narrated instead of tabulated. Kept honest: if there's nothing notable,
 * it says so rather than inventing urgency.
 */
export function IntelligenceBriefing({ fleet }: { fleet: FleetData }) {
  const critical = fleet.aircraft.filter((a) => a.status === "Critical");
  const actionDue = fleet.aircraft.filter((a) => a.status === "Action due");
  const clean = fleet.aircraft.filter((a) => a.status === "Serviceable");
  const topCritical = fleet.top_recommendations.find((r) => r.priority === "Critical");

  const lines: string[] = [];

  if (critical.length > 0) {
    lines.push(
      `${critical.length} aircraft need a decision today${topCritical ? `, starting with ${topCritical.tail}: ${topCritical.title}` : ""}.`
    );
  }
  if (actionDue.length > 0) {
    lines.push(`${actionDue.length} more have items worth reviewing this week, mostly tied to the lot and hard-time items below.`);
  }
  if (clean.length > 0) {
    lines.push(`${clean.length} aircraft${clean.length === 1 ? " is" : " are"} clean, nothing open right now.`);
  }
  lines.push(
    `Unscheduled removals are running at ${formatNumber(fleet.kpis.unscheduled_removal_rate_per_1000fh, 1)} per 1,000 FH, ${
      fleet.kpis.unscheduled_removal_rate_delta <= 0 ? "down" : "up"
    } ${formatNumber(Math.abs(fleet.kpis.unscheduled_removal_rate_delta), 1)} against the prior 12 months.`
  );

  return (
    <section
      aria-label="Fleet intelligence briefing"
      className="flex gap-3 rounded-[8px] border border-(--rule) bg-(--sheet) p-4"
    >
      <ScrollText className="mt-0.5 size-[18px] shrink-0 text-(--accent)" strokeWidth={1.75} />
      <div className="flex flex-col gap-1">
        <h2 className="text-[12px] font-semibold text-(--accent)">Fleet intelligence briefing</h2>
        <p className="text-[13px] leading-[1.5] text-(--ink)">
          {lines.join(" ")}{" "}
          <Link href="/recommendations" className="font-medium text-(--accent) hover:underline">
            Review the queue
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
