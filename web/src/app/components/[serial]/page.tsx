import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { TailNumber } from "@/components/domain/tail-number";
import { LifeStrip } from "@/components/domain/life-strip";
import { SurvivalCurveChart } from "@/components/charts/survival-curve-chart";
import { getComponent, getAllComponentSerials } from "@/lib/data";
import { formatFH, formatPct, formatDate, formatNumber } from "@/lib/format";

export function generateStaticParams() {
  return getAllComponentSerials().map((serial) => ({ serial }));
}

export default async function ComponentPage({ params }: { params: Promise<{ serial: string }> }) {
  const { serial } = await params;
  const c = getComponent(serial);

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <header
          className="flex flex-wrap items-center gap-4 rounded-[8px] border border-(--rule) bg-(--sheet) p-5"
          style={{ borderLeft: "3px solid var(--accent)" }}
        >
          <div>
            <h1 className="text-[22px] font-semibold text-(--ink) page-title">{c.name}</h1>
            <p className="text-[12px] text-(--ink-2)">
              {c.part_number}, serial {c.serial} {c.lot && `, lot ${c.lot}`}
            </p>
          </div>
          <Fact label="Position" value={
            <Link href={`/aircraft/${c.current_tail}`} className="hover:text-(--accent)">
              <TailNumber tail={c.current_tail} className="text-[13px]" /> ({c.current_position})
            </Link>
          } />
          <Fact label="Concept" value={c.concept} />
          <Fact label="Criticality" value={c.criticality === "flight_safety" ? "Flight safety" : "Mission"} />
        </header>

        {c.concept === "HT" ? (
          <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Remaining life</h3>
            <p className="text-[13px] text-(--ink)">
              {c.remaining !== null ? `${formatNumber(c.remaining, 0)} ${c.governing_limit} remaining` : "No limit data available."}
            </p>
            <p className="mt-1 text-[12px] text-(--ink-2)">
              Hard-time item: remaining life is the minimum across all applicable limits, whichever comes first.
            </p>
          </section>
        ) : (
          <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Life strip</h3>
            {c.fh_exposure !== null && c.fh_to_tau !== null && c.fh_to_tau_p10 !== null && c.fh_to_tau_p90 !== null ? (
              <LifeStrip
                fhExposure={c.fh_exposure}
                fhToTau={c.fh_to_tau}
                fhToTauP10={c.fh_to_tau_p10}
                fhToTauP90={c.fh_to_tau_p90}
              />
            ) : (
              <p className="text-[12px] text-(--ink-2)">Not enough events to fit a risk model for this unit.</p>
            )}
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Fact
                label="Probability of failure before next phase inspection"
                value={c.prob_fail_before_next_phase !== null ? formatPct(c.prob_fail_before_next_phase * 100, 0) : "N/A"}
              />
              <Fact
                label="FH to risk threshold (80% interval)"
                value={
                  c.fh_to_tau !== null
                    ? `${formatFH(c.fh_to_tau)} (${formatFH(c.fh_to_tau_p10 ?? 0)} to ${formatFH(c.fh_to_tau_p90 ?? 0)})`
                    : "N/A"
                }
              />
            </div>
            {c.explanation && (
              <p className="mt-3 rounded-[6px] bg-(--paper) p-2.5 text-[12px] text-(--ink)">{c.explanation}</p>
            )}
            <p className="mt-2 text-[11px] text-(--ink-3)">
              Fleet units of this part number: {c.fleet_units}, confirmed failures: {c.fleet_confirmed_failures}
            </p>
          </section>
        )}

        {c.concept !== "HT" && (
          <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
            <SurvivalCurveChart points={c.survival_curve} unitFhExposure={c.fh_exposure} />
          </section>
        )}

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Installation history</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-(--ink-2)">
                  <th className="pb-1 font-medium">Date</th>
                  <th className="pb-1 font-medium">Event</th>
                  <th className="pb-1 font-medium">Tail</th>
                  <th className="pb-1 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {c.install_history.map((h, i) => (
                  <tr key={i} className="border-t border-(--rule)">
                    <td className="py-1.5 tabular text-(--ink-2)">{formatDate(h.date)}</td>
                    <td className="py-1.5 text-(--ink)">{h.event_type}</td>
                    <td className="py-1.5">
                      <Link href={`/aircraft/${h.tail}`} className="hover:text-(--accent)">
                        <TailNumber tail={h.tail} className="text-[12px]" />
                      </Link>
                    </td>
                    <td className="py-1.5 text-(--ink-2)">{h.reason ?? "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] text-(--ink-2)">{label}</span>
      <span className="text-[13px] tabular text-(--ink)">{value}</span>
    </div>
  );
}
