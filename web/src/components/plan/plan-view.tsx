"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  ChevronDown,
  ClipboardList,
  Gauge,
  Hammer,
  ListOrdered,
  Package,
  PlaneTakeoff,
  Wrench,
} from "lucide-react";
import { PriorityTag } from "@/components/domain/status-tag";
import { TailNumber } from "@/components/domain/tail-number";
import { PlanTimeline, dayOffset } from "@/components/plan/plan-timeline";
import { TypeFilter } from "@/components/plan/type-filter";
import { WorkloadChart, AvailabilityChart } from "@/components/plan/workload-chart";
import { formatDate, formatFH, formatNumber, formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PLAN_SLOTS, type PlanData, type PlanSlot, type PlanTask } from "@/lib/plan-types";

// Exported titles can carry ISO dates; show them as `16 Nov 2026`.
function readableDates(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, (iso) => formatDate(iso));
}

export function PlanView({ plan, types }: { plan: PlanData; types: { key: string; name: string }[] }) {
  const { summary } = plan;
  const taskById = useMemo(() => new Map(plan.tasks.map((t) => [t.id, t])), [plan.tasks]);
  const [typeFilter, setTypeFilter] = useState("All");
  const [slotFilter, setSlotFilter] = useState<PlanSlot | "All">("All");
  const typeName = useMemo(() => new Map(types.map((t) => [t.key, t.name])), [types]);
  const allTyped = typeFilter === "All";
  const typeTasks = useMemo(
    () => (allTyped ? plan.tasks : plan.tasks.filter((t) => t.type === typeFilter)),
    [plan.tasks, typeFilter, allTyped]
  );
  const typeTaskIds = useMemo(() => new Set(typeTasks.map((t) => t.id)), [typeTasks]);
  const typeAircraft = allTyped ? plan.aircraft : plan.aircraft.filter((a) => a.type === typeFilter);
  // Fleet-wide, the exported next-actions order; for one type, that type's
  // tasks in the plan's own execution sequence.
  const nextActions = allTyped
    ? plan.next_actions.map((id) => taskById.get(id)).filter((t): t is PlanTask => !!t)
    : [...typeTasks].sort((a, b) => a.sequence - b.sequence).slice(0, 10);
  const filtered = slotFilter === "All" ? typeTasks : typeTasks.filter((t) => t.slot === slotFilter);
  const slotCounts = (slot: PlanSlot) => typeTasks.filter((t) => t.slot === slot).length;
  // Per-type figures use the same definitions as the exported summary (which
  // they reproduce exactly when all types are selected).
  const figures = allTyped
    ? {
        tasks: summary.tasks_total,
        critical: summary.tasks_by_priority.Critical,
        high: summary.tasks_by_priority.High,
        aircraft: summary.aircraft_with_tasks,
        thisWeek: summary.tasks_this_week,
        beforeFlight: summary.slots["Before next flight"],
        manHours: summary.man_hours_total,
      }
    : {
        tasks: typeTasks.length,
        critical: typeTasks.filter((t) => t.priority === "Critical").length,
        high: typeTasks.filter((t) => t.priority === "High").length,
        aircraft: new Set(typeTasks.map((t) => t.tail).filter(Boolean)).size,
        thisWeek: typeTasks.filter((t) => dayOffset(t.planned_date, plan.as_of) < 7).length,
        beforeFlight: slotCounts("Before next flight"),
        manHours: typeTasks.reduce((sum, t) => sum + t.man_hours, 0),
      };
  const spares = allTyped ? plan.spares : plan.spares.filter((sp) => sp.task_ids.some((id) => typeTaskIds.has(id)));
  const horizonEnd = new Date(Date.parse(plan.as_of) + (plan.horizon_days - 1) * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title text-[28px] font-semibold text-(--ink)">Action plan</h1>
        <p className="max-w-[900px] text-[13px] text-(--ink-2)">
          What to do next, in what order and when: every open recommendation placed into the next maintenance
          opportunity that lands before its deadline, from {formatDate(plan.as_of)} to {formatDate(horizonEnd)}.
          Built by the engine from the recommendation queue, hard-time limits, the survival model and projected
          servicing dates.
        </p>
      </header>

      <TypeFilter
        types={types.map((t) => ({
          key: t.key,
          name: t.name,
          count: plan.tasks.filter((x) => x.type === t.key).length,
        }))}
        value={typeFilter}
        onChange={(k) => {
          setTypeFilter(k);
          setSlotFilter("All");
        }}
        allCount={plan.tasks.length}
        label="Tasks by aircraft type"
      />

      <section aria-label="Plan figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Figure
          icon={ClipboardList}
          label="Tasks planned"
          value={formatNumber(figures.tasks)}
          sub={`${figures.critical} critical, ${figures.high} high, on ${figures.aircraft} aircraft`}
        />
        <Figure
          icon={PlaneTakeoff}
          label="Due this week"
          value={formatNumber(figures.thisWeek)}
          sub={`${figures.beforeFlight} before next flight`}
        />
        <Figure
          icon={Hammer}
          label="Task man-hours"
          value={formatNumber(figures.manHours, 1)}
          sub="Recommended work from task cards, excluding servicing packages"
        />
        <Figure
          icon={Wrench}
          label="Peak week (man-hours, fleet)"
          value={formatNumber(summary.peak_week.man_hours, 1)}
          sub={`Week of ${formatDate(summary.peak_week.week_start)}, all types`}
        />
        <Figure
          icon={Gauge}
          label="Lowest weekly availability (fleet)"
          value={formatPct(summary.min_availability_pct, 1)}
          sub={`Week of ${formatDate(summary.min_availability_week)}, all types`}
        />
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="next-actions">
        <h2 id="next-actions" className="mb-3 flex items-center gap-1.5 text-[15px] font-semibold text-(--ink)">
          <ListOrdered className="size-[15px] text-(--ink-2)" strokeWidth={1.75} aria-hidden />
          Next actions
        </h2>
        <ol className="flex flex-col gap-2">
          {nextActions.map((t) => (
            <NextActionItem key={t.id} task={t} typeLabel={t.type ? typeName.get(t.type) ?? t.type : null} />
          ))}
          {nextActions.length === 0 && (
            <li className="text-[13px] text-(--ink-2)">No planned tasks for this aircraft type. Choose another type.</li>
          )}
        </ol>
      </section>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <PlanTimeline
          aircraft={typeAircraft}
          tasks={plan.tasks}
          asOf={plan.as_of}
          horizonDays={plan.horizon_days}
          typeGroups={types}
        />
      </section>

      {!allTyped && (
        <p className="-mb-3 text-[12px] text-(--ink-2)">
          Weekly workload and availability are computed by the planner for the whole fleet (all {plan.aircraft.length}{" "}
          aircraft, all types).
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <WorkloadChart weekly={plan.weekly} />
        </section>
        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <AvailabilityChart weekly={plan.weekly} fleetSize={plan.aircraft.length} />
        </section>
      </div>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="all-tasks">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="all-tasks" className="flex items-center gap-1.5 text-[15px] font-semibold text-(--ink)">
            <CalendarClock className="size-[15px] text-(--ink-2)" strokeWidth={1.75} aria-hidden />
            All planned tasks
          </h2>
          <div role="group" aria-label="Filter by slot" className="flex flex-wrap gap-1 text-[12px]">
            {(["All", ...PLAN_SLOTS] as const).map((s) => {
              const count = s === "All" ? typeTasks.length : slotCounts(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={slotFilter === s}
                  onClick={() => setSlotFilter(s)}
                  className={cn(
                    "rounded-[6px] border px-2 py-1 transition-colors",
                    slotFilter === s
                      ? "border-(--accent) bg-(--accent)/10 text-(--accent)"
                      : "border-(--rule) text-(--ink-2) hover:text-(--ink)"
                  )}
                >
                  {s} ({count})
                </button>
              );
            })}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="py-2 pr-3 font-semibold">Order</th>
                <th className="py-2 pr-3 font-semibold">Priority</th>
                <th className="py-2 pr-3 font-semibold">Aircraft</th>
                <th className="py-2 pr-3 font-semibold">Task and task card</th>
                <th className="py-2 pr-3 font-semibold">Slot</th>
                <th className="py-2 pr-3 font-semibold">Planned</th>
                <th className="py-2 pr-3 font-semibold">Deadline</th>
                <th className="py-2 pr-3 text-right font-semibold">Man-hours</th>
                <th className="py-2 text-right font-semibold">Risk if slot missed</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="border-t border-(--rule) align-top">
                  <td className="tabular py-2 pr-3 text-(--ink-2)">{t.sequence}</td>
                  <td className="py-2 pr-3">
                    <PriorityTag priority={t.priority} />
                  </td>
                  <td className="py-2 pr-3">
                    {t.tail ? (
                      <Link href={`/aircraft/${t.tail}`} className="hover:text-(--accent)">
                        <TailNumber tail={t.tail} className="text-[12px]" />
                      </Link>
                    ) : (
                      "Fleet"
                    )}
                  </td>
                  <td className="max-w-[420px] py-2 pr-3 text-(--ink)">
                    {readableDates(t.title)}
                    <span className="block text-[11px] text-(--ink-2)">
                      {[t.type ? typeName.get(t.type) ?? t.type : null, t.task_card].filter(Boolean).join(", ")}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-(--ink-2)">{t.slot}</td>
                  <td className="tabular whitespace-nowrap py-2 pr-3 text-(--ink)">
                    {formatDate(t.planned_date)}
                    {!t.within_horizon && <span className="block text-[11px] text-(--ink-3)">After the 90 days</span>}
                  </td>
                  <td className="tabular whitespace-nowrap py-2 pr-3 text-(--ink-2)">
                    <DeadlineText task={t} />
                  </td>
                  <td className="tabular py-2 pr-3 text-right text-(--ink)">{formatNumber(t.man_hours, 1)}</td>
                  <td className="tabular py-2 text-right text-(--ink)">
                    {t.risk_if_deferred ? formatPct(t.risk_if_deferred.probability * 100) : "Not model based"}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-(--ink-2)">
                    No tasks in this slot for this aircraft type. Choose another filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="spares">
          <h2 id="spares" className="mb-3 flex items-center gap-1.5 text-[15px] font-semibold text-(--ink)">
            <Package className="size-[15px] text-(--ink-2)" strokeWidth={1.75} aria-hidden />
            Spares needed
          </h2>
          {spares.length === 0 ? (
            <p className="text-[13px] text-(--ink-2)">No replacement tasks in the plan, so no spares are drawn.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-(--ink-2)">
                  <th className="py-2 pr-3 font-semibold">Part number</th>
                  <th className="py-2 pr-3 font-semibold">Component</th>
                  <th className="py-2 pr-3 text-right font-semibold">Units</th>
                  <th className="py-2 font-semibold">First needed</th>
                </tr>
              </thead>
              <tbody>
                {spares.map((s) => (
                  <tr key={s.part_number} className="border-t border-(--rule)">
                    <td className="tabular py-2 pr-3 text-(--ink)">{s.part_number}</td>
                    <td className="py-2 pr-3 text-(--ink)">{s.component}</td>
                    <td className="tabular py-2 pr-3 text-right text-(--ink)">{formatNumber(s.units_required)}</td>
                    <td className="tabular py-2 text-(--ink-2)">{formatDate(s.first_needed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="by-aircraft">
          <h2 id="by-aircraft" className="mb-3 text-[15px] font-semibold text-(--ink)">
            Outlook by aircraft
          </h2>
          <ul className="flex max-h-[340px] flex-col gap-2 overflow-y-auto pr-1">
            {typeAircraft.map((a) => (
              <li key={a.tail} className="flex gap-3 border-t border-(--rule) pt-2 first:border-0 first:pt-0">
                <Link href={`/aircraft/${a.tail}`} className="shrink-0 hover:text-(--accent)">
                  <TailNumber tail={a.tail} className="text-[13px]" />
                </Link>
                <span className="text-[12px] text-(--ink-2)">{a.outlook}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4" aria-labelledby="method">
        <h2 id="method" className="mb-2 text-[15px] font-semibold text-(--ink)">
          How this plan is built
        </h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-(--ink-2)">
          {plan.method.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-(--ink-3)">
          A planning aid computed on synthetic data. Every task still goes through review and approval on the
          recommendations screen before a work order is raised.
        </p>
      </section>
    </div>
  );
}

function DeadlineText({ task }: { task: PlanTask }) {
  const { deadline } = task;
  const parts: string[] = [];
  if (deadline.date) parts.push(formatDate(deadline.date));
  if (deadline.fh_remaining !== null) parts.push(formatFH(deadline.fh_remaining, 1));
  return (
    <>
      {parts.join(", ") || "None"}
      <span className="block text-[11px] text-(--ink-3)">{deadline.governing} governs</span>
    </>
  );
}

function NextActionItem({ task, typeLabel }: { task: PlanTask; typeLabel: string | null }) {
  const [open, setOpen] = useState(false);
  const panelId = `rationale-${task.id}`;
  return (
    <li className="rounded-[6px] border border-(--rule) p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="tabular w-6 shrink-0 pt-[2px] text-[13px] font-semibold text-(--ink-2)">{task.sequence}</span>
        <PriorityTag priority={task.priority} className="shrink-0" />
        {task.tail && (
          <Link href={`/aircraft/${task.tail}`} className="shrink-0 pt-[1px] hover:text-(--accent)">
            <TailNumber tail={task.tail} className="text-[13px]" />
          </Link>
        )}
        <span className="min-w-0 flex-1 basis-[320px] text-[13px] text-(--ink)">{readableDates(task.title)}</span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[12px] text-(--accent) hover:bg-(--paper)"
        >
          Why
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 pl-9 text-[12px]">
        <Meta label="Planned" value={formatDate(task.planned_date)} />
        <Meta label="Slot" value={task.slot} />
        <Meta label="Man-hours" value={formatNumber(task.man_hours, 1)} />
        {task.task_card && <Meta label="Task card" value={task.task_card} />}
        {typeLabel && <Meta label="Type" value={typeLabel} />}
        {task.deadline.date && <Meta label="Deadline" value={formatDate(task.deadline.date)} />}
        {task.risk_if_deferred && (
          <Meta label="Risk if slot missed" value={formatPct(task.risk_if_deferred.probability * 100)} />
        )}
        {task.serial && (
          <div className="flex gap-1">
            <dt className="text-(--ink-3)">Unit</dt>
            <dd>
              <Link href={`/components/${task.serial}`} className="text-(--accent) hover:underline">
                {task.serial}
              </Link>
            </dd>
          </div>
        )}
      </dl>
      {open && (
        <p id={panelId} className="mt-2 pl-9 text-[12px] leading-relaxed text-(--ink-2)">
          {readableDates(task.rationale)} Source: {task.rec_id}.
        </p>
      )}
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt className="text-(--ink-3)">{label}</dt>
      <dd className="tabular text-(--ink)">{value}</dd>
    </div>
  );
}

function Figure({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string;
  sub?: string;
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
      <span className="figure-display text-[28px] font-semibold leading-none text-(--ink) tabular">{value}</span>
      {sub && <span className="text-[11px] text-(--ink-3)">{sub}</span>}
    </div>
  );
}
