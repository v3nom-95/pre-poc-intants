import Link from "next/link";
import { Printer } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { TailNumber } from "@/components/domain/tail-number";
import { StatusTag, PriorityTag } from "@/components/domain/status-tag";
import { AircraftPlanform } from "@/components/domain/aircraft-planform";
import { MissionMixChart, FatigueChart, EnginePanel } from "@/components/charts/aircraft-charts";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getAircraft, getAllAircraftTails, getFleet, getTypes } from "@/lib/data";
import { formatFH, formatNumber, formatDate, formatRemaining, formatIsoDatesInText } from "@/lib/format";
import { AircraftPlan } from "@/components/plan/aircraft-plan";
import { getPlan } from "@/lib/plan-data";

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
  const plan = getPlan();
  const typeInfo = getTypes().find((t) => t.key === aircraft.type);
  const fatigue = aircraft.fatigue as {
    projected_fi100_date?: string | null;
    fi_per_fh?: number;
    heavy_mission?: string;
    relief_mission?: string;
    heavy_mission_share_trailing?: number;
    flagged_before_withdrawal?: boolean;
    life_gain_days_if_shifted?: number | null;
  } | null;
  const op = aircraft.operating_hours;
  // Components sorted the way a history card file is kept: ATA, item, position.
  const components = [...aircraft.components].sort(
    (a, b) => a.ata.localeCompare(b.ata) || a.component.localeCompare(b.component) || a.position.localeCompare(b.position)
  );
  const engineLabel = aircraft.engines.length === 1 ? "Engine serial" : "Engines";
  const engineValue =
    aircraft.engines.length === 1
      ? aircraft.engines[0].serial
      : `${aircraft.engines.length} fitted, ${aircraft.engines[0]?.metric ?? ""} monitored`;

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <header
          className="flex flex-wrap items-center gap-6 rounded-[8px] border border-(--rule) bg-(--sheet) p-5"
          style={{ borderLeft: "3px solid var(--accent)" }}
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h1 className="m-0 leading-none">
                <TailNumber tail={aircraft.tail} className="text-[32px]" />
              </h1>
              <StatusTag status={status} />
            </div>
            <span className="text-[13px] text-(--ink-2)">
              {aircraft.type_name}, {aircraft.role.toLowerCase()}
            </span>
          </div>
          <div className="h-10 w-px bg-(--rule)" />
          <div className="flex flex-wrap items-center gap-6">
            <Fact label="Base" value={aircraft.base} />
            <Fact label="Induction" value={formatDate(aircraft.induction_date)} />
            <Fact label="Airframe FH" value={`${formatFH(aircraft.airframe_fh)} of ${formatFH(aircraft.ttl_fh)} TTL`} />
            <Fact label="Landings" value={formatNumber(aircraft.landings)} />
            <Fact label="Fatigue index" value={`${formatNumber(aircraft.fi, 1)} / 100`} />
            {aircraft.engines.length > 0 && <Fact label={engineLabel} value={engineValue} />}
            {aircraft.apu_hours !== null && <Fact label="APU hours (5 yr)" value={`${formatNumber(aircraft.apu_hours, 1)} h`} />}
          </div>
          <Link
            href={`/aircraft/${aircraft.tail}/report`}
            className="ml-auto inline-flex items-center gap-1.5 rounded-[6px] border border-(--rule) px-3 py-1.5 text-[13px] text-(--ink) hover:bg-(--paper)"
          >
            <Printer className="size-4" aria-hidden />
            Print report
          </Link>
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
                <TabsTrigger value="engine">{aircraft.engines.length > 1 ? "Engines" : "Engine"}</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="snags">Snags</TabsTrigger>
                <TabsTrigger value="recs">Recommendations</TabsTrigger>
                <TabsTrigger value="plan">Plan</TabsTrigger>
              </TabsList>

              <TabsContent value="components" className="mt-3">
                <div className="overflow-x-auto rounded-[8px] border border-(--rule)">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-(--paper) text-left text-(--ink-2)">
                        <th className="px-3 py-2 font-medium">ATA</th>
                        <th className="px-3 py-2 font-medium">Component</th>
                        <th className="px-3 py-2 font-medium">Position</th>
                        <th className="px-3 py-2 font-medium">Serial</th>
                        <th className="px-3 py-2 font-medium">Concept</th>
                        <th className="px-3 py-2 font-medium">Life or risk</th>
                        <th className="px-3 py-2 font-medium">Next action</th>
                        <th className="px-3 py-2 font-medium">Task card</th>
                      </tr>
                    </thead>
                    <tbody>
                      {components.map((c) => (
                        <tr key={c.serial} className="border-t border-(--rule)">
                          <td className="px-3 py-2 tabular text-(--ink-2)">{c.ata}</td>
                          <td className="px-3 py-2 text-(--ink)">{c.component}</td>
                          <td className="px-3 py-2 tabular text-(--ink-2)">{c.position}</td>
                          <td className="whitespace-nowrap px-3 py-2 tabular">
                            <a href={`/components/${c.serial}`} className="text-(--accent) hover:underline">
                              {c.serial}
                            </a>
                          </td>
                          <td className="px-3 py-2 text-(--ink-2)">{c.concept}</td>
                          <td className="px-3 py-2 tabular text-(--ink-2)">
                            {c.concept === "HT" && c.remaining !== null
                              ? `${formatRemaining(c.remaining, c.governing_limit)} left, ${c.governing_limit === "Calendar" ? "calendar" : c.governing_limit} governs`
                              : c.fh_to_tau !== null
                                ? `${formatNumber(c.fh_to_tau, 0)} ${c.exposure_unit ?? "FH"} to risk threshold`
                                : "No model risk"}
                          </td>
                          <td className="px-3 py-2 text-(--ink-2)">{formatIsoDatesInText(c.next_action)}</td>
                          <td className="whitespace-nowrap px-3 py-2 tabular text-(--ink-2)">{c.task_card ?? "None"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </TabsContent>

              <TabsContent value="utilisation" className="mt-3 flex flex-col gap-4">
                <MissionMixChart utilisation={aircraft.utilisation_monthly} missions={typeInfo?.missions ?? []} />
                <FatigueChart
                  fiSeries={aircraft.fi_series}
                  withdrawalYear={aircraft.planned_withdrawal_year}
                  projectedFi100Date={fatigue?.projected_fi100_date}
                  fatigueModel={typeInfo?.fatigue_model}
                />
                {fatigue && (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-[8px] border border-(--rule) p-3 text-[12px] sm:grid-cols-4">
                    <Detail label="FI per FH (12 mo)" value={fatigue.fi_per_fh !== undefined ? formatNumber(fatigue.fi_per_fh, 4) : "None"} />
                    <Detail
                      label="Projected FI 100"
                      value={fatigue.projected_fi100_date ? formatDate(fatigue.projected_fi100_date) : "Not projected"}
                      alert={!!fatigue.flagged_before_withdrawal}
                    />
                    <Detail
                      label={`${fatigue.heavy_mission ?? "Heaviest mission"} share (12 mo)`}
                      value={
                        fatigue.heavy_mission_share_trailing !== undefined
                          ? `${formatNumber(fatigue.heavy_mission_share_trailing * 100, 1)}%`
                          : "None"
                      }
                    />
                    <Detail
                      label={`Life gain if ${fatigue.heavy_mission?.toLowerCase() ?? "heavy"} tasking moves to ${fatigue.relief_mission?.toLowerCase() ?? "lighter missions"}`}
                      value={fatigue.life_gain_days_if_shifted ? `${formatNumber(fatigue.life_gain_days_if_shifted, 0)} days` : "None"}
                    />
                  </dl>
                )}
              </TabsContent>

              <TabsContent value="engine" className="mt-3">
                <div className="flex flex-col gap-4">
                  <div className="overflow-x-auto rounded-[8px] border border-(--rule)">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="bg-(--paper) text-left text-(--ink-2)">
                          <th className="px-3 py-2 font-medium">Position</th>
                          <th className="px-3 py-2 font-medium">Serial</th>
                          <th className="px-3 py-2 text-right font-medium">EFH</th>
                          <th className="px-3 py-2 text-right font-medium">Operating hours</th>
                          <th className="px-3 py-2 text-right font-medium">Ground-run hours</th>
                          <th className="px-3 py-2 text-right font-medium">
                            {aircraft.engines[0]?.metric ?? "Margin"} now
                            {aircraft.engines[0] ? ` (limit ${formatNumber(aircraft.engines[0].threshold_c, 0)} °C)` : ""}
                          </th>
                          <th className="px-3 py-2 text-right font-medium">EFH to limit</th>
                        </tr>
                      </thead>
                      <tbody className="tabular whitespace-nowrap">
                        {aircraft.engines.map((e) => (
                          <tr key={e.position} className="border-t border-(--rule)">
                            <td className="px-3 py-2">{e.position}</td>
                            <td className="px-3 py-2">
                              <a href={`/components/${e.serial}`} className="text-(--accent) hover:underline">
                                {e.serial}
                              </a>
                            </td>
                            <td className="px-3 py-2 text-right">{e.efh !== null ? formatNumber(e.efh, 1) : "None"}</td>
                            <td className="px-3 py-2 text-right">{e.operating_hours !== null ? `${formatNumber(e.operating_hours, 1)} h` : "None"}</td>
                            <td className="px-3 py-2 text-right">{e.ground_run_hours !== null ? `${formatNumber(e.ground_run_hours, 1)} h` : "None"}</td>
                            <td className="px-3 py-2 text-right">
                              {e.trend_info ? `${formatNumber(e.trend_info.current_margin_c, 1)} °C` : "No trend yet"}
                            </td>
                            <td className={`px-3 py-2 text-right ${e.trend_info?.flagged ? "font-semibold text-(--status-critical)" : ""}`}>
                              {e.trend_info && e.trend_info.projected_efh_to_limit !== null
                                ? `${formatNumber(e.trend_info.projected_efh_to_limit, 0)} EFH${e.trend_info.flagged ? ", flagged" : ""}`
                                : "Not projected"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <EnginePanel engines={aircraft.engines} />
                  <div className="rounded-[8px] border border-(--rule) p-3">
                    <h4 className="mb-2 text-[12px] font-semibold text-(--ink)">Operating hours since {formatDate(op.window_start)}</h4>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
                      <Detail label="Flight hours" value={formatFH(op.flight_hours, 1)} />
                      <Detail label="Taxi running" value={`${formatNumber(op.taxi_hours, 1)} h`} />
                      <Detail label="Engine ground runs" value={`${formatNumber(op.ground_runs)} runs, ${formatNumber(op.ground_run_hours, 1)} h`} />
                      <Detail label="APU hours" value={op.apu_hours !== null ? `${formatNumber(op.apu_hours, 1)} h` : "No APU fitted"} />
                    </dl>
                    <p className="mt-2 text-[11px] text-(--ink-2)">
                      Engine operating hours are flight hours plus taxi and ground running. The engine table counts each engine since new,
                      wherever it was installed.
                    </p>
                  </div>
                </div>
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

              <TabsContent value="plan" className="mt-3">
                <AircraftPlan plan={plan} tail={aircraft.tail} />
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

function Detail({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-(--ink-2)">{label}</dt>
      <dd className={`font-medium tabular ${alert ? "text-(--status-critical)" : "text-(--ink)"}`}>{value}</dd>
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
