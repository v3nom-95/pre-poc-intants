import { AppShell } from "@/components/shell/app-shell";
import { TailNumber } from "@/components/domain/tail-number";
import { StatusTag, PriorityTag } from "@/components/domain/status-tag";
import { AircraftPlanform } from "@/components/domain/aircraft-planform";
import { MissionMixChart, FatigueChart, EngineTrendChart } from "@/components/charts/aircraft-charts";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getAircraft, getAllAircraftTails, getFleet } from "@/lib/data";
import { formatFH, formatNumber, formatDate } from "@/lib/format";

export function generateStaticParams() {
  return getAllAircraftTails().map((tail) => ({ tail }));
}

export default async function AircraftPage({ params }: { params: Promise<{ tail: string }> }) {
  const { tail } = await params;
  const aircraft = getAircraft(tail);
  const fleet = getFleet();
  const status = fleet.aircraft.find((a) => a.tail === tail)?.status ?? "Serviceable";
  const openRecs = aircraft.recommendations.filter((r) => r.status === "Open");
  const pastRecs = aircraft.recommendations.filter((r) => r.status !== "Open");

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <header
          className="flex flex-wrap items-center gap-6 rounded-[8px] border border-(--rule) bg-(--sheet) p-5"
          style={{ borderLeft: "3px solid var(--accent)" }}
        >
          <div className="flex items-center gap-3">
            <TailNumber tail={aircraft.tail} className="text-[32px]" />
            <StatusTag status={status} />
          </div>
          <div className="h-10 w-px bg-(--rule)" />
          <div className="flex flex-wrap items-center gap-6">
            <Fact label="Base" value={aircraft.base} />
            <Fact label="Induction" value={formatDate(aircraft.induction_date)} />
            <Fact label="Airframe FH" value={formatFH(aircraft.airframe_fh)} />
            <Fact label="Landings" value={formatNumber(aircraft.landings)} />
            <Fact label="Fatigue index" value={`${formatNumber(aircraft.fi, 1)} / 100`} />
            {aircraft.engine_serial && <Fact label="Engine serial" value={aircraft.engine_serial} />}
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
              <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Airframe diagram</h3>
              <div className="aspect-[3/5] w-full">
                <AircraftPlanform aircraft={aircraft} />
              </div>
              <p className="mt-2 text-[11px] text-(--ink-3)">Click a marker to open that component.</p>
            </div>
          </div>

          <div className="lg:col-span-7">
            <Tabs defaultValue="components">
              <TabsList>
                <TabsTrigger value="components">Components</TabsTrigger>
                <TabsTrigger value="utilisation">Utilisation</TabsTrigger>
                <TabsTrigger value="engine">Engine</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="snags">Snags</TabsTrigger>
                <TabsTrigger value="recs">Recommendations</TabsTrigger>
              </TabsList>

              <TabsContent value="components" className="mt-3">
                <div className="overflow-x-auto rounded-[8px] border border-(--rule)">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-(--paper) text-left text-(--ink-2)">
                        <th className="px-3 py-2 font-medium">ATA</th>
                        <th className="px-3 py-2 font-medium">Component</th>
                        <th className="px-3 py-2 font-medium">Pos</th>
                        <th className="px-3 py-2 font-medium">Serial</th>
                        <th className="px-3 py-2 font-medium">Concept</th>
                        <th className="px-3 py-2 font-medium">Status / life</th>
                        <th className="px-3 py-2 font-medium">Next action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aircraft.components.map((c) => (
                        <tr key={c.serial} className="border-t border-(--rule)">
                          <td className="px-3 py-2 tabular text-(--ink-2)">{c.ata}</td>
                          <td className="px-3 py-2 text-(--ink)">{c.component}</td>
                          <td className="px-3 py-2 tabular text-(--ink-2)">{c.position}</td>
                          <td className="px-3 py-2 tabular">
                            <a href={`/components/${c.serial}`} className="text-(--accent) hover:underline">
                              {c.serial}
                            </a>
                          </td>
                          <td className="px-3 py-2 text-(--ink-2)">{c.concept}</td>
                          <td className="px-3 py-2 tabular text-(--ink-2)">
                            {c.concept === "HT" && c.remaining !== null
                              ? `${formatNumber(c.remaining, 0)} ${c.governing_limit} remaining`
                              : c.fh_to_tau !== null
                                ? `${formatFH(c.fh_to_tau)} to risk threshold`
                                : "N/A"}
                          </td>
                          <td className="px-3 py-2 text-(--ink-2)">{c.next_action}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </TabsContent>

              <TabsContent value="utilisation" className="mt-3 flex flex-col gap-4">
                <MissionMixChart utilisation={aircraft.utilisation_monthly} />
                <FatigueChart
                  fiSeries={aircraft.fi_series}
                  withdrawalYear={aircraft.planned_withdrawal_year}
                  projectedFi100Date={(aircraft.fatigue as { projected_fi100_date?: string | null } | null)?.projected_fi100_date}
                />
              </TabsContent>

              <TabsContent value="engine" className="mt-3">
                <EngineTrendChart points={aircraft.engine_trend_points} />
              </TabsContent>

              <TabsContent value="history" className="mt-3">
                <ul className="flex flex-col gap-2">
                  {aircraft.history.map((h, i) => (
                    <li key={i} className="flex items-start gap-3 rounded-[6px] border border-(--rule) p-2.5 text-[12px]">
                      <span className="w-24 shrink-0 tabular text-(--ink-2)">{formatDate(h.date)}</span>
                      <span className="w-32 shrink-0 text-(--ink-2)">{h.type}</span>
                      <span className="text-(--ink)">{h.description}</span>
                    </li>
                  ))}
                  {aircraft.history.length === 0 && (
                    <p className="py-4 text-center text-[12px] text-(--ink-2)">No maintenance history recorded.</p>
                  )}
                </ul>
              </TabsContent>

              <TabsContent value="snags" className="mt-3">
                <ul className="flex flex-col gap-2">
                  {aircraft.snags.map((s) => (
                    <li key={s.snag_id} className="rounded-[6px] border border-(--rule) p-2.5 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="tabular text-(--ink-2)">
                          {formatDate(s.date)} · ATA {s.ata ?? "N/A"}
                        </span>
                        <span
                          className={s.status === "Open" ? "text-(--status-critical)" : "text-(--ink-3)"}
                        >
                          {s.status}
                        </span>
                      </div>
                      <p className="mt-1 text-(--ink)">{s.description}</p>
                      <p className="mt-0.5 text-(--ink-2)">{s.rectification}</p>
                    </li>
                  ))}
                  {aircraft.snags.length === 0 && (
                    <p className="py-4 text-center text-[12px] text-(--ink-2)">No snags recorded.</p>
                  )}
                </ul>
              </TabsContent>

              <TabsContent value="recs" className="mt-3 flex flex-col gap-4">
                <div>
                  <h4 className="mb-2 text-[12px] font-semibold text-(--ink-2)">Open ({openRecs.length})</h4>
                  <RecList recs={openRecs} empty="No open recommendations for this aircraft." />
                </div>
                <div>
                  <h4 className="mb-2 text-[12px] font-semibold text-(--ink-2)">Past ({pastRecs.length})</h4>
                  <RecList recs={pastRecs} empty="No past recommendations recorded." />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] text-(--ink-2)">{label}</span>
      <span className="text-[15px] font-medium tabular text-(--ink)">{value}</span>
    </div>
  );
}

function RecList({ recs, empty }: { recs: { id: string; title: string; priority: "Critical" | "High" | "Medium" | "Low"; status: string }[]; empty: string }) {
  if (recs.length === 0) return <p className="text-[12px] text-(--ink-2)">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {recs.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 rounded-[6px] border border-(--rule) p-2.5">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <PriorityTag priority={r.priority} />
            <span className="truncate text-[13px] text-(--ink)">{r.title}</span>
          </div>
          <span className="shrink-0 text-[11px] text-(--ink-3)">{r.status}</span>
        </li>
      ))}
    </ul>
  );
}
