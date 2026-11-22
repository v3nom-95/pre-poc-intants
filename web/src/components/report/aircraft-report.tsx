import Link from "next/link";
import { TailNumber } from "@/components/domain/tail-number";
import { StatusTag, PriorityTag } from "@/components/domain/status-tag";
import { PrintButton } from "./print-button";
import { formatDate, formatFH, formatNumber, formatPct } from "@/lib/format";
import type { AircraftData } from "@/lib/data";
import type { PlanData } from "@/lib/plan-types";
import type { Status } from "@/lib/domain-types";

// Mixed-fleet fields (SPEC 14.1) are optional so older exports still render.
type EngineRow = {
  position?: string | number | null;
  serial?: string | null;
  engine_serial?: string | null;
  metric?: string | null;
  current_margin_c?: number | null;
  slope_c_per_efh?: number | null;
  projected_efh_to_limit?: number | null;
  current_efh?: number | null;
  efh?: number | null;
  operating_hours?: number | null;
  flagged?: boolean | null;
};
type ReportAircraft = AircraftData & {
  type?: string | null;
  type_name?: string | null;
  engines?: EngineRow[] | null;
  engine_operating_hours?: number | null;
  apu_hours?: number | null;
};

const RECENT_ROWS = 10;
const UTILISATION_MONTHS = 12;

/** Unit label for a governing hard-time limit. */
function limitUnit(governing: string | null): string {
  switch (governing) {
    case "Calendar":
      // rules.py expresses calendar remaining life in months.
      return "months";
    case "Landings":
      return "landings";
    case "Cycles":
      return "LCF cycles";
    case "EFH":
      return "EFH";
    case "FH":
      return "FH";
    default:
      return governing ?? "";
  }
}

function lifeText(c: AircraftData["components"][number]): string {
  if (c.concept === "HT" && c.remaining !== null) {
    return `${formatNumber(c.remaining, 0)} ${limitUnit(c.governing_limit)} remaining (${c.governing_limit} governs)`;
  }
  if (c.fh_to_tau !== null) {
    const risk = c.prob_fail_before_next_phase !== null ? `, ${formatPct(c.prob_fail_before_next_phase * 100)} risk before next phase` : "";
    return `${formatFH(c.fh_to_tau)} to risk threshold${risk}`;
  }
  return "No model output";
}

/** Rewrite ISO dates inside exported free text (for example "Replace by 2029-03-24") as 24 Mar 2029. */
function readableDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => formatDate(iso));
}

function engineRows(ac: ReportAircraft): EngineRow[] {
  if (ac.engines && ac.engines.length > 0) return ac.engines;
  const info = ac.engine_trend_info as EngineRow | EngineRow[] | null;
  if (Array.isArray(info)) return info;
  if (info) return [{ ...info, position: "1", serial: ac.engine_serial }];
  return ac.engine_serial ? [{ position: "1", serial: ac.engine_serial }] : [];
}

function utilisationSummary(rows: AircraftData["utilisation_monthly"]) {
  const recent = rows.slice(-UTILISATION_MONTHS);
  const byMission = new Map<string, number>();
  const monthly = recent.map((r) => {
    let total = 0;
    for (const [k, v] of Object.entries(r)) {
      if (k === "month" || typeof v !== "number") continue;
      total += v;
      byMission.set(k, (byMission.get(k) ?? 0) + v);
    }
    return { month: String(r.month), total };
  });
  const totalFh = monthly.reduce((a, m) => a + m.total, 0);
  const missions = [...byMission.entries()]
    .map(([mission, fh]) => ({ mission, fh, share: totalFh > 0 ? (fh / totalFh) * 100 : 0 }))
    .sort((a, b) => b.fh - a.fh);
  return { monthly, missions, totalFh, months: recent.length };
}

function monthLabel(ym: string): string {
  return formatDate(`${ym}-01`).replace(/^1 /, "");
}

