import Link from "next/link";
import { PriorityTag } from "@/components/domain/status-tag";
import { formatDate, formatFH, formatNumber, formatPct } from "@/lib/format";
import type { PlanData } from "@/lib/plan-types";

// Server-rendered summary of one aircraft's part of the action plan.
export function AircraftPlan({ plan, tail }: { plan: PlanData; tail: string }) {
  const ac = plan.aircraft.find((a) => a.tail === tail);
  if (!ac) {
    return <p className="py-4 text-center text-[12px] text-(--ink-2)">This aircraft is not in the action plan.</p>;
  }
  const tasks = plan.tasks.filter((t) => t.tail === tail);
  const horizonEnd = new Date(Date.parse(plan.as_of) + (plan.horizon_days - 1) * 86_400_000).toISOString().slice(0, 10);
  const inputs = ac.inputs.filter((i) => i.task_ids.length > 0 || i.start <= horizonEnd);

  return (
    <div className="flex flex-col gap-4 text-[12px]">
      <p className="text-[13px] text-(--ink)">{ac.outlook}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-1">
        <div className="flex gap-1">
          <dt className="text-(--ink-3)">Utilisation</dt>
          <dd className="tabular text-(--ink)">{formatNumber(ac.fh_per_day * 30, 1)} FH per 30 days</dd>
        </div>
        {ac.next_periodic && (
          <div className="flex gap-1">
            <dt className="text-(--ink-3)">Next periodic servicing</dt>
            <dd className="tabular text-(--ink)">
              {formatDate(ac.next_periodic.date)} ({formatFH(ac.next_periodic.fh_to_go, 1)} to go)
            </dd>
          </div>
        )}
        {ac.next_phase && (
          <div className="flex gap-1">
            <dt className="text-(--ink-3)">Next phase inspection</dt>
            <dd className="tabular text-(--ink)">
              {ac.next_phase.in_progress
                ? "In progress"
                : `${formatDate(ac.next_phase.date)} (${formatFH(ac.next_phase.fh_to_go, 1)} to go)`}
            </dd>
          </div>
        )}
      </dl>

      <div>
        <h4 className="mb-2 text-[12px] font-semibold text-(--ink-2)">Planned tasks ({tasks.length})</h4>
        {tasks.length === 0 ? (
          <p className="py-2 text-(--ink-2)">No open recommendations, so only scheduled servicing is planned.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((t) => (
              <li key={t.id} className="rounded-[6px] border border-(--rule) p-2.5">
                <div className="flex items-start gap-2">
                  <PriorityTag priority={t.priority} className="shrink-0" />
                  <span className="text-(--ink)">{t.title}</span>
                </div>
                <p className="mt-1 tabular text-(--ink-2)">
                  {t.slot}, planned {formatDate(t.planned_date)}, {formatNumber(t.man_hours, 1)} man-hours
                  {t.risk_if_deferred ? `, ${formatPct(t.risk_if_deferred.probability * 100)} failure risk if the slot is missed` : ""}
                </p>
                <p className="mt-1 text-(--ink-2)">{t.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[12px] font-semibold text-(--ink-2)">Planned inputs</h4>
        <table className="w-full">
          <thead>
            <tr className="text-left text-(--ink-2)">
              <th className="py-1.5 pr-3 font-semibold">Input</th>
              <th className="py-1.5 pr-3 font-semibold">Start</th>
              <th className="py-1.5 pr-3 font-semibold">End</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Man-hours</th>
              <th className="py-1.5 text-right font-semibold">Tasks</th>
            </tr>
          </thead>
          <tbody>
            {inputs.map((i) => (
              <tr key={i.id} className="border-t border-(--rule)">
                <td className="py-1.5 pr-3 text-(--ink)">
                  {i.kind}
                  {i.in_progress ? " (in progress)" : ""}
                </td>
                <td className="tabular py-1.5 pr-3 text-(--ink-2)">{formatDate(i.start)}</td>
                <td className="tabular py-1.5 pr-3 text-(--ink-2)">{formatDate(i.end)}</td>
                <td className="tabular py-1.5 pr-3 text-right text-(--ink)">{formatNumber(i.man_hours, 1)}</td>
                <td className="tabular py-1.5 text-right text-(--ink)">{i.task_ids.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link href="/plan" className="text-(--accent) hover:underline">
        Open the fleet action plan
      </Link>
    </div>
  );
}
