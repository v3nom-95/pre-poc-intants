"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { scaleLinear } from "d3-scale";
import { ChartFrame, ChartLegend } from "@/components/charts/chart-frame";
import { ChartTable } from "@/components/charts/chart-table";
import { PRIORITY_VAR } from "@/lib/domain-types";
import { formatDate, formatNumber } from "@/lib/format";
import type { PlanAircraft, PlanInput, PlanInputKind, PlanTask } from "@/lib/plan-types";

const DAY_MS = 86_400_000;

export function dayOffset(iso: string, asOf: string): number {
  return Math.round((Date.parse(iso) - Date.parse(asOf)) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

export const INPUT_STYLE: Record<PlanInputKind, { color: string; opacity: number }> = {
  "Phase inspection": { color: "var(--chart-cat-1)", opacity: 0.55 },
  "Periodic servicing": { color: "var(--chart-cat-1)", opacity: 0.25 },
  "Dedicated input": { color: "var(--chart-cat-2)", opacity: 0.55 },
  "Before next flight input": { color: "var(--chart-cat-2)", opacity: 0.85 },
};

const ROW_H = 24;
const GROUP_H = 22;
const LABEL_W = 64;
const WIDTH = 1000;
const TOP = 22;

type Hover =
  | { type: "input"; tail: string; input: PlanInput; x: number; y: number }
  | { type: "task"; task: PlanTask; x: number; y: number };

type Row = { kind: "group"; label: string; y: number } | { kind: "aircraft"; a: PlanAircraft; y: number };

export function PlanTimeline({
  aircraft,
  tasks,
  asOf,
  horizonDays,
  typeGroups,
}: {
  aircraft: PlanAircraft[];
  tasks: PlanTask[];
  asOf: string;
  horizonDays: number;
  /** When given, rows are grouped under a header per aircraft type, in this order. */
  typeGroups?: { key: string; name: string }[];
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const days = Math.ceil(horizonDays / 7) * 7;
  const innerW = WIDTH - LABEL_W - 12;
  const typeName = useMemo(() => new Map((typeGroups ?? []).map((g) => [g.key, g.name])), [typeGroups]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = TOP;
    const groups = typeGroups?.length ? typeGroups : [{ key: "__all", name: "" }];
    for (const g of groups) {
      const members = g.key === "__all" ? aircraft : aircraft.filter((a) => a.type === g.key);
      if (!members.length) continue;
      if (g.key !== "__all") {
        out.push({ kind: "group", label: `${g.name} (${members.length})`, y });
        y += GROUP_H;
      }
      for (const a of members) {
        out.push({ kind: "aircraft", a, y });
        y += ROW_H;
      }
    }
    return { list: out, bottom: y };
  }, [aircraft, typeGroups]);
  const height = rows.bottom + 8;
  const x = useMemo(() => scaleLinear().domain([0, days]).range([0, innerW]), [days, innerW]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const ticks = Array.from({ length: Math.floor(days / 14) + 1 }, (_, i) => i * 14);

  const tableRows = aircraft.flatMap((a) =>
    a.inputs
      .filter((i) => dayOffset(i.start, asOf) < days)
      .map((i) => [
        a.tail,
        typeName.get(a.type ?? "") ?? a.type ?? "",
        i.kind + (i.in_progress ? " (in progress)" : ""),
        formatDate(i.start),
        formatDate(i.end),
        `${formatNumber(i.man_hours, 1)} man-hours`,
        i.task_ids.length ? i.task_ids.map((id) => taskById.get(id)?.title ?? id).join("; ") : "Scheduled package only",
      ])
  );

  const legend = (
    <ChartLegend
      items={[
        { label: "Phase inspection", color: "color-mix(in srgb, var(--chart-cat-1) 55%, transparent)" },
        { label: "Periodic servicing", color: "color-mix(in srgb, var(--chart-cat-1) 25%, transparent)" },
        { label: "Dedicated or before next flight input", color: "var(--chart-cat-2)" },
      ]}
    />
  );

  const chart = (
    <div className="relative w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        role="group"
        aria-label={`Planned maintenance inputs and tasks per aircraft over the next ${days} days`}
        style={{ minWidth: 720 }}
        onMouseLeave={() => setHover(null)}
      >
        <g transform={`translate(${LABEL_W},0)`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height - 8} stroke="var(--rule)" strokeWidth={1} />
              <text
                x={x(t)}
                y={TOP - 9}
                fontSize={11}
                fill="var(--ink-2)"
                textAnchor={t === 0 ? "start" : t === days ? "end" : "middle"}
                className="tabular"
              >
                {formatDate(addDays(asOf, t))}
              </text>
            </g>
          ))}
        </g>
        {rows.list.map((r) => {
          if (r.kind === "group") {
            return (
              <g key={`group-${r.label}`}>
                <text x={4} y={r.y + GROUP_H - 7} fontSize={12} fontWeight={600} fill="var(--ink-2)">
                  {r.label}
                </text>
                <line x1={0} x2={WIDTH} y1={r.y + GROUP_H} y2={r.y + GROUP_H} stroke="var(--rule)" strokeWidth={1} />
              </g>
            );
          }
          const { a, y } = r;
          const acTasks = a.task_ids.map((id) => taskById.get(id)).filter((t): t is PlanTask => !!t);
          return (
            <g key={a.tail}>
              <line x1={0} x2={WIDTH} y1={y + ROW_H} y2={y + ROW_H} stroke="var(--rule)" strokeWidth={0.5} />
              <text x={4} y={y + ROW_H / 2} dy="0.32em" fontSize={12} fontWeight={700} fill="var(--ink)" className="tail-number">
                {a.tail}
              </text>
              <g transform={`translate(${LABEL_W},0)`}>
                {a.inputs.map((inp) => {
                  const s = Math.max(0, dayOffset(inp.start, asOf));
                  if (s >= days) return null;
                  const e = Math.min(days, dayOffset(inp.end, asOf) + 1);
                  const st = INPUT_STYLE[inp.kind];
                  const label = `${a.tail} ${inp.kind.toLowerCase()}, ${formatDate(inp.start)} to ${formatDate(inp.end)}, ${formatNumber(inp.man_hours, 1)} man-hours`;
                  return (
                    <rect
                      key={inp.id}
                      x={x(s)}
                      y={y + 4}
                      width={Math.max(3, x(e) - x(s) - 1)}
                      height={ROW_H - 8}
                      rx={3}
                      fill={st.color}
                      fillOpacity={st.opacity}
                      tabIndex={0}
                      role="button"
                      aria-label={label}
                      className="cursor-default outline-none focus-visible:stroke-(--accent) focus-visible:stroke-2"
                      onMouseEnter={() => setHover({ type: "input", tail: a.tail, input: inp, x: LABEL_W + x(s), y })}
                      onFocus={() => setHover({ type: "input", tail: a.tail, input: inp, x: LABEL_W + x(s), y })}
                      onBlur={() => setHover(null)}
                    />
                  );
                })}
                {acTasks.map((t, k) => {
                  const d = dayOffset(t.planned_date, asOf);
                  if (d >= days || t.slot === "Fleet tasking review") return null;
                  const sameDay = acTasks.filter((o, j) => j < k && o.planned_date === t.planned_date).length;
                  const cx = x(d) + 5 + sameDay * 7;
                  return (
                    <circle
                      key={t.id}
                      cx={cx}
                      cy={y + ROW_H / 2}
                      r={4}
                      fill={PRIORITY_VAR[t.priority]}
                      stroke="var(--sheet)"
                      strokeWidth={1.5}
                      tabIndex={0}
                      role="button"
                      aria-label={`${t.id} ${t.priority}: ${t.title}, planned ${formatDate(t.planned_date)}`}
                      className="outline-none focus-visible:stroke-(--accent)"
                      onMouseEnter={() => setHover({ type: "task", task: t, x: LABEL_W + cx, y })}
                      onFocus={() => setHover({ type: "task", task: t, x: LABEL_W + cx, y })}
                      onBlur={() => setHover(null)}
                    />
                  );
                })}
              </g>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 w-[300px] rounded-[6px] border border-(--rule) bg-(--sheet) p-2.5 text-[12px] shadow-md"
          style={{
            left: `${Math.min((hover.x / WIDTH) * 100, 68)}%`,
            top: hover.y + ROW_H + 6,
          }}
        >
          {hover.type === "input" ? (
            <>
              <div className="font-semibold text-(--ink)">
                {hover.tail}: {hover.input.kind}
                {hover.input.in_progress ? " (in progress)" : ""}
              </div>
              <div className="tabular text-(--ink-2)">
                {formatDate(hover.input.start)} to {formatDate(hover.input.end)}, {formatNumber(hover.input.man_hours, 1)} man-hours
              </div>
              {hover.input.task_ids.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-(--ink)">
                  {hover.input.task_ids.map((id) => (
                    <li key={id}>{taskById.get(id)?.title ?? id}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="font-semibold text-(--ink)">
                {hover.task.id}, {hover.task.priority}
              </div>
              <div className="text-(--ink)">{hover.task.title}</div>
              <div className="tabular text-(--ink-2)">
                {hover.task.slot}, planned {formatDate(hover.task.planned_date)}, {formatNumber(hover.task.man_hours, 1)} man-hours
              </div>
            </>
          )}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-(--ink-2)">
          Bars are planned inputs, dots are tasks colored by priority.{" "}
          <Link href="/recommendations" className="text-(--accent) underline underline-offset-2">
            Review the recommendations
          </Link>{" "}
          behind each task.
        </p>
        <ChartLegend
          items={(["Critical", "High", "Medium", "Low"] as const).map((p) => ({ label: p, color: PRIORITY_VAR[p] }))}
        />
      </div>
    </div>
  );

  return (
    <ChartFrame
      title={`Planned inputs, next ${days} days`}
      legend={legend}
      chart={chart}
      table={
        <ChartTable columns={["Aircraft", "Type", "Input", "Start", "End", "Man-hours", "Tasks"]} rows={tableRows} />
      }
    />
  );
}
