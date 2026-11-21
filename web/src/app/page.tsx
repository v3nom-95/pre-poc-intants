import Link from "next/link";
import { Gauge, ShieldCheck, ClipboardList, CalendarClock, TrendingDown, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { FlightLinePlanform } from "@/components/planform/flight-line-planform";
import { TailNumber } from "@/components/domain/tail-number";
import { StatusTag, PriorityTag } from "@/components/domain/status-tag";
import { UtilisationChart } from "@/components/charts/utilisation-chart";
import { IntelligenceBriefing } from "@/components/domain/intelligence-briefing";
import { getFleet } from "@/lib/data";
import { formatFH, formatNumber, formatPct, formatDate } from "@/lib/format";

export default function Home() {
  const fleet = getFleet();
  const { kpis } = fleet;

  return (
    <AppShell asOfLabel={formatDate(fleet.as_of)}>
      <div className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[28px] font-semibold text-(--ink) page-title">Fleet overview</h1>
        </div>

        <IntelligenceBriefing fleet={fleet} />

        <section aria-label="Flight line" className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
            {fleet.aircraft.map((a, i) => (
              <Link
                key={a.tail}
                href={`/aircraft/${a.tail}`}
                className="group flex flex-col items-center gap-1 rounded-[6px] p-2 text-center transition-all duration-150 ease-out hover:-translate-y-0.5 hover:bg-(--paper) focus-visible:-translate-y-0.5 focus-visible:bg-(--paper) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
              >
                <FlightLinePlanform status={a.status} animate delayMs={i * 25} className="h-20 w-10 transition-transform duration-150 group-hover:scale-105" />
                <TailNumber tail={a.tail} className="text-[13px]" />
                <StatusTag status={a.status} className="scale-[0.85]" />
                <span className="text-[11px] tabular text-(--ink-2)">{formatFH(a.airframe_fh)}</span>
                <div className="h-1 w-full max-w-14 overflow-hidden rounded-full bg-(--rule)">
                  <div
                    className="h-full rounded-full bg-(--accent)"
                    style={{ width: `${Math.min(a.fi, 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-(--ink-3)">
                  {a.open_recs_count} open rec{a.open_recs_count === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section aria-label="Fleet figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Figure icon={Gauge} label="Fleet FH (12 mo)" value={formatFH(kpis.fleet_fh_12mo)} />
          <Figure icon={ShieldCheck} label="Serviceability" value={formatPct(kpis.serviceability_pct)} />
          <Figure
            icon={ClipboardList}
            label="Open recommendations"
            value={formatNumber(Object.values(kpis.open_recs_by_priority).reduce((a, b) => a + b, 0))}
            sub={`${kpis.open_recs_by_priority.Critical ?? 0} critical, ${kpis.open_recs_by_priority.High ?? 0} high`}
          />
          <Figure icon={CalendarClock} label="Due in 30 days" value={formatNumber(kpis.due_30_days_count)} />
          <Figure
            icon={kpis.unscheduled_removal_rate_delta <= 0 ? TrendingDown : TrendingUp}
            label="Unscheduled removals / 1,000 FH"
            value={formatNumber(kpis.unscheduled_removal_rate_per_1000fh, 1)}
            sub={`${kpis.unscheduled_removal_rate_delta <= 0 ? "" : "+"}${formatNumber(kpis.unscheduled_removal_rate_delta, 1)} vs prior 12 mo`}
            good={kpis.unscheduled_removal_rate_delta <= 0}
          />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <UtilisationChart months={fleet.utilisation_monthly} />
          </section>

          <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-(--ink)">
              <CalendarClock className="size-[14px] text-(--ink-2)" strokeWidth={1.75} />
              Due in the next 90 days
            </h3>
            <div className="max-h-[260px] overflow-y-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-(--ink-2)">
                    <th className="pb-1 font-medium">Tail</th>
                    <th className="pb-1 font-medium">Item</th>
                    <th className="pb-1 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.due_90_days.map((d, i) => (
                    <tr key={i} className="border-t border-(--rule)">
                      <td className="py-1.5">
                        <Link href={`/aircraft/${d.tail}`} className="hover:text-(--accent)">
                          <TailNumber tail={d.tail} className="text-[12px]" />
                        </Link>
                      </td>
                      <td className="py-1.5 text-(--ink)">{d.item}</td>
                      <td className="py-1.5 tabular text-(--ink-2)">
                        {d.date ? formatDate(d.date) : d.fh_to_tau ? `${formatFH(d.fh_to_tau)} to risk threshold` : "N/A"}
                      </td>
                    </tr>
                  ))}
                  {fleet.due_90_days.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-(--ink-2)">
                        No items due in the next 90 days.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-(--ink)">
              <ClipboardList className="size-[14px] text-(--ink-2)" strokeWidth={1.75} />
              Top recommendations
            </h3>
            <Link href="/recommendations" className="text-[12px] text-(--accent) hover:underline">
              View all
            </Link>
          </div>
          <ul className="flex flex-col gap-2">
            {fleet.top_recommendations.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 rounded-[6px] border border-(--rule) p-2.5">
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <PriorityTag priority={r.priority as "Critical" | "High" | "Medium" | "Low"} />
                  <span className="truncate text-[13px] text-(--ink)">{r.title}</span>
                </div>
                {r.tail && <TailNumber tail={r.tail} className="shrink-0 text-[12px]" />}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function Figure({
  icon: Icon,
  label,
  value,
  sub,
  good,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string;
  sub?: string;
  good?: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[8px] border border-(--rule) bg-(--sheet) p-4"
      style={{ borderLeft: "3px solid var(--accent)" }}
    >
      <div className="flex items-center gap-2 text-(--ink-2)">
        <Icon className="size-[15px]" strokeWidth={1.75} />
        <span className="text-[11px] leading-tight">{label}</span>
      </div>
      <span className="text-[28px] font-semibold tabular text-(--ink) figure-display leading-none">{value}</span>
      {sub && (
        <span className={`text-[11px] ${good === false ? "text-(--status-critical)" : "text-(--ink-3)"}`}>{sub}</span>
      )}
    </div>
  );
}