export function AircraftReport({
  aircraft,
  status,
  asOf,
  plan,
}: {
  aircraft: AircraftData;
  status: Status;
  asOf: string;
  plan: PlanData | null;
}) {
  const ac = aircraft as ReportAircraft;
  const openRecs = aircraft.recommendations.filter((r) => r.status === "Open");
  const planTasks = (plan?.tasks ?? []).filter((t) => t.tail === aircraft.tail).sort((a, b) => a.sequence - b.sequence);
  const planAircraft = plan?.aircraft.find((a) => a.tail === aircraft.tail) ?? null;
  const engines = engineRows(ac);
  const util = utilisationSummary(aircraft.utilisation_monthly);
  const fatigue = aircraft.fatigue as { projected_fi100_date?: string | null; fi_per_fh?: number | null } | null;
  const typeName = ac.type_name ?? ac.type ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/aircraft/${aircraft.tail}`} className="text-[13px] text-(--accent) hover:underline">
            Back to {aircraft.tail}
          </Link>
          <h1 className="text-[28px] font-semibold text-(--ink)">Aircraft report</h1>
        </div>
        <PrintButton />
      </div>

      <article
        aria-label={`Aircraft report for ${aircraft.tail}`}
        className="aircraft-report rounded-[8px] border border-(--rule) bg-(--sheet) p-6 print:border-0 print:p-0"
      >
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-(--rule) pb-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <TailNumber tail={aircraft.tail} className="text-[28px]" />
              <StatusTag status={status} />
            </div>
            <p className="text-[12px] text-(--ink-2)">
              {typeName ? `${typeName}, ` : ""}
              {aircraft.base}. Predictive Recommendation Engine (PRE): data as of {formatDate(asOf)}.
            </p>
          </div>
          <p className="max-w-[220px] text-right text-[11px] text-(--ink-3)">
            Proof of concept. All aircraft, data and figures are fictional.
          </p>
        </div>

        <section aria-labelledby="rep-summary" className="mb-6">
          <h2 id="rep-summary" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Summary
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
            <Fact label="Induction" value={formatDate(aircraft.induction_date)} />
            <Fact label="Airframe FH" value={formatFH(aircraft.airframe_fh, 1)} />
            <Fact label="Landings" value={`${formatNumber(aircraft.landings)} landings`} />
            <Fact label="Fatigue index" value={`${formatNumber(aircraft.fi, 1)} / 100`} />
            {ac.engine_operating_hours != null && (
              <Fact label="Engine operating hours" value={`${formatNumber(ac.engine_operating_hours, 1)} h`} />
            )}
            {ac.apu_hours != null && <Fact label="APU hours" value={`${formatNumber(ac.apu_hours, 1)} APU hours`} />}
            <Fact
              label="FI 100 projected"
              value={fatigue?.projected_fi100_date ? formatDate(fatigue.projected_fi100_date) : "Not projected"}
            />
            <Fact label="Planned withdrawal" value={String(aircraft.planned_withdrawal_year)} />
            <Fact label="Open recommendations" value={formatNumber(openRecs.length)} />
          </dl>
        </section>

        {engines.length > 0 && (
          <section aria-labelledby="rep-engines" className="mb-6">
            <h2 id="rep-engines" className="mb-2 text-[13px] font-semibold text-(--ink)">
              {engines.length > 1 ? "Engines" : "Engine"}
            </h2>
            <ReportTable
              columns={["Position", "Serial", "Trend metric", "Current margin", "Trend", "Projected to limit"]}
              rows={engines.map((e) => [
                String(e.position ?? "1"),
                e.serial ?? e.engine_serial ?? "Not recorded",
                e.metric ?? "EGT margin",
                e.current_margin_c != null ? `${formatNumber(e.current_margin_c, 1)} °C` : "No reading",
                e.slope_c_per_efh != null ? `${formatNumber(e.slope_c_per_efh, 3)} °C per EFH` : "No trend",
                e.projected_efh_to_limit != null ? `${formatNumber(e.projected_efh_to_limit, 0)} EFH` : "Not projected",
              ])}
            />
          </section>
        )}

        <section aria-labelledby="rep-components" className="mb-6">
          <h2 id="rep-components" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Components: life and risk
          </h2>
          <ReportTable
            columns={["ATA", "Component", "Position", "Serial", "Concept", "Life or risk", "Next action"]}
            rows={aircraft.components.map((c) => [c.ata, c.component, c.position, c.serial, c.concept, lifeText(c), readableDates(c.next_action)])}
          />
        </section>

        <section aria-labelledby="rep-recs" className="mb-6">
          <h2 id="rep-recs" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Open recommendations
          </h2>
          {openRecs.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">No open recommendations for this aircraft.</p>
          ) : (
            <ul className="flex flex-col">
              {openRecs.map((r) => (
                <li key={r.id} className="flex items-start gap-3 border-b border-(--rule) py-1.5 text-[12px] print:break-inside-avoid">
                  <PriorityTag priority={r.priority} />
                  <span className="w-[100px] shrink-0 tabular text-(--ink-2)">{r.id}</span>
                  <span className="flex-1 text-(--ink)">{r.title}</span>
                  <span className="w-[150px] shrink-0 text-right tabular text-(--ink-2)">
                    {r.due.date ? `Due ${formatDate(r.due.date)}` : r.due.fh_remaining != null ? `${formatFH(r.due.fh_remaining)} remaining` : ""}
                    {r.due.governing ? ` (${r.due.governing})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="rep-plan" className="mb-6">
          <h2 id="rep-plan" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Action plan
          </h2>
          {planAircraft && <p className="mb-2 text-[12px] text-(--ink-2)">{planAircraft.outlook}</p>}
          {planTasks.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">No planned tasks for this aircraft.</p>
          ) : (
            <ReportTable
              columns={["Task", "Priority", "Planned", "Slot", "Man-hours", "Task title"]}
              rows={planTasks.map((t) => [
                t.id,
                t.priority,
                formatDate(t.planned_date),
                t.slot,
                `${formatNumber(t.man_hours, 1)} man-hours`,
                t.title,
              ])}
            />
          )}
        </section>

        <section aria-labelledby="rep-util" className="mb-6 print:break-inside-avoid">
          <h2 id="rep-util" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Utilisation, last {util.months} months: {formatFH(util.totalFh, 1)}
          </h2>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <ReportTable
              columns={["Mission", "FH", "Share"]}
              rows={util.missions.map((m) => [m.mission, formatFH(m.fh, 1), formatPct(m.share)])}
            />
            <ReportTable columns={["Month", "FH"]} rows={util.monthly.map((m) => [monthLabel(m.month), formatFH(m.total, 1)])} />
          </div>
        </section>

        <section aria-labelledby="rep-snags" className="mb-6">
          <h2 id="rep-snags" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Recent snags
          </h2>
          {aircraft.snags.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">No snags recorded.</p>
          ) : (
            <ReportTable
              columns={["Date", "ATA", "Description", "Rectification", "Status"]}
              rows={aircraft.snags
                .slice(0, RECENT_ROWS)
                .map((s) => [formatDate(s.date), s.ata != null ? String(s.ata) : "Not recorded", s.description, s.rectification, s.status])}
            />
          )}
        </section>

        <section aria-labelledby="rep-maint" className="mb-2">
          <h2 id="rep-maint" className="mb-2 text-[13px] font-semibold text-(--ink)">
            Recent maintenance
          </h2>
          {aircraft.history.length === 0 ? (
            <p className="text-[12px] text-(--ink-2)">No maintenance history recorded.</p>
          ) : (
            <ReportTable
              columns={["Date", "Type", "Description"]}
              rows={aircraft.history.slice(0, RECENT_ROWS).map((h) => [formatDate(h.date), h.type, h.description])}
            />
          )}
        </section>
      </article>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-(--ink-2)">{label}</dt>
      <dd className="tabular text-[13px] font-medium text-(--ink)">{value}</dd>
    </div>
  );
}

function ReportTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <table className="w-full text-[11.5px]">
      <thead>
        <tr className="border-b border-(--rule) text-left text-(--ink-2)">
          {columns.map((c) => (
            <th key={c} scope="col" className="py-1 pr-3 font-semibold">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-(--rule) align-top print:break-inside-avoid">
            {row.map((cell, j) => (
              <td key={j} className={`py-1 pr-3 text-(--ink) ${cell.length <= 16 ? "whitespace-nowrap" : ""}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
