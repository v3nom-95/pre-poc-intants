import Link from "next/link";
import { Gauge, ShieldCheck, ClipboardList, CalendarClock, TrendingDown, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { FlightLinePlanform } from "@/components/planform/flight-line-planform";
import { TailNumber } from "@/components/domain/tail-number";
import { StatusTag, PriorityTag } from "@/components/domain/status-tag";
import { UtilisationChart } from "@/components/charts/utilisation-chart";
import { IntelligenceBriefing } from "@/components/domain/intelligence-briefing";
import { getFleet, getTypes, type AircraftTypeKey, type FleetKpis } from "@/lib/data";
import { formatFH, formatNumber, formatPct, formatDate } from "@/lib/format";

function openRecs(k: FleetKpis) {
  return Object.values(k.open_recs_by_priority).reduce((a, b) => a + b, 0);
}

export default function Home() {
  const fleet = getFleet();
  const types = getTypes();
  const { kpis } = fleet;
  const typeName = Object.fromEntries(types.map((t) => [t.key, t.name])) as Record<AircraftTypeKey, string>;

  // Running index across all types so the draw-in stagger stays one sequence.
  let drawIndex = 0;

  return (
    <AppShell asOfLabel={formatDate(fleet.as_of)}>
      <div className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[28px] font-semibold text-(--ink) page-title">Fleet overview</h1>
          <span className="text-[13px] text-(--ink-2)">
            {fleet.aircraft.length} aircraft of {types.length} types
          </span>
        </div>

        <IntelligenceBriefing fleet={fleet} typeName={typeName} />

        <section aria-label="Flight line" className="flex flex-col gap-4 rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          {types.map((t) => {
            const aircraft = fleet.aircraft.filter((a) => a.type === t.key);
            const k = kpis.by_type[t.key];
            if (aircraft.length === 0) return null;
            return (
              <div key={t.key} className="flex flex-col gap-2 border-t border-(--rule) pt-3 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="text-[15px] font-semibold text-(--ink)">
                    {t.name}{" "}
                    <span className="text-[13px] font-normal text-(--ink-2)">
                      {t.role}, {aircraft.length} aircraft
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
                  {aircraft.map((a) => {
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
                          animate
                          delayMs={i * 25}
                          className="h-16 w-12 transition-transform duration-150 group-hover:scale-105"
                        />
                        <TailNumber tail={a.tail} className="text-[13px]" />
                        <span className="sr-only">{t.name}</span>
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

        <section aria-label="Fleet figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Figure icon={Gauge} label="Fleet FH (12 mo)" value={formatFH(kpis.fleet_fh_12mo)} />
          <Figure icon={ShieldCheck} label="Serviceability" value={formatPct(kpis.serviceability_pct)} />
          <Figure
            icon={ClipboardList}
            label="Open recommendations"
            value={formatNumber(openRecs(kpis))}
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

        <section aria-label="Figures by type" className="overflow-x-auto rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Figures by type</h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th scope="col" className="pb-1.5 font-semibold">Type</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">Aircraft</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">FH (12 mo)</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">FH per aircraft per month</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">Serviceability</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">Open recommendations</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">Due in 30 days</th>
                <th scope="col" className="pb-1.5 text-right font-semibold">Unscheduled removals / 1,000 FH</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {types.map((t) => {
                const k = kpis.by_type[t.key];
                if (!k) return null;
                return (
                  <tr key={t.key} className="border-t border-(--rule)">
                    <th scope="row" className="py-1.5 text-left font-medium text-(--ink)">{t.name}</th>
                    <td className="py-1.5 text-right">{k.aircraft}</td>
                    <td className="py-1.5 text-right">{formatFH(k.fleet_fh_12mo)}</td>
                    <td className="py-1.5 text-right">{formatFH(k.fleet_fh_12mo / k.aircraft / 12, 1)}</td>
                    <td className="py-1.5 text-right">{formatPct(k.serviceability_pct, 1)}</td>
                    <td className="py-1.5 text-right">
                      {openRecs(k)}{" "}
                      <span className="text-(--ink-2)">
                        ({k.open_recs_by_priority.Critical ?? 0} critical, {k.open_recs_by_priority.High ?? 0} high)
                      </span>
                    </td>
                    <td className="py-1.5 text-right">{k.due_30_days_count}</td>
                    <td className="py-1.5 text-right">
                      {formatNumber(k.unscheduled_removal_rate_per_1000fh, 1)}{" "}
                      <span className="text-(--ink-2)">
                        ({k.unscheduled_removal_rate_delta <= 0 ? "" : "+"}
                        {formatNumber(k.unscheduled_removal_rate_delta, 1)} vs prior)
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="min-w-0 rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <UtilisationChart
              months={fleet.utilisation_monthly}
              asOf={fleet.as_of}
              byType={types.map((t) => ({ field: `${t.key}_fh`, label: t.name }))}
              byBase={[
                { field: "base_a_fh", label: "Base A" },
                { field: "base_b_fh", label: "Base B" },
              ]}
            />
          </section>

          <section className="min-w-0 rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-(--ink)">
              <CalendarClock className="size-[14px] text-(--ink-2)" strokeWidth={1.75} />
              Due in the next 90 days
            </h3>
            <div className="max-h-[260px] overflow-y-auto" tabIndex={0} aria-label="Items due in the next 90 days">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-(--ink-2)">
                    <th className="pb-1 font-medium">Tail</th>
                    <th className="pb-1 font-medium">Type</th>
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
                      <td className="py-1.5 text-(--ink-2)">{typeName[d.type] ?? d.type}</td>
                      <td className="py-1.5 text-(--ink)">{d.item}</td>
                      <td className="py-1.5 tabular text-(--ink-2)">
                        {d.date
                          ? formatDate(d.date)
                          : d.fh_to_tau !== undefined && d.fh_to_tau !== null
                            ? `${formatFH(d.fh_to_tau)} to risk threshold`
                            : "Not dated"}
                      </td>
                    </tr>
                  ))}
                  {fleet.due_90_days.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-(--ink-2)">
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
            <Link href="/recommendations" className="text-[12px] text-(--accent) underline-offset-2 hover:underline">
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
                <div className="flex shrink-0 items-center gap-2">
                  {r.type && <span className="text-[11px] text-(--ink-2)">{typeName[r.type] ?? r.type}</span>}
                  {r.tail && <TailNumber tail={r.tail} className="text-[12px]" />}
                </div>
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
        <span className={`text-[11px] ${good === false ? "text-(--status-critical)" : "text-(--ink-2)"}`}>{sub}</span>
      )}
    </div>
  );
}
