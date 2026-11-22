// Template-based answer composers. Every number is computed here from the
// loaded records (corpus facts or sortie tables); nothing is invented. When a
// record is missing the answer says so.
import { formatDate, formatNumber } from "@/lib/format";
import { isoAdd, type Entities } from "./entities";
import { TYPE_PLURAL, type KnowledgeBase } from "./knowledge";
import type {
  AircraftFacts,
  Answer,
  EngineFacts,
  FleetTypeFacts,
  GroundRunFacts,
  TaskCardFacts,
  TypeKey,
  AnswerTable,
  ComponentFacts,
  EventFacts,
  KDoc,
  KpiFacts,
  MaintFacts,
  PartFacts,
  PatternFacts,
  PlanAircraftFacts,
  PlanSummaryFacts,
  PlanTaskFacts,
  RecFacts,
  SnagFacts,
  Sortie,
  Source,
} from "./types";

export interface Ctx {
  kb: KnowledgeBase;
  e: Entities;
  q: string; // lowercased question
  question: string;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export const fd = (iso?: string | null) => (iso ? formatDate(iso.slice(0, 10)) : "not set");
export const fn = (n: number | null | undefined, d = 0) => (n === null || n === undefined ? "not available" : formatNumber(n, d));
export const pct = (p: number | null | undefined, d = 0) => (p === null || p === undefined ? "not available" : `${formatNumber(p * 100, d)}%`);
export const humanize = (s: string) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => formatDate(m));
const plural = (n: number, word: string, pl?: string) => `${formatNumber(n, 0)} ${n === 1 ? word : (pl ?? `${word}s`)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Lowercase a name for use mid-sentence, keeping leading acronyms (HPT, ECS). */
export const lcName = (s: string) => (/^[A-Z]{2,}/.test(s) ? s : lower(s));
const inWindow = (iso: string, w?: { from: string; to: string }) => !w || (iso >= w.from && iso <= w.to);
const PRI: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const posLabel = (p: string | null | undefined, zone?: string | null) =>
  p === "L" ? "left" : p === "R" ? "right" : zone?.startsWith("engine-") ? `engine ${zone.slice("engine-".length)}` : "";
/** Tyres and brakes of every type are routine wear consumables. */
const isConsumable = (key?: string | null) => !!key && /(^|-)(TYRE|BRAKE)$/.test(key);

function sources(docs: (KDoc | undefined)[], extra: Source[] = []): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const s of [...extra, ...docs.filter((d): d is KDoc => !!d).map((d) => ({ title: d.title, href: d.href }))]) {
    const k = `${s.href}|${s.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

/** Aircraft types in scope: those of the named tails, else the named types. */
function scopeTypes(ctx: Ctx): TypeKey[] {
  if (ctx.e.tails.length) return Array.from(new Set(ctx.e.tails.map((t) => ctx.kb.typeOfTail.get(t)).filter((t): t is TypeKey => !!t)));
  return ctx.e.types;
}

/** Tails in scope: the named tails, else the tails of the named types, else
 * null for the whole fleet. */
function scopeTails(ctx: Ctx): string[] | null {
  if (ctx.e.tails.length) return ctx.e.tails;
  if (ctx.e.types.length) return ctx.kb.tailsOf(ctx.e.types);
  return null;
}

function inScope(ctx: Ctx, tail: string | null | undefined): boolean {
  const s = scopeTails(ctx);
  return !s || (!!tail && s.includes(tail));
}

function typesLabel(types: TypeKey[]): string {
  return types.map((t) => TYPE_PLURAL[t]).join(" and ");
}

/** Component keys named in the question, narrowed to the types in scope. */
function scopedKeys(ctx: Ctx): string[] {
  const types = scopeTypes(ctx);
  if (!types.length) return ctx.e.componentKeys;
  const narrowed = ctx.e.componentKeys.filter((k) => {
    const t = ctx.kb.corpus.components.find((c) => c.key === k)?.type;
    return !t || types.includes(t);
  });
  return narrowed.length ? narrowed : ctx.e.componentKeys;
}

function pnFilter(ctx: Ctx): Set<string> | null {
  const pns = new Set(ctx.e.partNumbers);
  for (const k of scopedKeys(ctx)) {
    const c = ctx.kb.corpus.components.find((x) => x.key === k);
    if (c) pns.add(c.part_number);
  }
  return pns.size ? pns : null;
}

function componentName(ctx: Ctx, key: string): string {
  return ctx.kb.corpus.components.find((c) => c.key === key)?.name ?? key;
}

function scopeLabel(ctx: Ctx): string {
  const bits: string[] = [];
  if (ctx.e.tails.length) bits.push(`on ${ctx.e.tails.join(" and ")}`);
  else if (ctx.e.types.length) bits.push(`for the ${typesLabel(ctx.e.types)}`);
  const names = Array.from(new Set(scopedKeys(ctx).map((k) => lcName(componentName(ctx, k)))));
  if (names.length) bits.push(`for the ${names.join(" and ")}`);
  if (ctx.e.atas.length) bits.push(`in ATA ${ctx.e.atas.join(", ")}`);
  return bits.length ? ` ${bits.join(" ")}` : "";
}

/** "EGT" or "ITT" for follow-up wording on a tail. */
function metricWord(ctx: Ctx, tail: string): string {
  return ctx.kb.metricOf(tail).split(" ")[0];
}

function dueText(r: RecFacts): string {
  const bits: string[] = [];
  if (r.due?.date) bits.push(`due ${fd(r.due.date)}`);
  if (r.due?.fh_remaining !== null && r.due?.fh_remaining !== undefined) bits.push(`${fn(r.due.fh_remaining, 1)} FH remaining`);
  if (r.due?.governing) bits.push(r.due.governing === "Model" ? "model based" : `${lcName(r.due.governing)} limit governs`);
  return bits.join(", ");
}

function sortRecs(recs: RecFacts[]): RecFacts[] {
  return [...recs].sort(
    (a, b) => PRI[a.priority] - PRI[b.priority] || (a.due?.date ?? "9999").localeCompare(b.due?.date ?? "9999") || a.id.localeCompare(b.id)
  );
}

function recTable(recs: RecFacts[], withStatus = false): AnswerTable {
  return {
    columns: ["ID", "Priority", "Aircraft", "Recommendation", "Due", ...(withStatus ? ["Status"] : [])],
    rows: recs.map((r) => [r.id, r.priority, r.tail ?? "Fleet", humanize(r.title), dueText(r), ...(withStatus ? [r.status] : [])]),
    links: recs.map(() => "/recommendations"),
  };
}

function recDocs(ctx: Ctx): KDoc<RecFacts>[] {
  return ctx.kb.docs<RecFacts>("recommendation");
}

function openRecs(ctx: Ctx): RecFacts[] {
  return recDocs(ctx).map((d) => d.facts!).filter((r) => r.is_open);
}

function breakdown(counts: Record<string, number>, order = ["Critical", "High", "Medium", "Low"]): string {
  return order.map((k) => `${counts[k] ?? 0} ${k.toLowerCase()}`).join(", ");
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

function tailFollowups(ctx: Ctx, tail: string, skip: string): string[] {
  const all = [
    `What should we do next on ${tail}?`,
    `Show open snags on ${tail}`,
    `How many sorties did ${tail} fly last month?`,
    `Show the ${metricWord(ctx, tail)} trend for ${tail}`,
    `What is the fatigue projection for ${tail}?`,
    `Which components on ${tail} have the highest risk?`,
    `What hard-time items are due on ${tail}?`,
  ];
  return all.filter((f) => !f.toLowerCase().includes(skip)).slice(0, 3);
}

function limitRows(table: AnswerTable, max = 25): { table: AnswerTable; note: string } {
  if (table.rows.length <= max) return { table, note: "" };
  return {
    table: { ...table, rows: table.rows.slice(0, max), links: table.links?.slice(0, max) },
    note: ` Showing the first ${max} of ${formatNumber(table.rows.length, 0)}.`,
  };
}

// ---------------------------------------------------------------------------
// Help and glossary
// ---------------------------------------------------------------------------
export const EXAMPLE_QUESTIONS = [
  "What should we do next on FX-307?",
  "What is wrong with TX-404?",
  "Show the ITT trend for CX-502 engine 3",
  "How many air drop sorties did the airlifters fly in October 2026?",
  "Compare utilisation by aircraft type",
  "Which aircraft are due for hard-time items in the next 30 days?",
  "Why is lot L-2207 flagged?",
  "What task card covers the cabin outflow valve?",
];

export function composeHelp(): Answer {
  return {
    intent: "help",
    text:
      "I answer questions from PRE's own records, fully offline: no network and no language model. The fleet has three types: multirole fighters (FX-301 to FX-316), twin-engine transports (TX-401 to TX-408) and four-engine airlifters (CX-501 to CX-506). Ask about an aircraft or a whole type, a component serial or part number, snags and repeat snags, removals and installation history, maintenance records, sorties and flight hours, engine operating hours, ground runs and APU hours, engine EGT and ITT trends per engine, fatigue, reliability and manufacturing lots, task cards, recommendations, the action plan, data quality, the models, or any glossary term. Every answer is computed from the pipeline output and links to its source records.",
    sources: [],
    followups: EXAMPLE_QUESTIONS.slice(0, 4),
  };
}

export function composeGlossary(ctx: Ctx): Answer {
  const d = ctx.kb.docs<{ term: string; meaning: string }>("glossary").find((g) => g.facts!.term === ctx.e.glossaryTerm);
  if (!d) return composeHelp();
  return {
    intent: "glossary",
    text: `${d.facts!.term}: ${d.facts!.meaning}`,
    sources: [{ title: `Glossary: ${d.facts!.term}`, href: "#glossary" }],
    followups: ["What is MTBF / MTBUR?", "What is a repeat snag?", "Which part has the highest NFF rate?"].filter(
      (f) => !f.toLowerCase().includes(d.facts!.term.toLowerCase())
    ),
  };
}

// ---------------------------------------------------------------------------
// Aircraft and component profiles
// ---------------------------------------------------------------------------
function nextHtItem(ctx: Ctx, tail: string): ComponentFacts | undefined {
  return ctx.kb
    .facts<ComponentFacts>("component")
    .filter((c) => c.tail === tail && c.ht)
    .sort((a, b) => (a.ht!.days_to_due ?? 1e9) - (b.ht!.days_to_due ?? 1e9))[0];
}

export function composeAircraft(ctx: Ctx, tail: string): Answer {
  const doc = ctx.kb.aircraft(tail);
  if (!doc) return notFound(ctx, `aircraft ${tail}`);
  const a = doc.facts!;
  const recs = sortRecs(openRecs(ctx).filter((r) => r.tail === tail));
  const bullets: string[] = [];
  const multi = (a.engines ?? []).length > 1;
  for (const en of a.engines ?? []) {
    const t = en.trend;
    const name = multi ? `Engine ${en.position} ${en.serial}` : `Engine ${en.serial}`;
    bullets.push(
      `${name}: ${fn(en.efh, 1)} EFH, ${fn(en.operating_hours, 1)} operating hours` +
        (t && t.current_margin_c !== null
          ? `, ${en.metric} ${fn(t.current_margin_c, 1)} °C, trend ${fn(t.slope_c_per_efh, 3)} °C per EFH` +
            (t.projected_efh_to_limit !== null ? `, projected to reach ${fn(t.limit_c)} °C in ${fn(t.projected_efh_to_limit, 1)} EFH` : "") +
            (t.flagged ? " (flagged)." : ".")
          : `, no ${en.metric} trend yet.`)
    );
  }
  if (a.apu_hours !== null && a.apu_hours !== undefined) bullets.push(`APU: ${fn(a.apu_hours, 1)} APU hours since ${fd(a.operating_hours?.window_start)}.`);
  if (a.fatigue?.projected_fi100_date) {
    bullets.push(
      `Fatigue index ${fn(a.fi, 1)}, projected to reach 100 on ${fd(a.fatigue.projected_fi100_date)}` +
        (a.fatigue.flagged_before_withdrawal ? `, before the planned withdrawal in ${a.planned_withdrawal_year}.` : ".")
    );
  }
  const ht = nextHtItem(ctx, tail);
  if (ht?.ht) {
    bullets.push(`Next hard-time item: ${ht.component} ${ht.serial}, due ${fd(ht.ht.due_date)} (${lcName(ht.ht.governing)} limit governs).`);
  }
  const text =
    `${tail} (${lower(a.type_name ?? "aircraft")}, ${a.base}) status: ${lower(a.status)}. Airframe ${fn(a.airframe_fh, 1)} FH of ${fn(a.ttl_fh)} FH TTL, fatigue index ${fn(a.fi, 1)}, ` +
    `${fn(a.landings)} landings recorded since the data window opened. In the last 12 months it flew ${fn(a.fh_12mo, 1)} FH over ${plural(a.sorties_12mo, "sortie")}. ` +
    `${plural(a.open_recs, "open recommendation")} (${breakdown(a.open_recs_by_priority)}) and ${plural(a.open_snags, "open snag")}.`;
  return {
    intent: "aircraft",
    text,
    bullets,
    table: recs.length ? recTable(recs) : undefined,
    sources: sources([doc, ...recs.slice(0, 3).map((r) => ctx.kb.byId.get(`rec:${r.id}`))]),
    followups: tailFollowups(ctx, tail, "zzz"),
    context: { tail },
  };
}

export function composeComponent(ctx: Ctx, serial: string): Answer {
  const doc = ctx.kb.component(serial);
  const events = ctx.kb
    .docs<EventFacts>("event")
    .filter((d) => d.facts!.serial === serial)
    .sort((a, b) => a.facts!.date.localeCompare(b.facts!.date) || a.facts!.event_id.localeCompare(b.facts!.event_id));
  const historyTable: AnswerTable = {
    columns: ["Date", "Event", "Aircraft", "Position", "Reason", "Unit time (FH)"],
    rows: events.map((d) => [fd(d.facts!.date), d.facts!.event_type, d.facts!.tail, d.facts!.position, d.facts!.reason ?? "", fn(d.facts!.hours_at_event, 1)]),
    links: events.map((d) => `/aircraft/${d.facts!.tail}`),
  };
  if (!doc) {
    if (!events.length) return notFound(ctx, `serial ${serial}`);
    const last = events[events.length - 1].facts!;
    return {
      intent: "component",
      text: `${last.component} ${serial} is not installed on any aircraft at the as-of date. Its last recorded event was ${lower(last.event_type)} on ${last.tail} on ${fd(last.date)}${last.reason ? ` (${last.reason})` : ""}. It has ${plural(events.length, "recorded event")}.`,
      table: historyTable,
      sources: sources(events.slice(-3)),
      followups: [`Show removals of the ${lcName(last.component)}`, `What is the MTBF of the ${lcName(last.component)}?`],
      context: { serial, partNumber: last.part_number },
    };
  }
  const c = doc.facts!;
  const pos = posLabel(c.position, c.zone);
  const unit = c.exposure_unit ?? "FH";
  let text =
    `${c.component} ${serial}${pos ? ` (${pos})` : ""}, part number ${c.part_number}, is installed on ${c.tail} since ${fd(c.install_date)}. ` +
    `Concept ${c.concept}, criticality ${c.criticality === "flight_safety" ? "flight safety" : "mission"}${c.lot ? `, manufacturing lot ${c.lot}` : ""}` +
    `${c.task_card ? `, task card ${c.task_card}` : ""}.`;
  const bullets: string[] = [];
  if (c.ht) {
    text += ` Hard-time item: ${lcName(c.ht.governing)} limit governs, ${fn(c.ht.remaining, c.ht.remaining_unit === "months" ? 1 : 0)} ${c.ht.remaining_unit} remaining, projected due ${fd(c.ht.due_date)} (${plural(Math.round(c.ht.days_to_due ?? 0), "day")}).`;
    for (const l of c.ht.all_limits) {
      const unit = { Calendar: "months", Landings: "landings", Cycles: "LCF cycles", EFH: "EFH", FH: "FH" }[l.governing] ?? "";
      bullets.push(`${l.governing} limit: ${fn(l.remaining, l.governing === "Calendar" ? 1 : 0)} ${unit} remaining, about ${plural(Math.round(l.days_to_due ?? 0), "day")} at current utilisation.`);
    }
  }
  if (c.risk) {
    text +=
      ` Survival model: ${fn(c.risk.fh_exposure, 1)} ${unit} since install, ${pct(c.risk.prob_fail_before_next_phase)} probability of failure before the next phase inspection, ` +
      `${fn(c.risk.fh_to_tau)} ${unit} until the ${pct(c.risk.tau)} risk threshold (80% interval ${fn(c.risk.fh_to_tau_p10)} to ${fn(c.risk.fh_to_tau_p90)} ${unit}).`;
    if (c.risk.explanation) bullets.push(`Drivers: ${c.risk.explanation}.`);
  }
  const recs = sortRecs(openRecs(ctx).filter((r) => r.serial === serial));
  for (const r of recs) bullets.push(`Open recommendation ${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}.`);
  return {
    intent: "component",
    text,
    bullets,
    table: historyTable,
    sources: sources([doc, ...recs.map((r) => ctx.kb.byId.get(`rec:${r.id}`)), ctx.kb.byId.get(`part:${c.part_number}`)]),
    followups: [`What should we do next on ${c.tail}?`, `What is the MTBF of the ${lcName(c.component)}?`, `Show removals of the ${lcName(c.component)} on ${c.tail}`],
    context: { serial, tail: c.tail, partNumber: c.part_number },
  };
}

// ---------------------------------------------------------------------------
// Next action, plan and recommendations
// ---------------------------------------------------------------------------
function planTasks(ctx: Ctx): PlanTaskFacts[] {
  return ctx.kb.facts<PlanTaskFacts>("plan_task");
}

function taskSort(a: PlanTaskFacts, b: PlanTaskFacts): number {
  return (
    (a.planned_date ?? "9999").localeCompare(b.planned_date ?? "9999") ||
    (a.sequence ?? 1e9) - (b.sequence ?? 1e9) ||
    (PRI[a.priority ?? "Low"] ?? 9) - (PRI[b.priority ?? "Low"] ?? 9) ||
    a.id.localeCompare(b.id)
  );
}

function taskTable(tasks: PlanTaskFacts[]): AnswerTable {
  return {
    columns: ["Task", "Priority", "Aircraft", "Action", "Planned", "Slot", "Deadline"],
    rows: tasks.map((t) => [
      t.id,
      t.priority ?? "",
      t.tail ?? "Fleet",
      humanize(t.title ?? t.action ?? ""),
      fd(t.planned_date),
      t.slot ?? "",
      t.deadline?.date ? fd(t.deadline.date) : t.deadline?.fh_remaining !== null && t.deadline?.fh_remaining !== undefined ? `${fn(t.deadline.fh_remaining, 1)} FH` : "",
    ]),
    links: tasks.map(() => "/plan"),
  };
}

function describeTask(t: PlanTaskFacts): string {
  const bits = [`${humanize(t.title ?? t.action ?? t.id)}`];
  if (t.planned_date) bits.push(`planned ${fd(t.planned_date)}${t.slot ? ` (${lower(t.slot)})` : ""}`);
  if (t.deadline?.date) bits.push(`deadline ${fd(t.deadline.date)}`);
  if (t.man_hours !== null && t.man_hours !== undefined) bits.push(`${fn(t.man_hours, 1)} man-hours`);
  return bits.join(", ");
}

export function composeNextAction(ctx: Ctx): Answer {
  const { kb, e } = ctx;
  const tasks = planTasks(ctx);
  const pns = pnFilter(ctx);
  const tail = e.tails[0];
  if (tail) {
    const myTasks = tasks.filter((t) => t.tail === tail).sort(taskSort);
    const recs = sortRecs(openRecs(ctx).filter((r) => r.tail === tail && (!pns || (r.part_number && pns.has(r.part_number)))));
    const outlook = kb.byId.get(`planac:${tail}`) as KDoc<PlanAircraftFacts> | undefined;
    const bullets: string[] = [];
    if (myTasks.length) {
      const first = myTasks[0];
      let text = `Plan for ${tail}: ${plural(myTasks.length, "task")}. First: ${describeTask(first)}.`;
      if (first.rationale) text += ` Why: ${humanize(first.rationale)}`;
      if (outlook?.facts?.outlook) bullets.push(humanize(outlook.facts.outlook));
      const top = recs[0];
      if (top) for (const ev of top.evidence) bullets.push(`Evidence for ${top.id}: ${humanize(ev.text)}.`);
      return {
        intent: "next_action",
        text,
        bullets,
        table: taskTable(myTasks),
        sources: sources([outlook, ...myTasks.slice(0, 3).map((t) => kb.byId.get(`plantask:${t.id}`)), ...recs.slice(0, 2).map((r) => kb.byId.get(`rec:${r.id}`))]),
        followups: tailFollowups(ctx, tail, "do next"),
        context: { tail },
      };
    }
    if (recs.length) {
      const top = recs[0];
      const text =
        `${tail} has ${plural(recs.length, "open recommendation")} (${breakdown(countBy(recs, (r) => r.priority))}). ` +
        `Do first: ${humanize(top.title)} (${top.priority.toLowerCase()} priority, ${dueText(top)}).`;
      for (const ev of top.evidence) bullets.push(`Why: ${humanize(ev.text)}.`);
      for (const r of recs.slice(1, 4)) bullets.push(`Then ${r.id}: ${humanize(r.title)} (${r.priority.toLowerCase()}, ${dueText(r)}).`);
      return {
        intent: "next_action",
        text,
        bullets,
        table: recTable(recs),
        sources: sources([...recs.slice(0, 4).map((r) => kb.byId.get(`rec:${r.id}`)), kb.aircraft(tail)]),
        followups: tailFollowups(ctx, tail, "do next"),
        context: { tail },
      };
    }
    const ht = nextHtItem(ctx, tail);
    const risky = kb
      .facts<ComponentFacts>("component")
      .filter((c) => c.tail === tail && c.risk?.prob_fail_before_next_phase !== null && c.risk?.prob_fail_before_next_phase !== undefined)
      .sort((a, b) => (b.risk!.prob_fail_before_next_phase ?? 0) - (a.risk!.prob_fail_before_next_phase ?? 0))[0];
    let text = `No open recommendations for ${tail}.`;
    if (ht?.ht) text += ` The next hard-time item is the ${lcName(ht.component)} ${ht.serial}, due ${fd(ht.ht.due_date)} (${lcName(ht.ht.governing)} limit governs).`;
    if (risky?.risk) text += ` Highest model risk: ${lcName(risky.component)} ${risky.serial} at ${pct(risky.risk.prob_fail_before_next_phase)} before the next phase inspection.`;
    return {
      intent: "next_action",
      text,
      sources: sources([kb.aircraft(tail), ht ? kb.component(ht.serial) : undefined, risky ? kb.component(risky.serial) : undefined]),
      followups: tailFollowups(ctx, tail, "do next"),
      context: { tail },
    };
  }

  // Serial, part, type or fleet level.
  let recs = openRecs(ctx).filter((r) => inScope(ctx, r.tail));
  if (e.serials.length) recs = recs.filter((r) => r.serial && e.serials.includes(r.serial));
  else if (pns) recs = recs.filter((r) => r.part_number && pns.has(r.part_number));
  if (e.priorities.length) recs = recs.filter((r) => e.priorities.includes(r.priority));
  recs = sortRecs(recs);
  const summaryDoc = kb.byId.get("plan:summary") as KDoc<PlanSummaryFacts> | undefined;
  if (!e.serials.length && !pns && summaryDoc?.facts && tasks.length) {
    const s = summaryDoc.facts;
    const scoped = tasks.filter((t) => inScope(ctx, t.tail));
    const byId = new Map(scoped.map((t) => [t.id, t]));
    const next = (s.next_actions ?? []).map((id) => byId.get(id)).filter((t): t is PlanTaskFacts => !!t);
    const list = (next.length >= Math.min(3, scoped.length) && next.length ? next : [...scoped].sort(taskSort)).slice(0, e.limit ?? 10);
    let text: string;
    if (e.types.length) {
      const acs = new Set(scoped.map((t) => t.tail).filter(Boolean));
      const mh = scoped.reduce((n, t) => n + (t.man_hours ?? 0), 0);
      text = `Action plan for the ${typesLabel(e.types)}: ${plural(scoped.length, "task")} across ${plural(acs.size, "aircraft", "aircraft")}, ${fn(mh, 1)} man-hours`;
    } else {
      text = `Fleet action plan: ${plural(s.summary.tasks_total ?? tasks.length, "task")}`;
      if (s.summary.aircraft_with_tasks !== undefined) text += ` across ${plural(s.summary.aircraft_with_tasks, "aircraft", "aircraft")}`;
      if (s.summary.man_hours_total !== undefined) text += `, ${fn(s.summary.man_hours_total, 1)} man-hours`;
    }
    text += ` over the next ${plural(s.horizon_days ?? 90, "day")}.`;
    if (!scoped.length) text = `No planned tasks${scopeLabel(ctx)} in the next ${plural(s.horizon_days ?? 90, "day")}.`;
    if (list[0]) text += ` Start with ${list[0].tail ?? "the fleet"}: ${describeTask(list[0])}.`;
    return {
      intent: "next_action",
      text,
      bullets: list.slice(1, 4).map((t) => `${t.tail ?? "Fleet"}: ${describeTask(t)}.`),
      table: taskTable(list),
      sources: sources([summaryDoc, ...list.slice(0, 4).map((t) => kb.byId.get(`plantask:${t.id}`))]),
      followups: ["Which aircraft are due for hard-time items in the next 30 days?", "What is the maintenance workload in the plan?", "Show critical recommendations"],
    };
  }
  if (!recs.length) {
    return {
      intent: "next_action",
      text: `No open recommendations${scopeLabel(ctx)}${e.serials.length ? ` for ${e.serials.join(", ")}` : ""}.`,
      sources: [],
      followups: ["Show all open recommendations", "Which components have the highest risk?"],
    };
  }
  const counts = countBy(recs, (r) => r.priority);
  const top = recs.slice(0, 3);
  const text =
    `${plural(recs.length, "open recommendation")}${scopeLabel(ctx)} (${breakdown(counts)}). Start with: ` +
    top.map((r, i) => `${i + 1}. ${r.tail ?? "Fleet"}, ${humanize(r.title)} (${r.priority.toLowerCase()}, ${dueText(r)})`).join("; ") + ".";
  const shown = recs.slice(0, e.limit ?? 15);
  return {
    intent: "next_action",
    text,
    bullets: top[0] ? top[0].evidence.map((ev) => `Why ${top[0].id}: ${humanize(ev.text)}.`) : [],
    table: recTable(shown),
    sources: sources(top.map((r) => kb.byId.get(`rec:${r.id}`)), [{ title: "Recommendation queue", href: "/recommendations" }]),
    followups: top[0]?.tail ? [`What should we do next on ${top[0].tail}?`, "Show critical recommendations", "Which aircraft are due for hard-time items in the next 30 days?"] : ["Show critical recommendations"],
  };
}

export function composeRecommendations(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  if (e.recIds.length) {
    const docs = e.recIds.map((id) => kb.byId.get(`rec:${id}`) as KDoc<RecFacts> | undefined).filter((d): d is KDoc<RecFacts> => !!d);
    if (!docs.length) return notFound(ctx, e.recIds.join(", "));
    const r = docs[0].facts!;
    const bullets = [
      ...r.evidence.map((ev) => `Evidence (${ev.type.replace(/_/g, " ")}): ${humanize(ev.text)}.`),
      ...(r.confidence ? [`Confidence: probability ${pct(r.confidence.probability)}, interval ${pct(r.confidence.interval[0])} to ${pct(r.confidence.interval[1])}.`] : []),
      ...r.audit.map((a) => `Audit: ${a.action} by ${a.by} (${a.role}) on ${fd(a.at)}${a.remarks ? `, ${humanize(a.remarks)}` : ""}.`),
    ];
    return {
      intent: "recommendations",
      text:
        `${r.id}: ${humanize(r.title)}. Status ${r.status.toLowerCase()}, ${r.priority.toLowerCase()} priority, ${r.basis.toLowerCase()} basis, action ${r.action.toLowerCase()}, ${dueText(r)}.` +
        (r.task_card ? ` Task card ${r.task_card}.` : "") + (r.work_order ? ` Work order ${r.work_order}.` : "") + ` Created ${fd(r.created)}.`,
      bullets,
      sources: sources(docs),
      followups: r.tail ? [`What should we do next on ${r.tail}?`, `Show snags on ${r.tail}`] : [],
      context: { tail: r.tail ?? undefined, serial: r.serial ?? undefined },
    };
  }
  const wantsHistory = e.statuses.some((s) => s !== "Open") || /\b(history|historical|past|previous|closed|last 12 months|work orders?)\b/.test(q);
  let recs = recDocs(ctx).map((d) => d.facts!);
  if (!wantsHistory) recs = recs.filter((r) => r.is_open);
  const pns = pnFilter(ctx);
  if (e.statuses.length) recs = recs.filter((r) => e.statuses.includes(r.status) && (r.status !== "Open" || r.is_open));
  recs = recs.filter((r) => inScope(ctx, r.tail));
  if (e.serials.length) recs = recs.filter((r) => r.serial && e.serials.includes(r.serial));
  if (pns) recs = recs.filter((r) => r.part_number && pns.has(r.part_number));
  if (e.atas.length) recs = recs.filter((r) => r.ata && e.atas.includes(r.ata));
  if (e.taskCards.length) recs = recs.filter((r) => r.task_card && e.taskCards.includes(r.task_card));
  if (e.priorities.length) recs = recs.filter((r) => e.priorities.includes(r.priority));
  if (e.actions.length) recs = recs.filter((r) => e.actions.includes(r.action));
  if (e.lots.length) recs = recs.filter((r) => e.lots.some((l) => r.title.includes(l) || r.evidence.some((ev) => ev.text.includes(l))));
  if (e.window) recs = recs.filter((r) => inWindow(r.created, e.window));
  if (/\bwork orders?\b/.test(q)) recs = recs.filter((r) => r.work_order);
  recs = sortRecs(recs);
  const kind = wantsHistory ? (e.statuses.length ? e.statuses.map((s) => s.toLowerCase()).join(" or ") : "") : "open";
  if (!recs.length) {
    return {
      intent: "recommendations",
      text: `No ${kind ? `${kind} ` : ""}recommendations${scopeLabel(ctx)}${e.window ? ` in ${e.window.label}` : ""}.`,
      sources: [{ title: "Recommendation queue", href: "/recommendations" }],
      followups: ["Show all open recommendations", "What should we do next?"],
    };
  }
  if (/\bwhich (aircraft|tail|jet)s?\b|\b(by|per|each) (aircraft|tail)\b/.test(q) && !e.tails.length) {
    const byTail = Object.entries(countBy(recs, (r) => r.tail ?? "Fleet")).sort((a, b) => (e.direction === "asc" ? 1 : -1) * (a[1] - b[1]) || a[0].localeCompare(b[0]));
    const top = byTail.filter(([, c]) => c === byTail[0][1]).map(([t]) => t);
    return {
      intent: "recommendations",
      text: `${e.direction === "asc" ? "Fewest" : "Most"} ${kind ? `${kind} ` : ""}recommendations${scopeLabel(ctx)}: ${top.join(", ")} with ${byTail[0][1]} each, out of ${plural(recs.length, "recommendation")} in total.`,
      table: {
        columns: ["Aircraft", "Recommendations", "Critical", "High", "Medium", "Low"],
        rows: byTail.map(([t, c]) => [t, c, ...["Critical", "High", "Medium", "Low"].map((p) => recs.filter((r) => (r.tail ?? "Fleet") === t && r.priority === p).length)]),
        links: byTail.map(([t]) => (t === "Fleet" ? null : `/aircraft/${t}`)),
      },
      sources: [{ title: "Recommendation queue", href: "/recommendations" }],
      followups: top[0] && top[0] !== "Fleet" ? [`What should we do next on ${top[0]}?`] : [],
    };
  }
  const priorityCounts = countBy(recs, (r) => r.priority);
  const statusCounts = countBy(recs, (r) => r.status);
  let text = `${plural(recs.length, `${kind ? `${kind} ` : ""}recommendation`)}${scopeLabel(ctx)}${e.window ? ` created in ${e.window.label}` : ""}: ${breakdown(priorityCounts)}.`;
  if (wantsHistory) text += ` By status: ${Object.entries(statusCounts).sort().map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")}.`;
  const wo = recs.filter((r) => r.work_order);
  if (/\bwork orders?\b/.test(q)) text += ` ${plural(wo.length, "work order")} raised.`;
  const { table, note } = limitRows(recTable(recs, wantsHistory));
  return {
    intent: "recommendations",
    text: text + note,
    table,
    sources: sources(recs.slice(0, 4).map((r) => ctx.kb.byId.get(`rec:${r.id}`)), [{ title: "Recommendation queue", href: "/recommendations" }]),
    followups: [recs[0].tail ? `What should we do next on ${recs[0].tail}?` : "What should we do next?", `Tell me about ${recs[0].id}`],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

export function composePlan(ctx: Ctx): Answer {
  const { kb, q, e } = ctx;
  const summaryDoc = kb.byId.get("plan:summary") as KDoc<PlanSummaryFacts> | undefined;
  if (e.taskIds.length) {
    const d = kb.byId.get(`plantask:${e.taskIds[0]}`) as KDoc<PlanTaskFacts> | undefined;
    if (d?.facts) {
      const t = d.facts;
      const bullets: string[] = [];
      if (t.rationale) bullets.push(`Why: ${humanize(t.rationale)}`);
      if (t.risk_if_deferred?.probability !== null && t.risk_if_deferred?.probability !== undefined) {
        bullets.push(`Risk if deferred: ${pct(t.risk_if_deferred.probability)}${t.risk_if_deferred.to ? ` by the ${lower(humanize(t.risk_if_deferred.to))}` : ""}.`);
      }
      return {
        intent: "plan",
        text: `${t.id} for ${t.tail ?? "the fleet"}: ${describeTask(t)}.`,
        bullets,
        sources: sources([d, t.rec_id ? kb.byId.get(`rec:${t.rec_id}`) : undefined]),
        followups: t.tail ? [`What should we do next on ${t.tail}?`] : [],
        context: t.tail ? { tail: t.tail } : undefined,
      };
    }
  }
  if (!summaryDoc?.facts) {
    const fallback = composeNextAction(ctx);
    return { ...fallback, intent: "plan", text: `The action plan is not in this export, so here is the open recommendation queue instead. ${fallback.text}` };
  }
  if (e.tails.length || e.types.length) return composeNextAction(ctx);
  const s = summaryDoc.facts;
  const sm = s.summary;
  const bits: string[] = [];
  if (sm.tasks_total !== undefined) bits.push(`${plural(sm.tasks_total, "task")}${sm.aircraft_with_tasks !== undefined ? ` across ${plural(sm.aircraft_with_tasks, "aircraft", "aircraft")}` : ""}`);
  if (sm.man_hours_total !== undefined) bits.push(`${fn(sm.man_hours_total, 1)} man-hours in total`);
  if (sm.tasks_this_week !== undefined) bits.push(`${plural(sm.tasks_this_week, "task")} in the first week`);
  if (sm.peak_week?.week_start) bits.push(`peak workload in the week of ${fd(sm.peak_week.week_start)} (${fn(sm.peak_week.man_hours ?? 0, 1)} man-hours)`);
  if (sm.min_availability_pct !== null && sm.min_availability_pct !== undefined) {
    bits.push(`lowest projected availability ${fn(sm.min_availability_pct)}%${sm.min_availability_week ? ` in the week of ${fd(sm.min_availability_week)}` : ""}`);
  }
  const text = `Action plan for the next ${plural(s.horizon_days ?? 90, "day")}: ${bits.join(", ")}.`;
  if (/\bspares?\b|\bparts? (needed|required)\b/.test(q) && s.spares?.length) {
    return {
      intent: "plan",
      text: `${text} Spares demand: ${plural(s.spares.reduce((n, x) => n + x.units_required, 0), "unit")} across ${plural(s.spares.length, "part number")}.`,
      table: { columns: ["Part number", "Component", "Units required"], rows: s.spares.map((x) => [x.part_number, x.component, x.units_required]) },
      sources: sources([summaryDoc]),
      followups: ["What should we do next?", "Which aircraft are due for hard-time items in the next 30 days?"],
    };
  }
  const byId = new Map(planTasks(ctx).map((t) => [t.id, t]));
  const next = (s.next_actions ?? []).map((id) => byId.get(id)).filter((t): t is PlanTaskFacts => !!t);
  const list = next.length ? next : [...byId.values()].sort(taskSort).slice(0, 10);
  return {
    intent: "plan",
    text,
    table: list.length ? taskTable(list) : undefined,
    sources: sources([summaryDoc, ...list.slice(0, 3).map((t) => kb.byId.get(`plantask:${t.id}`))]),
    followups: ["What spares does the plan need?", "What should we do next on FX-307?", "Show critical recommendations"],
  };
}

// ---------------------------------------------------------------------------
// Hard time and risk
// ---------------------------------------------------------------------------
export function composeDue(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  const pns = pnFilter(ctx);
  let items = kb.facts<ComponentFacts>("component").filter((c) => c.ht && inScope(ctx, c.tail));
  if (e.serials.length) items = items.filter((c) => e.serials.includes(c.serial));
  if (pns) items = items.filter((c) => pns.has(c.part_number));
  items.sort((a, b) => (a.ht!.days_to_due ?? 1e9) - (b.ht!.days_to_due ?? 1e9) || a.serial.localeCompare(b.serial));
  const overdue = items.filter((c) => (c.ht!.days_to_due ?? 0) < 0);
  const asksOverdue = /\boverdue\b|\bexceed\w*\b|\bpast (its|their) limit\b/.test(q);
  const table = (list: ComponentFacts[]): AnswerTable => ({
    columns: ["Aircraft", "Item", "Serial", "Governing limit", "Remaining", "Due date", "Days"],
    rows: list.map((c) => [
      c.tail,
      c.component + (posLabel(c.position, c.zone) ? ` (${posLabel(c.position, c.zone)})` : ""),
      c.serial,
      c.ht!.governing,
      `${fn(c.ht!.remaining, c.ht!.remaining_unit === "months" ? 1 : 0)} ${c.ht!.remaining_unit}`,
      fd(c.ht!.due_date),
      fn(c.ht!.days_to_due),
    ]),
    links: list.map((c) => `/components/${c.serial}`),
  });
  if (asksOverdue) {
    const nearest = items[0];
    return {
      intent: "due",
      text: overdue.length
        ? `${plural(overdue.length, "hard-time item")}${scopeLabel(ctx)} past the governing limit. This would be a data error: military fleets do not fly overdue items.`
        : `No hard-time item${scopeLabel(ctx)} is overdue.` + (nearest ? ` The nearest is the ${lcName(nearest.component)} ${nearest.serial} on ${nearest.tail}, due ${fd(nearest.ht!.due_date)} (${lcName(nearest.ht!.governing)} limit governs).` : ""),
      table: overdue.length ? table(overdue) : undefined,
      sources: sources(overdue.length ? overdue.map((c) => kb.component(c.serial)) : [nearest ? kb.component(nearest.serial) : undefined]),
      followups: ["Which aircraft are due for hard-time items in the next 30 days?"],
    };
  }
  const explicit = e.horizonDays !== undefined;
  const scoped = e.tails.length || e.types.length || e.serials.length || pns;
  const horizon = e.horizonDays ?? (scoped ? Infinity : 90);
  const label = explicit ? e.horizonLabel! : scoped ? "" : "the next 90 days";
  const due = items.filter((c) => (c.ht!.days_to_due ?? Infinity) <= horizon);
  const end = Number.isFinite(horizon) ? isoAdd(kb.asOf, horizon) : null;
  if (!due.length) {
    const next = items[0];
    return {
      intent: "due",
      text: `No hard-time items${scopeLabel(ctx)} fall due in ${label}${end ? ` (to ${fd(end)})` : ""}.` + (next ? ` The next is the ${lcName(next.component)} ${next.serial} on ${next.tail}, due ${fd(next.ht!.due_date)}.` : ""),
      sources: sources([next ? kb.component(next.serial) : undefined]),
      followups: ["Which aircraft are due for hard-time items in the next 90 days?"],
    };
  }
  const head = due.slice(0, 3).map((c) => `${c.tail} ${lcName(c.component)} ${c.serial} on ${fd(c.ht!.due_date)} (${lcName(c.ht!.governing)})`);
  const tails = Array.from(new Set(due.map((c) => c.tail)));
  const text = label
    ? `${plural(due.length, "hard-time item")}${scopeLabel(ctx)} fall due in ${label}${end ? ` (to ${fd(end)})` : ""}, on ${plural(tails.length, "aircraft", "aircraft")}: ${tails.join(", ")}. Soonest: ${head.join("; ")}. Due dates assume each aircraft's trailing 90-day utilisation.`
    : `${plural(due.length, "hard-time item")}${scopeLabel(ctx)}. Soonest: ${head.join("; ")}. Due dates assume each aircraft's trailing 90-day utilisation.`;
  const { table: t, note } = limitRows(table(due));
  return {
    intent: "due",
    text: text + note,
    table: t,
    sources: sources(due.slice(0, 5).map((c) => kb.component(c.serial))),
    followups: tails[0] ? [`What should we do next on ${tails[0]}?`, "Are any hard-time items overdue?"] : [],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

export function composeRisk(ctx: Ctx): Answer {
  const { kb, e } = ctx;
  if (e.serials.length === 1) return composeComponent(ctx, e.serials[0]);
  const keys = scopedKeys(ctx);
  if (keys.length && keys.every((k) => kb.corpus.components.find((c) => c.key === k)?.concept === "HT")) return composeDue(ctx);
  const pns = pnFilter(ctx);
  let units = kb.facts<ComponentFacts>("component").filter((c) => c.risk && c.risk.prob_fail_before_next_phase !== null && inScope(ctx, c.tail));
  if (pns) units = units.filter((c) => pns.has(c.part_number));
  if (e.lots.length) units = units.filter((c) => c.lot && e.lots.includes(c.lot));
  // Tyres and brakes are routine wear consumables; like the recommendation
  // queue, leave them out of a general ranking unless they are asked for.
  const excluded = !e.componentKeys.some((k) => isConsumable(k)) && !e.serials.length;
  if (excluded) units = units.filter((c) => !isConsumable(c.key));
  if (!units.length) return notFound(ctx, `survival model scores${scopeLabel(ctx)}`);
  units.sort((a, b) => (b.risk!.prob_fail_before_next_phase ?? 0) - (a.risk!.prob_fail_before_next_phase ?? 0) || (a.risk!.fh_to_tau ?? 0) - (b.risk!.fh_to_tau ?? 0));
  if (e.direction === "asc") units.reverse();
  const top = units[0];
  const r = top.risk!;
  const text =
    `${e.direction === "asc" ? "Lowest" : "Highest"} failure risk before the next phase inspection${scopeLabel(ctx)}: ${lcName(top.component)} ${top.serial} on ${top.tail}, ` +
    `${pct(r.prob_fail_before_next_phase)} (${fn(r.fh_to_tau)} FH to the ${pct(r.tau)} threshold, 80% interval ${fn(r.fh_to_tau_p10)} to ${fn(r.fh_to_tau_p90)} FH). ` +
    `Ranked over ${plural(units.length, "on-condition or condition-monitored unit")} scored by the Weibull AFT survival model${excluded ? " (tyres and brakes are wear consumables and are left out)" : ""}; hard-time items have fixed limits instead.`;
  const shown = units.slice(0, e.limit ?? 10);
  const single = units.length === 1
    ? `${top.component} ${top.serial} on ${top.tail}: ${pct(r.prob_fail_before_next_phase)} probability of failure before the next phase inspection, ${fn(r.fh_to_tau)} FH until the ${pct(r.tau)} risk threshold (80% interval ${fn(r.fh_to_tau_p10)} to ${fn(r.fh_to_tau_p90)} FH), from the Weibull AFT survival model.`
    : null;
  return {
    intent: "risk",
    text: single ?? text,
    bullets: r.explanation ? [`Drivers for ${top.serial}: ${r.explanation}.`] : [],
    table: {
      columns: ["Aircraft", "Component", "Serial", "Failure probability before phase", "FH to threshold", "80% interval (FH)"],
      rows: shown.map((c) => [c.tail, c.component, c.serial, pct(c.risk!.prob_fail_before_next_phase), fn(c.risk!.fh_to_tau), `${fn(c.risk!.fh_to_tau_p10)} to ${fn(c.risk!.fh_to_tau_p90)}`]),
      links: shown.map((c) => `/components/${c.serial}`),
    },
    sources: sources(shown.slice(0, 4).map((c) => kb.component(c.serial))),
    followups: [`What should we do next on ${top.tail}?`, `Tell me about ${top.serial}`],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Snags, removals, maintenance records
// ---------------------------------------------------------------------------
function patternDocs(ctx: Ctx, kinds: PatternFacts["kind"][]): KDoc<PatternFacts>[] {
  return ctx.kb.docs<PatternFacts>("pattern").filter((d) => kinds.includes(d.facts!.kind));
}

export function composeSnags(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  const repeatQ = /\b(repeat\w*|recurr\w*|keeps?|again)\b/.test(q);
  let docs = kb.docs<SnagFacts>("snag").filter((d) => inScope(ctx, d.facts!.tail));
  if (e.atas.length) docs = docs.filter((d) => d.facts!.ata && e.atas.includes(d.facts!.ata));
  if (e.componentKeys.length) docs = docs.filter((d) => d.facts!.key && e.componentKeys.includes(d.facts!.key));
  if (e.window) docs = docs.filter((d) => inWindow(d.facts!.date, e.window));
  if (e.statuses.includes("Open")) docs = docs.filter((d) => d.facts!.status === "Open");
  docs = [...docs].sort((a, b) => b.facts!.date.localeCompare(a.facts!.date) || b.facts!.snag_id.localeCompare(a.facts!.snag_id));

  let patterns = patternDocs(ctx, ["repeat_snag", "repeat_nff"]).filter((p) => inScope(ctx, String(p.facts!.tail)));
  if (e.atas.length) patterns = patterns.filter((p) => !p.keys.ata || e.atas.includes(p.keys.ata));
  const bullets = patterns.map((p) => humanize(p.text));
  const trouble = sortRecs(openRecs(ctx).filter((r) => r.action === "Troubleshoot" && inScope(ctx, r.tail)));
  for (const r of trouble) bullets.push(`${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}. ${r.evidence.map((ev) => humanize(ev.text)).join(". ")}.`);

  if (repeatQ && !docs.length && !patterns.length) {
    return { intent: "snags", text: `No repeat snags detected${scopeLabel(ctx)}. The detector flags 3 or more snags on the same tail and ATA chapter within 60 days, or 2 or more NFF removals of the same position within 120 days.`, sources: [], followups: ["Show open snags"] };
  }
  if (!docs.length) {
    return { intent: "snags", text: `No snags recorded${scopeLabel(ctx)}${e.window ? ` in ${e.window.label}` : ""}.`, bullets, sources: sources(patterns), followups: ["Show open snags", "Which aircraft have repeat snags?"] };
  }
  const open = docs.filter((d) => d.facts!.status === "Open").length;
  const byAta = countBy(docs, (d) => d.facts!.ata ?? "not recorded");
  const topAta = Object.entries(byAta).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  let text = `${plural(docs.length, "snag")}${scopeLabel(ctx)}${e.window ? ` in ${e.window.label}` : " in the data window"}, ${open} open. Most common chapter: ATA ${topAta[0]} (${topAta[1]}).`;
  if (e.tails.length === 1) {
    const other = sortRecs(openRecs(ctx).filter((r) => r.tail === e.tails[0] && r.action !== "Troubleshoot"));
    for (const r of other.slice(0, 3)) bullets.push(`${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}.`);
  }
  if (!e.tails.length) {
    const byTail = Object.entries(countBy(docs, (d) => d.facts!.tail)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    text += ` Most snags: ${byTail[0][0]} (${byTail[0][1]}).`;
  }
  if (patterns.length) text += ` ${plural(patterns.length, "repeat pattern")} detected, see below.`;
  const { table, note } = limitRows({
    columns: ["Snag", "Date", "Aircraft", "ATA", "Description", "Rectification", "Status"],
    rows: docs.map((d) => [d.facts!.snag_id, fd(d.facts!.date), d.facts!.tail, d.facts!.ata ?? "", d.facts!.description, d.facts!.rectification, d.facts!.status]),
    links: docs.map((d) => d.href),
  });
  return {
    intent: "snags",
    text: text + note,
    bullets,
    table,
    sources: sources([...patterns, ...trouble.map((r) => kb.byId.get(`rec:${r.id}`)), ...docs.slice(0, 3)]),
    followups: e.tails[0] ? [`What should we do next on ${e.tails[0]}?`, `Show removals on ${e.tails[0]}`] : ["Which aircraft have repeat snags?", "Show open snags"],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

export function composeRemovals(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  const pns = pnFilter(ctx);
  let docs = kb.docs<EventFacts>("event");
  const wantsInstall = /\binstall\w*\b/.test(q) && !/\bremov\w*|replac\w*|swap\w*/.test(q);
  const wantsAll = /\b(history|history card|installation history|movements?)\b/.test(q) && !/\bremov\w*/.test(q);
  if (!wantsAll) docs = docs.filter((d) => d.facts!.event_type === (wantsInstall ? "Install" : "Removal"));
  docs = docs.filter((d) => inScope(ctx, d.facts!.tail));
  if (e.serials.length) docs = docs.filter((d) => e.serials.includes(d.facts!.serial));
  if (pns) docs = docs.filter((d) => pns.has(d.facts!.part_number));
  if (e.lots.length) docs = docs.filter((d) => d.facts!.lot && e.lots.includes(d.facts!.lot));
  if (e.window) docs = docs.filter((d) => inWindow(d.facts!.date, e.window));
  if (e.reasons.length && !wantsInstall) docs = docs.filter((d) => d.facts!.reason && e.reasons.includes(d.facts!.reason));
  if (/\bunscheduled\b/.test(q)) docs = docs.filter((d) => d.facts!.reason?.startsWith("Unscheduled"));
  docs = [...docs].sort((a, b) => b.facts!.date.localeCompare(a.facts!.date) || b.facts!.event_id.localeCompare(a.facts!.event_id));
  const reasonLabel: Record<string, string> = {
    "Unscheduled: NFF": "NFF removal",
    "Unscheduled: confirmed failure": "confirmed failure removal",
    "Scheduled (hard time)": "scheduled hard-time removal",
    Cannibalisation: "cannibalisation removal",
    "Scheduled (engine change)": "engine change removal",
  };
  const what = wantsAll
    ? "component event"
    : wantsInstall
      ? "installation"
      : e.reasons.length === 1
        ? reasonLabel[e.reasons[0]]
        : /\bunscheduled\b/.test(q)
          ? "unscheduled removal"
          : "removal";
  const scope = `${scopeLabel(ctx)}${e.serials.length ? ` of ${e.serials.join(", ")}` : ""}${e.lots.length ? ` from lot ${e.lots.join(", ")}` : ""}`;
  if (!docs.length) {
    return { intent: "removals", text: `No ${what}s recorded${scope}${e.window ? ` in ${e.window.label}` : ""}.`, sources: [], followups: ["Show unscheduled removals in the last 12 months"] };
  }
  const head = docs[0].facts!;
  let text: string;
  if (e.latest) {
    text = `Most recent ${what}${scope}: ${lcName(head.component)} ${head.serial} ${head.event_type === "Install" ? "installed on" : "removed from"} ${head.tail} on ${fd(head.date)}${head.reason ? ` (${head.reason})` : ""}, unit time ${fn(head.hours_at_event, 1)} FH.`;
  } else {
    text = `${plural(docs.length, what)}${scope}${e.window ? ` in ${e.window.label}` : " in the data window"}.`;
    if (!wantsInstall && !wantsAll) {
      const reasons = Object.entries(countBy(docs, (d) => d.facts!.reason ?? "not stated")).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      text += ` By reason: ${reasons.map(([r, n]) => `${r} ${n}`).join(", ")}.`;
    }
    if (!pns && !e.serials.length) {
      const comps = Object.entries(countBy(docs, (d) => d.facts!.component)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      text += ` Most frequent: ${comps.slice(0, 3).map(([c, n]) => `${lcName(c)} ${n}`).join(", ")}.`;
    }
  }
  const { table, note } = limitRows({
    columns: ["Date", "Aircraft", "Component", "Serial", "Event", "Reason", "Unit time (FH)"],
    rows: docs.map((d) => [fd(d.facts!.date), d.facts!.tail, d.facts!.component, d.facts!.serial, d.facts!.event_type, d.facts!.reason ?? "", fn(d.facts!.hours_at_event, 1)]),
    links: docs.map((d) => d.href),
  });
  return {
    intent: "removals",
    text: text + note,
    table,
    sources: sources(docs.slice(0, 4)),
    followups: e.tails[0] ? [`Show snags on ${e.tails[0]}`, `What should we do next on ${e.tails[0]}?`] : ["Which part has the highest NFF rate?", "Show unscheduled removals in the last 12 months"],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

export function composeMaintenance(ctx: Ctx): Answer {
  const { kb, e } = ctx;
  let docs = kb.docs<MaintFacts>("maintenance").filter((d) => inScope(ctx, d.facts!.tail));
  if (e.recordTypes.length) docs = docs.filter((d) => e.recordTypes.includes(d.facts!.record_type));
  if (e.window) docs = docs.filter((d) => inWindow(d.facts!.date, e.window));
  docs = [...docs].sort((a, b) => b.facts!.date.localeCompare(a.facts!.date) || b.facts!.record_id.localeCompare(a.facts!.record_id));
  const kind = e.recordTypes.length ? e.recordTypes.map((t) => t.toLowerCase()).join(" or ") : "maintenance";
  const bullets: string[] = [];
  for (const tail of e.tails) {
    const pa = kb.byId.get(`planac:${tail}`) as KDoc<PlanAircraftFacts> | undefined;
    if (pa?.facts?.next_phase?.date) bullets.push(`Next phase inspection on ${tail} projected ${fd(pa.facts.next_phase.date)}${pa.facts.next_phase.fh_to_go !== null && pa.facts.next_phase.fh_to_go !== undefined ? ` (${fn(pa.facts.next_phase.fh_to_go, 1)} FH to go)` : ""}.`);
    if (pa?.facts?.next_periodic?.date) bullets.push(`Next periodic servicing on ${tail} projected ${fd(pa.facts.next_periodic.date)}.`);
  }
  // Chip detector questions: add the oil precursor finding and its recommendation.
  const extra: KDoc[] = [];
  if (e.recordTypes.includes("Chip detector") || /\b(oil|soap)\b/.test(ctx.q)) {
    const oil = patternDocs(ctx, ["oil_active", "oil_fleet"]).filter((d) => d.facts!.kind === "oil_fleet" || !e.tails.length || e.tails.includes(String(d.facts!.tail)));
    for (const d of oil) bullets.push(humanize(d.text));
    const recs = sortRecs(openRecs(ctx).filter((r) => r.ata === "79" && (!e.tails.length || (r.tail && e.tails.includes(r.tail)))));
    for (const r of recs) bullets.push(`${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}.`);
    extra.push(...oil, ...recs.map((r) => kb.byId.get(`rec:${r.id}`)).filter((d): d is KDoc => !!d));
  }
  if (!docs.length) {
    return { intent: "maintenance", text: `No ${kind} records${scopeLabel(ctx)}${e.window ? ` in ${e.window.label}` : ""}.`, bullets, sources: sources(extra), followups: [] };
  }
  const mh = docs.reduce((s, d) => s + (d.facts!.man_hours ?? 0), 0);
  const head = docs[0].facts!;
  const asksNext = /\b(next|upcoming|when is|projected)\b/.test(ctx.q) && e.tails.length > 0 && bullets.length > 0;
  const text = asksNext
    ? `${bullets.splice(0, e.recordTypes.includes("Periodic servicing") && !e.recordTypes.includes("Phase inspection") ? 2 : 1).slice(-1)[0]} Last recorded ${lower(head.record_type)}: ${fd(head.date)}.`
    : e.latest
    ? `Most recent ${kind} record${scopeLabel(ctx)}: ${head.record_type.toLowerCase()} on ${head.tail}, ${fd(head.date)}: ${head.description} (${fn(head.man_hours, 1)} man-hours).`
    : `${plural(docs.length, `${kind} record`)}${scopeLabel(ctx)}${e.window ? ` in ${e.window.label}` : " in the data window"}, ${fn(mh, 1)} man-hours in total. Latest: ${head.record_type.toLowerCase()} on ${head.tail}, ${fd(head.date)}.`;
  const { table, note } = limitRows({
    columns: ["Date", "Aircraft", "Type", "Description", "Man-hours"],
    rows: docs.map((d) => [fd(d.facts!.date), d.facts!.tail, d.facts!.record_type, d.facts!.description, fn(d.facts!.man_hours, 1)]),
    links: docs.map((d) => d.href),
  });
  return {
    intent: "maintenance",
    text: text + note,
    bullets,
    table,
    sources: sources([...extra, ...docs.slice(0, 4)]),
    followups: e.tails[0] ? [`What should we do next on ${e.tails[0]}?`, `Show snags on ${e.tails[0]}`] : ["When was the last phase inspection on FX-301?"],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Sorties and utilisation (exact, from every sortie)
// ---------------------------------------------------------------------------
function sumSorties(list: Sortie[]) {
  return {
    n: list.length,
    fh: list.reduce((s, x) => s + x.duration, 0),
    landings: list.reduce((s, x) => s + x.landings, 0),
    lcf: list.reduce((s, x) => s + x.lcf, 0),
  };
}

function describeSortie(s: Sortie): string {
  return `${s.id} on ${fd(s.date)}, ${lcName(s.mission)}, ${fn(s.duration, 2)} FH, ${plural(s.landings, "landing")}, ${plural(s.lcf, "LCF cycle")}, peak ${fn(s.peakG, 1)} g, from ${s.base} (take-off ${s.takeoff}, landing ${s.landing})`;
}

export async function composeSorties(ctx: Ctx): Promise<Answer> {
  const { kb, e, q } = ctx;
  const tails = scopeTails(ctx) ?? kb.tails;
  let all = await kb.allSorties(tails);
  if (e.sortieIds.length) {
    const found = (await kb.allSorties()).filter((s) => e.sortieIds.includes(s.id));
    if (!found.length) return notFound(ctx, `sortie ${e.sortieIds.join(", ")}`);
    return {
      intent: "sorties",
      text: found.map((s) => `${s.tail} flew ${describeSortie(s)}.`).join(" "),
      sources: found.map((s) => ({ title: `${s.tail} aircraft page`, href: `/aircraft/${s.tail}` })),
      followups: [`How many sorties did ${found[0].tail} fly last month?`],
      context: { tail: found[0].tail },
    };
  }
  const firstDate = all.reduce((m, s) => (s.date < m ? s.date : m), "9999-12-31");
  if (e.window) all = all.filter((s) => inWindow(s.date, e.window));
  if (e.missions.length) all = all.filter((s) => e.missions.includes(s.mission));
  if (e.bases.length) all = all.filter((s) => e.bases.includes(s.base));
  const windowLabel = e.window ? `${e.window.label} (${fd(e.window.from)} to ${fd(e.window.to)})` : `the data window (${fd(firstDate)} to ${fd(kb.asOf)})`;
  const missionLabel = e.missions.length ? `${e.missions.map(lcName).join(" or ")} ` : "";
  const baseLabel = e.bases.length ? ` from ${e.bases.join(" or ")}` : "";
  const src = tails.length <= 3 ? tails.map((t) => kb.aircraft(t)) : [];
  const utilSrc = { title: "Fleet utilisation", href: "/" };

  if (!all.length) {
    return { intent: "sorties", text: `No ${missionLabel}sorties${baseLabel}${e.tails.length ? ` by ${e.tails.join(", ")}` : e.types.length ? ` by the ${typesLabel(e.types)}` : ""} in ${windowLabel}.`, sources: sources(src), followups: [] };
  }
  const sorted = [...all].sort((a, b) => b.date.localeCompare(a.date) || b.takeoff.localeCompare(a.takeoff) || b.id.localeCompare(a.id));

  // Latest sortie.
  if (e.latest && /\b(sortie|flight|flew|fly)\b/.test(q)) {
    const lines = tails.length <= 3
      ? tails.map((t) => sorted.find((s) => s.tail === t)).filter((s): s is Sortie => !!s).map((s) => `Last ${missionLabel}sortie of ${s.tail}: ${describeSortie(s)}.`)
      : [`Last ${missionLabel}sortie in the fleet: ${sorted[0].tail}, ${describeSortie(sorted[0])}.`];
    return {
      intent: "sorties",
      text: lines.join(" "),
      table: { columns: ["Sortie", "Date", "Aircraft", "Mission", "FH", "Landings", "LCF cycles"], rows: sorted.slice(0, 5).map((s) => [s.id, fd(s.date), s.tail, s.mission, fn(s.duration, 2), s.landings, s.lcf]) },
      sources: sources(src, [utilSrc]),
      followups: tails.length === 1 ? tailFollowups(ctx, tails[0], "sorties") : [],
      context: tails.length === 1 ? { tail: tails[0] } : undefined,
    };
  }
  // Extremes.
  if (/\b(longest|shortest)\b/.test(q) || /\b(highest|max\w*|peak) g\b|\bmost g\b/.test(q)) {
    const key = /\bg\b/.test(q) ? "peakG" : "duration";
    const dir = /\bshortest\b/.test(q) ? 1 : -1;
    const best = [...all].sort((a, b) => dir * ((a[key] as number) - (b[key] as number)) || a.id.localeCompare(b.id))[0];
    return {
      intent: "sorties",
      text: `${key === "peakG" ? "Highest peak g" : dir < 0 ? "Longest sortie" : "Shortest sortie"}${e.tails.length ? ` for ${e.tails.join(", ")}` : e.types.length ? ` among the ${typesLabel(e.types)}` : " in the fleet"} in ${windowLabel}: ${best.tail}, ${describeSortie(best)}.`,
      sources: sources([kb.aircraft(best.tail)]),
      followups: [`How many sorties did ${best.tail} fly last month?`],
      context: { tail: best.tail },
    };
  }

  const tot = sumSorties(all);
  const subject = e.tails.length ? e.tails.join(" and ") : e.types.length ? `The ${typesLabel(e.types)}` : "The fleet";
  let text: string;
  if (/\blandings?\b/.test(q) && !/\bsorties?\b/.test(q)) {
    text = `${subject} made ${plural(tot.landings, "landing")}${baseLabel} in ${windowLabel}, over ${plural(tot.n, `${missionLabel}sortie`)} (${fn(tot.fh, 1)} FH, ${plural(tot.lcf, "LCF cycle")}).`;
  } else if (/\b(lcf|cycles?)\b/.test(q) && !/\bsorties?\b/.test(q)) {
    text = `${subject} accumulated ${plural(tot.lcf, "LCF cycle")}${baseLabel} in ${windowLabel}, over ${plural(tot.n, `${missionLabel}sortie`)} (${fn(tot.fh, 1)} FH, ${plural(tot.landings, "landing")}).`;
  } else if (/\b(hours|fh)\b/.test(q) && !/\bsorties?\b/.test(q)) {
    text = `${subject} flew ${fn(tot.fh, 1)} FH${baseLabel} in ${windowLabel}, over ${plural(tot.n, `${missionLabel}sortie`)} (${plural(tot.landings, "landing")}, ${plural(tot.lcf, "LCF cycle")}).`;
  } else {
    text = `${subject} flew ${plural(tot.n, `${missionLabel}sortie`)}${baseLabel} in ${windowLabel}: ${fn(tot.fh, 1)} FH, ${plural(tot.landings, "landing")}, ${plural(tot.lcf, "LCF cycle")}.`;
  }
  let table: AnswerTable;
  const byType = /\bby (aircraft )?type\b|\bper type\b|\beach type\b/.test(q) || (e.types.length >= 2 && !e.tails.length);
  if (byType) {
    const types = (e.types.length ? e.types : kb.typeKeys).filter((t) => tails.some((x) => kb.typeOfTail.get(x) === t));
    const rows = types.map((t) => {
      const list = all.filter((x) => kb.typeOfTail.get(x.tail) === t);
      const n = kb.tailsOf([t]).filter((x) => tails.includes(x)).length;
      return { t, aircraft: n, ...sumSorties(list) };
    });
    text += ` By type: ${rows.map((r) => `${TYPE_PLURAL[r.t]} ${fn(r.fh, 1)} FH over ${plural(r.n, "sortie")}`).join(", ")}.`;
    table = {
      columns: ["Type", "Aircraft", "Sorties", "FH", "FH per aircraft", "Landings", "LCF cycles"],
      rows: rows.map((r) => [kb.typeInfo(r.t)?.name ?? r.t, r.aircraft, r.n, fn(r.fh, 1), fn(r.aircraft ? r.fh / r.aircraft : 0, 1), r.landings, r.lcf]),
    };
  } else if (/\b(per|by|each|every) month\b|\bmonthly\b|\bmonth by month\b/.test(q)) {
    const months = new Map<string, Sortie[]>();
    for (const s of all) months.set(s.date.slice(0, 7), [...(months.get(s.date.slice(0, 7)) ?? []), s]);
    const keys = Array.from(months.keys()).sort().slice(-24);
    table = {
      columns: ["Month", "Sorties", "FH", "Landings", "LCF cycles"],
      rows: keys.map((m) => {
        const t = sumSorties(months.get(m)!);
        return [fd(`${m}-01`).replace(/^1 /, ""), t.n, fn(t.fh, 1), t.landings, t.lcf];
      }),
    };
  } else if (tails.length > 1 && (!e.tails.length || /\b(which|most|least|each|per aircraft|by aircraft|compare)\b/.test(q))) {
    const rows = tails.map((t) => ({ t, ...sumSorties(all.filter((s) => s.tail === t)) }));
    const byCount = /\bsorties?\b|\bflights?\b/.test(q) && !/\bhours?\b|\bfh\b/.test(q);
    const metric = /\blandings?\b/.test(q) ? "landings" : /\bcycles?\b|\blcf\b/.test(q) ? "lcf" : byCount ? "n" : "fh";
    rows.sort((a, b) => (e.direction === "asc" ? 1 : -1) * (a[metric] - b[metric]) || a.t.localeCompare(b.t));
    const label = { n: "sorties", fh: "FH", landings: "landings", lcf: "LCF cycles" }[metric];
    text += ` ${e.direction === "asc" ? "Least" : "Most"}: ${rows[0].t} with ${fn(rows[0][metric], metric === "fh" ? 1 : 0)} ${label}.`;
    table = { columns: ["Aircraft", "Sorties", "FH", "Landings", "LCF cycles"], rows: rows.map((r) => [r.t, r.n, fn(r.fh, 1), r.landings, r.lcf]), links: rows.map((r) => `/aircraft/${r.t}`) };
  } else {
    const byMission = kb.corpus.missions
      .map((m) => ({ m, ...sumSorties(all.filter((s) => s.mission === m)) }))
      .filter((r) => r.n > 0);
    if (!e.missions.length && byMission.length) {
      const acm = byMission.find((r) => r.m === "Air combat manoeuvring");
      text += ` Mission mix: ${byMission.map((r) => `${lcName(r.m)} ${r.n}`).join(", ")}.`;
      if (acm) text += ` ACM share ${pct(acm.fh / tot.fh)} of FH.`;
    }
    table = { columns: ["Mission", "Sorties", "FH", "Landings", "LCF cycles"], rows: byMission.map((r) => [r.m, r.n, fn(r.fh, 1), r.landings, r.lcf]) };
  }
  return {
    intent: "sorties",
    text,
    table,
    sources: sources(src, [utilSrc]),
    followups: e.tails.length === 1 ? tailFollowups(ctx, e.tails[0], "sorties") : ["Which aircraft flew the most hours in the last 12 months?", "How many ACM sorties did FX-304 fly in 2026?"],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Engine, fatigue, reliability
// ---------------------------------------------------------------------------
function engineLine(tail: string, en: EngineFacts, multi: boolean): string {
  const t = en.trend;
  const name = multi ? `${tail} engine ${en.position} (${en.serial})` : `${tail} engine ${en.serial}`;
  if (!t || t.current_margin_c === null) {
    return `${name}: ${fn(en.efh, 1)} EFH, ${fn(en.operating_hours, 1)} operating hours. No ${en.metric} trend yet: the trend monitor needs enough EFH and readings since installation.`;
  }
  const flags: string[] = [];
  if (t.flag_fleet_outlier) flags.push(`its slope is beyond the fleet 5th percentile of ${en.metric} deterioration`);
  if (t.flag_near_term) flags.push("projected crossing is under 100 EFH");
  return (
    `${name}: ${en.metric} ${fn(t.current_margin_c, 1)} °C at ${fn(t.current_efh, 1)} EFH (${fn(en.operating_hours, 1)} operating hours). ` +
    `Robust trend over the last 150 EFH: ${fn(t.slope_c_per_efh, 3)} °C per EFH (95% interval ${fn(t.slope_ci_lo, 3)} to ${fn(t.slope_ci_hi, 3)}). ` +
    (t.projected_efh_to_limit !== null
      ? `Projected to reach the ${fn(t.limit_c)} °C margin limit in ${fn(t.projected_efh_to_limit, 1)} EFH. `
      : `No crossing of the ${fn(t.limit_c)} °C limit is projected on the current trend. `) +
    (flags.length ? `Flagged: ${flags.join(" and ")}.` : "Not flagged.")
  );
}

export function composeEngine(ctx: Ctx): Answer {
  const { kb, e } = ctx;
  if (e.tails.length) {
    const tail = e.tails[0];
    const a = kb.aircraft(tail)?.facts;
    if (!a) return notFound(ctx, tail);
    const engines = a.engines ?? [];
    const multi = engines.length > 1;
    const positions = e.enginePositions;
    const chosen = positions.length ? engines.filter((x) => positions.includes(x.position)) : engines;
    if (positions.length && !chosen.length) {
      return {
        intent: "engine",
        text: `${tail} is a ${lower(a.type_name ?? "aircraft")} with ${plural(engines.length, "engine")}, so there is no engine ${positions.join(" or ")}.`,
        sources: sources([kb.aircraft(tail)]),
        followups: tailFollowups(ctx, tail, "trend"),
        context: { tail },
      };
    }
    const bullets: string[] = [];
    const engineParts = kb
      .facts<ComponentFacts>("component")
      .filter((c) => c.tail === tail && /(^|-)(ENGINE|HPT|PROP)$/.test(c.key) && c.ht && (!positions.length || positions.includes(c.position)));
    for (const c of engineParts) {
      const pos = posLabel(c.position, c.zone);
      bullets.push(`${c.component} ${c.serial}${pos && multi ? ` (${pos})` : ""}: ${lcName(c.ht!.governing)} limit governs, ${fn(c.ht!.remaining)} ${c.ht!.remaining_unit} remaining, due ${fd(c.ht!.due_date)}.`);
    }
    const recs = sortRecs(openRecs(ctx).filter((r) => r.tail === tail && (r.ata === "72" || r.ata === "61") && (!positions.length || !r.position || positions.includes(r.position))));
    for (const r of recs) bullets.push(`${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}.`);
    let text: string;
    if (chosen.length === 1) {
      text = engineLine(tail, chosen[0], multi);
    } else {
      const withTrend = chosen.filter((x) => x.trend && x.trend.current_margin_c !== null);
      const flagged = withTrend.filter((x) => x.trend!.flagged);
      const lead = [...withTrend].sort((x, y) => (x.trend!.slope_c_per_efh ?? 0) - (y.trend!.slope_c_per_efh ?? 0))[0];
      text = `${tail} (${lower(a.type_name ?? "aircraft")}) has ${plural(chosen.length, "engine")}, monitored by ${kb.metricOf(tail)}. ` +
        (flagged.length ? `Flagged: ${flagged.map((x) => `engine ${x.position} (${x.serial})`).join(", ")}. ` : "No engine is flagged. ") +
        (lead ? `Fastest deterioration: ${engineLine(tail, lead, true)}` : "");
    }
    const metric = kb.metricOf(tail);
    return {
      intent: "engine",
      text,
      bullets,
      table: multi
        ? {
            columns: ["Engine", "Serial", "EFH", "Operating hours", `${metric} (°C)`, "Trend (°C per EFH)", "EFH to limit", "Flagged"],
            rows: chosen.map((x) => [
              x.position,
              x.serial,
              fn(x.efh, 1),
              fn(x.operating_hours, 1),
              fn(x.trend?.current_margin_c, 1),
              fn(x.trend?.slope_c_per_efh, 3),
              x.trend ? (x.trend.projected_efh_to_limit === null ? "None projected" : fn(x.trend.projected_efh_to_limit, 1)) : "No trend yet",
              x.trend?.flagged ? "Yes" : "No",
            ]),
          }
        : undefined,
      sources: sources([
        ...chosen.filter((x) => x.trend?.flagged).map((x) => kb.byId.get(`pattern:egt:${tail}:${x.position}`)),
        kb.aircraft(tail),
        ...recs.map((r) => kb.byId.get(`rec:${r.id}`)),
      ]),
      followups: tailFollowups(ctx, tail, "trend"),
      context: { tail },
    };
  }
  // Fleet or type level: one row per engine with a trend.
  let tails = scopeTails(ctx) ?? kb.tails;
  if (e.metric) tails = tails.filter((t) => kb.metricOf(t) === e.metric);
  const rows: { tail: string; en: EngineFacts }[] = [];
  for (const t of tails) {
    const a = kb.aircraft(t)?.facts;
    for (const en of a?.engines ?? []) {
      if (en.trend && en.trend.current_margin_c !== null && (!e.enginePositions.length || e.enginePositions.includes(en.position))) rows.push({ tail: t, en });
    }
  }
  if (!rows.length) return notFound(ctx, `engine trends${scopeLabel(ctx)}`);
  const byMargin = /\bmargin\b/.test(ctx.q) && !/\btrend|slope|deteriorat\w*/.test(ctx.q);
  rows.sort((x, y) =>
    byMargin
      ? (x.en.trend!.current_margin_c ?? 0) - (y.en.trend!.current_margin_c ?? 0)
      : (x.en.trend!.slope_c_per_efh ?? 0) - (y.en.trend!.slope_c_per_efh ?? 0) || x.tail.localeCompare(y.tail)
  );
  const flagged = rows.filter((r) => r.en.trend!.flagged);
  const lead = rows[0];
  const metrics = Array.from(new Set(rows.map((r) => r.en.metric)));
  const label = (r: { tail: string; en: EngineFacts }) => ((kb.aircraft(r.tail)?.facts?.engines ?? []).length > 1 ? `${r.tail} engine ${r.en.position}` : r.tail);
  const text =
    `${plural(rows.length, "engine")}${scopeLabel(ctx)} have a trend (${metrics.join(" and ")}). ${byMargin ? "Lowest margin" : "Fastest deterioration"}: ${label(lead)} (${lead.en.serial}), ` +
    `${lead.en.metric} ${fn(lead.en.trend!.current_margin_c, 1)} °C, ${fn(lead.en.trend!.slope_c_per_efh, 3)} °C per EFH. ` +
    (flagged.length ? `Flagged: ${flagged.map(label).join(", ")}.` : "No engine is flagged.");
  return {
    intent: "engine",
    text,
    table: {
      columns: ["Aircraft", "Engine", "Serial", "Metric", "EFH", "Margin (°C)", "Trend (°C per EFH)", "EFH to limit", "Flagged"],
      rows: rows.map((r) => {
        const t = r.en.trend!;
        return [r.tail, r.en.position, r.en.serial, r.en.metric, fn(t.current_efh, 1), fn(t.current_margin_c, 1), fn(t.slope_c_per_efh, 3), t.projected_efh_to_limit === null ? "None projected" : fn(t.projected_efh_to_limit, 1), t.flagged ? "Yes" : "No"];
      }),
      links: rows.map((r) => `/aircraft/${r.tail}`),
    },
    sources: sources([...flagged.map((r) => kb.byId.get(`pattern:egt:${r.tail}:${r.en.position}`)), kb.aircraft(lead.tail)]),
    followups: [`Show the ${metricWord(ctx, lead.tail)} trend for ${lead.tail}${(kb.aircraft(lead.tail)?.facts?.engines ?? []).length > 1 ? ` engine ${lead.en.position}` : ""}`, `What should we do next on ${lead.tail}?`],
  };
}

export function composeFatigue(ctx: Ctx): Answer {
  const { kb, e } = ctx;
  const aircraft = kb.facts<AircraftFacts>("aircraft").filter((a) => inScope(ctx, a.tail));
  if (e.tails.length) {
    const tail = e.tails[0];
    const a = kb.aircraft(tail)?.facts;
    if (!a) return notFound(ctx, tail);
    const f = a.fatigue;
    if (!f) return { intent: "fatigue", text: `${tail} fatigue index is ${fn(a.fi, 1)}. No projection is available (no flying in the trailing 12 months).`, sources: sources([kb.aircraft(tail)]), followups: [] };
    const heavy = f.heavy_mission ?? "Air combat manoeuvring";
    const relief = f.relief_mission ?? "General flying";
    const share = f.heavy_mission_share_trailing ?? f.acm_share_trailing;
    const gain = f.life_gain_days_if_shifted ?? f.life_gain_days_if_acm_shifted;
    const recs = openRecs(ctx).filter((r) => r.tail === tail && r.action === "Review allocation");
    const text =
      `${tail} (${lower(a.type_name ?? "aircraft")}) fatigue index ${fn(f.fi_now, 1)}${f.fatigue_model ? `, accumulated from ${f.fatigue_model}` : ""}. ` +
      `Over the trailing 12 months it consumed ${fn(f.fi_per_fh, 4)} FI per FH across ${fn(f.fh_trailing_12mo, 1)} FH, with a ${lcName(heavy)} share of ${pct(share)}. ` +
      `At that rate FI reaches 100 on ${fd(f.projected_fi100_date)}, ${f.flagged_before_withdrawal ? "before" : "after"} the planned withdrawal year ${a.planned_withdrawal_year}.` +
      (gain !== null && gain !== undefined ? ` Shifting 15 points of ${lcName(heavy)} to ${lcName(relief)} would add about ${plural(gain, "day")}.` : "");
    return {
      intent: "fatigue",
      text,
      bullets: recs.map((r) => `${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}.`),
      sources: sources([kb.byId.get(`pattern:fatigue:${tail}`), kb.aircraft(tail), ...recs.map((r) => kb.byId.get(`rec:${r.id}`))]),
      followups: tailFollowups(ctx, tail, "fatigue"),
      context: { tail },
    };
  }
  const list = aircraft.filter((a) => a.fatigue);
  const byDate = /\b(soonest|earliest|first|projected|date|when)\b/.test(ctx.q);
  if (byDate) list.sort((a, b) => (a.fatigue!.projected_fi100_date ?? "9999").localeCompare(b.fatigue!.projected_fi100_date ?? "9999"));
  else list.sort((a, b) => (e.direction === "asc" ? 1 : -1) * (a.fi - b.fi) || a.tail.localeCompare(b.tail));
  if (!list.length) return notFound(ctx, `fatigue projections${scopeLabel(ctx)}`);
  const flagged = list.filter((a) => a.fatigue!.flagged_before_withdrawal);
  const lead = list[0];
  const text =
    `${byDate ? "Earliest projected FI 100" : e.direction === "asc" ? "Lowest fatigue index" : "Highest fatigue index"}${scopeLabel(ctx)}: ${lead.tail}, FI ${fn(lead.fi, 1)}, projected FI 100 on ${fd(lead.fatigue!.projected_fi100_date)}. ` +
    (flagged.length
      ? `${plural(flagged.length, "aircraft", "aircraft")} projected to reach FI 100 before the planned withdrawal year: ${flagged.map((a) => `${a.tail} (${fd(a.fatigue!.projected_fi100_date)})`).join(", ")}.`
      : "No aircraft is projected to reach FI 100 before its planned withdrawal year.");
  return {
    intent: "fatigue",
    text,
    table: {
      columns: ["Aircraft", "Type", "FI", "FI per FH", "Heavy mission share", "Projected FI 100", "Withdrawal", "Before withdrawal"],
      rows: list.map((a) => [
        a.tail,
        a.type_name ?? "",
        fn(a.fi, 1),
        fn(a.fatigue!.fi_per_fh, 4),
        `${pct(a.fatigue!.heavy_mission_share_trailing ?? a.fatigue!.acm_share_trailing)} ${lcName(a.fatigue!.heavy_mission ?? "Air combat manoeuvring")}`,
        fd(a.fatigue!.projected_fi100_date),
        a.planned_withdrawal_year,
        a.fatigue!.flagged_before_withdrawal ? "Yes" : "No",
      ]),
      links: list.map((a) => `/aircraft/${a.tail}`),
    },
    sources: sources([...flagged.map((a) => kb.byId.get(`pattern:fatigue:${a.tail}`)), kb.aircraft(lead.tail)]),
    followups: [`What is the fatigue projection for ${lead.tail}?`, `How many sorties did ${lead.tail} fly in the last 12 months?`],
  };
}

export function composeReliability(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  const parts = kb.docs<PartFacts>("part");
  // Lot questions.
  if (e.lots.length) {
    const lot = e.lots[0];
    const pdocs = kb.docs<PatternFacts>("pattern").filter((d) => d.facts!.kind === "lot" && d.facts!.lot === lot);
    if (!pdocs.length) return notFound(ctx, `lot ${lot}`);
    const l = pdocs[0].facts! as PatternFacts & { part_number: string; name: string; n_units: number; events: number; exposure_fh: number; rate_per_1000fh: number; rest_of_fleet_rate_per_1000fh: number; p_value_bonferroni: number; flagged: boolean };
    const inService = kb.facts<ComponentFacts>("component").filter((c) => c.lot === lot).sort((a, b) => (b.risk?.prob_fail_before_next_phase ?? 0) - (a.risk?.prob_fail_before_next_phase ?? 0));
    const recs = openRecs(ctx).filter((r) => r.title.includes(lot) || r.evidence.some((ev) => ev.text.includes(lot)));
    const text =
      `Lot ${lot} (${lcName(l.name)}, ${l.part_number}): ${plural(l.n_units, "unit")} over the data window, ${plural(l.events, "confirmed failure")} in ${fn(l.exposure_fh, 1)} FH, ` +
      `${fn(l.rate_per_1000fh, 2)} failures per 1,000 FH against ${fn(l.rest_of_fleet_rate_per_1000fh, 2)} for the rest of the fleet. ` +
      `Exact binomial test on failures given exposure, Bonferroni corrected across lots: p=${fn(l.p_value_bonferroni, 4)}, ` +
      (l.flagged ? "flagged as a significant excess." : "not flagged.") +
      ` ${plural(inService.length, "unit")} from this lot ${inService.length === 1 ? "is" : "are"} in service now; ${plural(recs.length, "open recommendation")} cite the lot.`;
    return {
      intent: "reliability",
      text,
      table: inService.length
        ? {
            columns: ["Aircraft", "Serial", "FH since install", "Failure probability before phase", "FH to threshold"],
            rows: inService.map((c) => [c.tail, c.serial, fn(c.risk?.fh_exposure, 1), pct(c.risk?.prob_fail_before_next_phase), fn(c.risk?.fh_to_tau)]),
            links: inService.map((c) => `/components/${c.serial}`),
          }
        : undefined,
      sources: sources([pdocs[0], kb.byId.get(`part:${l.part_number}`), ...recs.slice(0, 3).map((r) => kb.byId.get(`rec:${r.id}`))]),
      followups: ["Show open recommendations for the hydraulic pump", "What is the MTBF of the hydraulic pump?"],
    };
  }
  // Environmental effect.
  if (/\b(hot|climate|environment\w*|temperature|base b)\b/.test(q) && !e.tails.length) {
    let env = kb.docs<PatternFacts>("pattern").filter((d) => d.facts!.kind === "environment");
    const pns = pnFilter(ctx);
    if (pns) env = env.filter((d) => pns.has(String(d.facts!.part_number)));
    const flagged = env.filter((d) => d.facts!.flagged);
    return {
      intent: "reliability",
      text:
        `Hot-climate effect from the Weibull AFT hot_share covariate, tested for ${plural(env.length, "part number")} with enough events: ` +
        (flagged.length ? `${plural(flagged.length, "effect")} significant at p < 0.01 (${flagged.map((d) => d.facts!.name).join(", ")}).` : "none is significant at p < 0.01, so the models do not confirm a hot-climate acceleration on this data.") +
        " A time ratio below 1 means shorter expected life at full hot-base exposure.",
      table: {
        columns: ["Component", "Part number", "Time ratio at full hot exposure", "p value", "Flagged"],
        rows: env.map((d) => [String(d.facts!.name), String(d.facts!.part_number), `x${fn(Number(d.facts!.time_ratio_full_hot_exposure), 2)}`, fn(Number(d.facts!.p_value), 4), d.facts!.flagged ? "Yes" : "No"]),
      },
      sources: sources(env.slice(0, 4), [{ title: "Reliability", href: "/reliability" }]),
      followups: ["Why is lot L-2207 flagged?", "Which part has the highest failure rate?"],
    };
  }
  // A specific part.
  const pns = pnFilter(ctx);
  if (pns && pns.size >= 1 && !/\b(which|highest|lowest|rank|most|least|worst|best)\b/.test(q)) {
    const docs = parts.filter((d) => pns.has(d.facts!.part_number));
    if (!docs.length) return notFound(ctx, Array.from(pns).join(", "));
    if (docs.length > 1) {
      const list = docs.map((d) => d.facts!);
      const typeName = (p: PartFacts) => kb.typeInfo((p as PartFacts & { type?: TypeKey }).type as TypeKey)?.name ?? "";
      return {
        intent: "reliability",
        text:
          `${plural(list.length, "part number")}${scopeLabel(ctx)}, one per aircraft type: ` +
          list.map((p) => `${p.part_number} (${lower(typeName(p))}) ${p.mtbf_fh ? `MTBF ${fn(p.mtbf_fh)} FH` : "MTBF not defined (no confirmed failures)"}, NFF rate ${pct(p.nff_rate, 1)}`).join("; ") + ".",
        table: {
          columns: ["Part number", "Type", "Component", "Confirmed failures", "Failures per 1,000 FH", "MTBF (FH)", "MTBUR (FH)", "NFF rate"],
          rows: list.map((p) => [p.part_number, typeName(p), p.component, p.confirmed_failures ?? "", fn(p.rate_per_1000fh, 3), p.mtbf_fh ? fn(p.mtbf_fh) : "Not defined", p.mtbur_fh ? fn(p.mtbur_fh) : "Not defined", pct(p.nff_rate, 1)]),
        },
        sources: sources(docs, [{ title: "Reliability", href: "/reliability" }]),
        followups: [`Show removals of the ${lcName(list[0].component)}`, `Which ${lcName(list[0].component)} units have the highest risk?`],
      };
    }
    const p = docs[0].facts!;
    let text = `${p.component} (${p.part_number}, ATA ${p.ata}, ${p.concept}): ${plural(p.confirmed_failures ?? 0, "confirmed failure")} over ${fn(p.fh_exposure)} FH exposure, ${fn(p.rate_per_1000fh, 3)} per 1,000 FH. `;
    text += p.mtbf_fh ? `MTBF ${fn(p.mtbf_fh)} FH, ` : "MTBF not defined (no confirmed failures), ";
    text += p.mtbur_fh ? `MTBUR ${fn(p.mtbur_fh)} FH, ` : "MTBUR not defined, ";
    text += `NFF rate ${pct(p.nff_rate, 1)}.`;
    const bullets: string[] = [];
    if (Object.keys(p.removals_by_reason).length) bullets.push(`Removals by reason: ${Object.entries(p.removals_by_reason).map(([r, n]) => `${r} ${n}`).join(", ")}.`);
    for (const l of p.lots) bullets.push(`Lot ${l.lot}: ${plural(l.events, "failure")}, ${fn(l.rate_per_1000fh, 2)} per 1,000 FH vs ${fn(l.rest_rate, 2)} rest of fleet, p=${fn(l.p_value, 4)}${l.flagged ? ", flagged" : ""}.`);
    if (p.env) bullets.push(`Hot-climate time ratio x${fn(p.env.time_ratio, 2)}, p=${fn(p.env.p_value, 4)}${p.env.flagged ? ", flagged" : ", not significant"}.`);
    if (p.ht_limits.length) bullets.push(`Hard-time limits: ${p.ht_limits.join(" or ")}, whichever comes first.`);
    return {
      intent: "reliability",
      text,
      bullets,
      sources: sources([docs[0]], [{ title: "Reliability", href: "/reliability" }]),
      followups: [`Show removals of the ${lcName(p.component)}`, `Which ${lcName(p.component)} units have the highest risk?`],
      context: { partNumber: p.part_number },
    };
  }
  // Fleet ranking across part numbers.
  const metric: { key: "nff_rate" | "mtbf_fh" | "mtbur_fh" | "rate_per_1000fh"; label: string } = /\bnff\b/.test(q)
    ? { key: "nff_rate", label: "NFF rate" }
    : /\bmtbur\b/.test(q)
      ? { key: "mtbur_fh", label: "MTBUR" }
      : /\bmtbf\b/.test(q)
        ? { key: "mtbf_fh", label: "MTBF" }
        : { key: "rate_per_1000fh", label: "confirmed failure rate" };
  const types = scopeTypes(ctx);
  const list = parts
    .map((d) => d.facts!)
    .filter((p) => p[metric.key] !== null && p[metric.key] !== undefined && (!types.length || types.includes((p as PartFacts & { type?: TypeKey }).type as TypeKey)));
  if (!list.length) return notFound(ctx, `${metric.label} values${scopeLabel(ctx)}`);
  let dir = e.direction === "asc" ? 1 : -1;
  if (/\b(least reliable|worst)\b/.test(q) && (metric.key === "mtbf_fh" || metric.key === "mtbur_fh")) dir = 1;
  if (/\b(least reliable|worst)\b/.test(q) && metric.key === "rate_per_1000fh") dir = -1;
  list.sort((a, b) => dir * ((a[metric.key] as number) - (b[metric.key] as number)) || a.part_number.localeCompare(b.part_number));
  const fmt = (p: PartFacts) => (metric.key === "nff_rate" ? pct(p.nff_rate, 1) : metric.key === "rate_per_1000fh" ? `${fn(p.rate_per_1000fh, 3)} per 1,000 FH` : `${fn(p[metric.key] as number)} FH`);
  const lead = list[0];
  return {
    intent: "reliability",
    text: `${dir < 0 ? "Highest" : "Lowest"} ${metric.label}${scopeLabel(ctx)}: ${lead.component} (${lead.part_number}, ${lower(kb.typeInfo((lead as PartFacts & { type?: TypeKey }).type as TypeKey)?.name ?? "")}) at ${fmt(lead)}. Ranked across ${plural(list.length, "part number")} with a defined value.`,
    table: {
      columns: ["Component", "Type", "Part number", "Confirmed failures", "Failures per 1,000 FH", "MTBF (FH)", "MTBUR (FH)", "NFF rate"],
      rows: list.map((p) => [p.component, kb.typeInfo((p as PartFacts & { type?: TypeKey }).type as TypeKey)?.name ?? "", p.part_number, p.confirmed_failures ?? "", fn(p.rate_per_1000fh, 3), p.mtbf_fh ? fn(p.mtbf_fh) : "Not defined", p.mtbur_fh ? fn(p.mtbur_fh) : "Not defined", pct(p.nff_rate, 1)]),
    },
    sources: sources([parts.find((d) => d.facts!.part_number === lead.part_number)], [{ title: "Reliability", href: "/reliability" }]),
    followups: ["Why is lot L-2207 flagged?", "Is there a hot-climate effect on any component?"],
  };
}

// ---------------------------------------------------------------------------
// Fleet level: KPIs, rankings, comparisons, data quality, patterns, models
// ---------------------------------------------------------------------------
export function composeKpi(ctx: Ctx): Answer {
  const { kb } = ctx;
  const doc = kb.byId.get("kpi:fleet") as KDoc<KpiFacts> | undefined;
  const aircraft = kb.facts<AircraftFacts>("aircraft");
  const statusCounts = countBy(aircraft, (a) => a.status);
  let text = "";
  if (doc?.facts) {
    const k = doc.facts;
    const total = Object.values(k.open_recs_by_priority).reduce((a, b) => a + b, 0);
    text =
      `As of ${fd(k.as_of)}: the fleet flew ${fn(k.fleet_fh_12mo)} FH in the last 12 months. Serviceability ${fn(k.serviceability_pct, 1)}%. ` +
      `${plural(total, "open recommendation")} (${breakdown(k.open_recs_by_priority)}). ${plural(k.due_30_days_count, "hard-time item")} due within 30 days. ` +
      `Unscheduled removal rate ${fn(k.unscheduled_removal_rate_per_1000fh, 2)} per 1,000 FH, ${k.unscheduled_removal_rate_delta >= 0 ? "up" : "down"} ${fn(Math.abs(k.unscheduled_removal_rate_delta), 2)} on the prior 12 months.`;
  }
  text += ` Aircraft status: ${["Serviceable", "Monitor", "Action due", "Critical"].map((s) => `${statusCounts[s] ?? 0} ${s.toLowerCase()}`).join(", ")}.`;
  const byType = doc?.facts?.by_type;
  if (byType) {
    text += ` By type: ${Object.entries(byType).map(([t, k]) => `${TYPE_PLURAL[t as TypeKey] ?? t} ${k.aircraft} aircraft, ${fn(k.fleet_fh_12mo)} FH, serviceability ${fn(k.serviceability_pct, 1)}%`).join("; ")}.`;
  }
  const sorted = [...aircraft].filter((a) => inScope(ctx, a.tail)).sort((a, b) => ["Critical", "Action due", "Monitor", "Serviceable"].indexOf(a.status) - ["Critical", "Action due", "Monitor", "Serviceable"].indexOf(b.status) || a.tail.localeCompare(b.tail));
  return {
    intent: "kpi",
    text: text.trim(),
    table: {
      columns: ["Aircraft", "Type", "Base", "Status", "Airframe FH", "FI", "Open recommendations"],
      rows: sorted.map((a) => [a.tail, a.type_name ?? "", a.base, a.status, fn(a.airframe_fh, 1), fn(a.fi, 1), a.open_recs]),
      links: sorted.map((a) => `/aircraft/${a.tail}`),
    },
    sources: sources([doc], [{ title: "Fleet overview", href: "/" }]),
    followups: ["What should we do next?", "Which aircraft are due for hard-time items in the next 30 days?", "Which aircraft has the highest fatigue index?"],
  };
}

const RANK_METRICS: { re: RegExp; key: string; label: string; get: (a: AircraftFacts) => number | null; d: number; unit: string }[] = [
  { re: /\b(open )?rec(ommendation)?s?\b/, key: "open_recs", label: "open recommendations", get: (a) => a.open_recs, d: 0, unit: "" },
  { re: /\bsnags?\b|\bdefects?\b/, key: "open_snags", label: "open snags", get: (a) => a.open_snags, d: 0, unit: "" },
  { re: /\blandings?\b/, key: "landings", label: "landings in the data window", get: (a) => a.landings, d: 0, unit: "" },
  { re: /\bsorties\b/, key: "sorties_12mo", label: "sorties in the last 12 months", get: (a) => a.sorties_12mo, d: 0, unit: "" },
  { re: /\b(flew|flown|flying|utili[sz]ation|last 12 months|last year)\b/, key: "fh_12mo", label: "FH in the last 12 months", get: (a) => a.fh_12mo, d: 1, unit: " FH" },
  { re: /\b(airframe|hours|fh|oldest|youngest|age)\b/, key: "airframe_fh", label: "airframe hours", get: (a) => a.airframe_fh, d: 1, unit: " FH" },
];

export function composeRank(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  if (/\b(oldest|youngest|newest|inducted|induction)\b/.test(q)) {
    const list = [...kb.facts<AircraftFacts>("aircraft")].filter((a) => inScope(ctx, a.tail)).sort((a, b) => a.induction_date.localeCompare(b.induction_date) || a.tail.localeCompare(b.tail));
    if (/\b(youngest|newest)\b/.test(q)) list.reverse();
    const lead = list[0];
    return {
      intent: "rank",
      text: `${/\b(youngest|newest)\b/.test(q) ? "Most recently inducted" : "Earliest inducted"}: ${lead.tail}, inducted ${fd(lead.induction_date)}, ${fn(lead.airframe_fh, 1)} FH on the airframe.`,
      table: { columns: ["Aircraft", "Inducted", "Airframe FH", "Base"], rows: list.map((a) => [a.tail, fd(a.induction_date), fn(a.airframe_fh, 1), a.base]), links: list.map((a) => `/aircraft/${a.tail}`) },
      sources: sources([kb.aircraft(lead.tail)]),
      followups: [`Tell me about ${lead.tail}`],
    };
  }
  const m = RANK_METRICS.find((r) => r.re.test(q));
  if (!m) return composeKpi(ctx);
  const list = kb.facts<AircraftFacts>("aircraft").filter((a) => m.get(a) !== null && inScope(ctx, a.tail));
  const dir = e.direction === "asc" ? 1 : -1;
  list.sort((a, b) => dir * ((m.get(a) as number) - (m.get(b) as number)) || a.tail.localeCompare(b.tail));
  const lead = list[0];
  return {
    intent: "rank",
    text: `${dir < 0 ? "Most" : "Fewest"} ${m.label}${e.types.length ? ` among the ${typesLabel(e.types)}` : ""}: ${lead.tail} with ${fn(m.get(lead), m.d)}${m.unit}. Fleet range ${fn(m.get(list[list.length - 1]), m.d)} to ${fn(m.get(lead), m.d)}${m.unit}.`.replace(/^Most airframe hours/, dir < 0 ? "Highest airframe hours" : "Lowest airframe hours"),
    table: { columns: ["Aircraft", "Type", "Base", "Status", cap(m.label)], rows: list.map((a) => [a.tail, a.type_name ?? "", a.base, a.status, fn(m.get(a), m.d)]), links: list.map((a) => `/aircraft/${a.tail}`) },
    sources: sources([kb.aircraft(lead.tail)], [{ title: "Fleet overview", href: "/" }]),
    followups: [`Tell me about ${lead.tail}`, `What should we do next on ${lead.tail}?`],
  };
}

export function composeCompare(ctx: Ctx): Answer {
  const { kb, e } = ctx;
  const tails = e.tails.slice(0, 4);
  if (tails.length < 2) return tails.length ? composeAircraft(ctx, tails[0]) : composeKpi(ctx);
  const acs = tails.map((t) => kb.aircraft(t)?.facts).filter((a): a is AircraftFacts => !!a);
  const rows: [string, (a: AircraftFacts) => string | number][] = [
    ["Type", (a) => a.type_name ?? ""],
    ["Base", (a) => a.base],
    ["Status", (a) => a.status],
    ["Airframe FH", (a) => fn(a.airframe_fh, 1)],
    ["Fatigue index", (a) => fn(a.fi, 1)],
    ["Projected FI 100", (a) => fd(a.fatigue?.projected_fi100_date)],
    ["FH, last 12 months", (a) => fn(a.fh_12mo, 1)],
    ["Sorties, last 12 months", (a) => a.sorties_12mo],
    ["Heavy mission share, last 12 months", (a) => (a.fatigue ? `${pct(a.fatigue.heavy_mission_share_trailing ?? a.fatigue.acm_share_trailing)} (${lcName(a.fatigue.heavy_mission ?? "Air combat manoeuvring")})` : "not available")],
    ["Open recommendations", (a) => a.open_recs],
    ["Open snags", (a) => a.open_snags],
    ["Engines", (a) => (a.engines ?? []).length],
    ["Headline engine margin (°C)", (a) => (a.engine_trend ? `${fn(a.engine_trend.current_margin_c, 1)} (${a.engine_trend.metric ?? "EGT margin"}${(a.engines ?? []).length > 1 ? `, engine ${a.engine_trend.engine_position}` : ""})` : "not available")],
    ["Headline engine trend (°C per EFH)", (a) => fn(a.engine_trend?.slope_c_per_efh, 3)],
    ["APU hours", (a) => (a.apu_hours === null || a.apu_hours === undefined ? "No APU" : fn(a.apu_hours, 1))],
  ];
  const busiest = [...acs].sort((a, b) => b.fh_12mo - a.fh_12mo)[0];
  const tired = [...acs].sort((a, b) => b.fi - a.fi)[0];
  return {
    intent: "compare",
    text: `Comparing ${acs.map((a) => a.tail).join(", ")}. ${busiest.tail} flew the most in the last 12 months (${fn(busiest.fh_12mo, 1)} FH); ${tired.tail} has the highest fatigue index (${fn(tired.fi, 1)}).`,
    table: { columns: ["Measure", ...acs.map((a) => a.tail)], rows: rows.map(([label, f]) => [label, ...acs.map(f)]) },
    sources: sources(acs.map((a) => kb.aircraft(a.tail))),
    followups: acs.map((a) => `What should we do next on ${a.tail}?`).slice(0, 2),
  };
}

export function composeDataQuality(ctx: Ctx): Answer {
  const docs = ctx.kb.docs<{ check?: string; pass?: boolean; count?: number; detail?: string; issues?: Record<string, number> }>("data_quality");
  const checks = docs.filter((d) => d.facts!.check);
  const issues = docs.find((d) => d.facts!.issues)?.facts!.issues;
  const failed = checks.filter((d) => !d.facts!.pass);
  let text = failed.length ? `${failed.length} of ${checks.length} data quality checks fail.` : `All ${checks.length} data quality checks pass on the silver layer.`;
  if (issues) text += ` Ingestion issues found and resolved from bronze to silver: ${Object.entries(issues).map(([k, v]) => `${k.replace(/_/g, " ")} ${fn(v)}`).join(", ")}.`;
  return {
    intent: "data_quality",
    text,
    table: { columns: ["Check", "Result", "Exceptions"], rows: checks.map((d) => [d.facts!.check!, d.facts!.pass ? "Pass" : "Fail", d.facts!.count ?? 0]) },
    sources: sources(docs.slice(-1), [{ title: "Data and integration", href: "/data" }]),
    followups: ["What did the models find?", "How does the survival model work?"],
  };
}

export function composePatterns(ctx: Ctx): Answer {
  const { kb } = ctx;
  let docs = kb.docs<PatternFacts>("pattern").filter((d) => {
    const f = d.facts!;
    if (f.kind === "lot" || f.kind === "environment") return !!f.flagged;
    return true;
  });
  if (scopeTails(ctx)) docs = docs.filter((d) => d.keys.tail && inScope(ctx, d.keys.tail));
  if (/\boil|chip|precursor|soap\b/.test(ctx.q)) docs = docs.filter((d) => d.facts!.kind.startsWith("oil"));
  if (!docs.length) return { intent: "patterns", text: `No flagged patterns${scopeLabel(ctx)}.`, sources: [], followups: ["What did the models find?"] };
  return {
    intent: "patterns",
    text: `${plural(docs.length, "pattern finding")}${scopeLabel(ctx)} from the detectors (lot comparison, environmental effect, repeat snags and NFF, oil precursor, EGT and ITT trends, fatigue projection):`,
    bullets: docs.map((d) => humanize(d.text)),
    sources: sources(docs.slice(0, 6)),
    followups: ["Why is lot L-2207 flagged?", "What is wrong with TX-404?", "Show the ITT trend for CX-502 engine 3"],
  };
}

export function composeModels(ctx: Ctx): Answer {
  const docs = ctx.kb.docs<Record<string, unknown>>("model");
  const cards = docs.filter((d) => d.id.startsWith("model:"));
  const val = docs.filter((d) => d.id.startsWith("validation:"));
  const asksValidation = /\b(validation|backtest|accura\w*|recover\w*|planted)\b/.test(ctx.q);
  let pick = cards;
  const named = cards.find((d) => {
    const n = String(d.facts!.name).toLowerCase();
    return (/surviv|weibull/.test(ctx.q) && n.includes("survival")) || (/\begt|engine|trend\b/.test(ctx.q) && n.includes("engine")) ||
      (/fatigue/.test(ctx.q) && n.includes("fatigue")) || (/hard ?time|rules?/.test(ctx.q) && n.includes("hard")) || (/pattern|detector/.test(ctx.q) && n.includes("pattern"));
  });
  if (named) pick = [named];
  if (asksValidation) {
    return {
      intent: "models",
      text: val.length
        ? `Validation in this export: ${val.filter((d) => d.facts!.detected).length} of ${val.length} planted patterns recovered.`
        : "Validation results are not in the current export. The model cards below describe each model and its known limits.",
      table: val.length ? { columns: ["Pattern", "Detector", "Statistic", "Recovered"], rows: val.map((d) => [String(d.facts!.title), String(d.facts!.detector), String(d.facts!.statistic), d.facts!.detected ? "Yes" : "No"]) } : undefined,
      bullets: val.length ? [] : cards.map((d) => `${d.facts!.name}: ${d.facts!.limits}`),
      sources: [{ title: "Models and validation", href: "/models" }],
      followups: ["What did the models find?"],
    };
  }
  return {
    intent: "models",
    text: pick.length === 1 ? humanize(pick[0].text) : `PRE uses ${plural(pick.length, "model")}: ${pick.map((d) => String(d.facts!.name).toLowerCase()).join(", ")}. All text is template based; there is no language model.`,
    bullets: pick.length === 1 ? [] : pick.map((d) => `${d.facts!.name}: ${d.facts!.method}.`),
    sources: sources(pick, [{ title: "Models and validation", href: "/models" }]),
    followups: ["How does the survival model work?", "What did the models find?"],
  };
}

// ---------------------------------------------------------------------------
// Aircraft types (mixed fleet), operating hours, task cards
// ---------------------------------------------------------------------------
export function composeFleetType(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  const docs = kb.docs<FleetTypeFacts>("fleet_type");
  const picked = e.types.length ? docs.filter((d) => e.types.includes(d.facts!.type)) : docs;
  if (!picked.length) return notFound(ctx, "aircraft type records");
  const compare = picked.length > 1 || /\bcompare|comparison|versus|vs\b|\bby (aircraft )?type\b|\bper type\b|\beach type\b/.test(q);
  if (!compare) {
    const d = picked[0];
    const f = d.facts!;
    const acs = kb.facts<AircraftFacts>("aircraft").filter((a) => a.type === f.type).sort((a, b) => a.tail.localeCompare(b.tail));
    const status = countBy(acs, (a) => a.status);
    const findings = kb.docs<PatternFacts>("pattern").filter((p) => p.keys.tail && f.tails.includes(p.keys.tail));
    const plural_ = TYPE_PLURAL[f.type];
    const text =
      `${cap(plural_)} (${lower(f.role)}): ${plural(f.tails.length, "aircraft", "aircraft")}, ${f.tails[0]} to ${f.tails[f.tails.length - 1]}, ` +
      `${plural(f.engines, "engine")} each, engine health by ${f.metric}${f.metric_threshold_c !== null && f.metric_threshold_c !== undefined ? ` (limit ${fn(f.metric_threshold_c)} °C)` : ""}. ` +
      `Last 12 months: ${fn(f.fh_12mo, 1)} FH over ${plural(f.sorties_12mo, "sortie")}` +
      (f.kpis ? `, serviceability ${fn(f.kpis.serviceability_pct, 1)}%, unscheduled removal rate ${fn(f.kpis.unscheduled_removal_rate_per_1000fh, 2)} per 1,000 FH` : "") +
      `. ${plural(f.open_recs, "open recommendation")} (${breakdown(f.open_recs_by_priority)}). ` +
      `Aircraft status: ${["Serviceable", "Monitor", "Action due", "Critical"].map((s) => `${status[s] ?? 0} ${s.toLowerCase()}`).join(", ")}.`;
    const mix = Object.entries(f.mission_fh_12mo).sort((a, b) => b[1] - a[1]);
    const bullets = [
      ...(mix.length ? [`Mission mix, last 12 months: ${mix.map(([m, fh]) => `${lcName(m)} ${fn(fh, 1)} FH`).join(", ")}.`] : []),
      ...(f.fatigue_model ? [`Fatigue model: ${f.fatigue_model}.`] : []),
      ...findings.map((p) => humanize(p.text)),
    ];
    return {
      intent: "fleet_type",
      text,
      bullets,
      table: {
        columns: ["Aircraft", "Base", "Status", "Airframe FH", "FH, last 12 months", "FI", "Open recommendations"],
        rows: acs.map((a) => [a.tail, a.base, a.status, fn(a.airframe_fh, 1), fn(a.fh_12mo, 1), fn(a.fi, 1), a.open_recs]),
        links: acs.map((a) => `/aircraft/${a.tail}`),
      },
      sources: sources([d, kb.byId.get("kpi:fleet"), ...findings.slice(0, 3)]),
      followups: [`What should we do next on the ${plural_}?`, `How many sorties did the ${plural_} fly last month?`, `Which of the ${plural_} has the highest fatigue index?`],
    };
  }
  const fs = picked.map((d) => d.facts!);
  const perAc = (f: FleetTypeFacts) => (f.tails.length ? f.fh_12mo / f.tails.length / 12 : 0);
  const rows: [string, (f: FleetTypeFacts) => string | number][] = [
    ["Aircraft", (f) => f.tails.length],
    ["Engines per aircraft", (f) => f.engines],
    ["Engine health metric", (f) => f.metric],
    ["FH, last 12 months", (f) => fn(f.fh_12mo, 1)],
    ["Sorties, last 12 months", (f) => fn(f.sorties_12mo)],
    ["FH per aircraft per month", (f) => fn(perAc(f), 1)],
    ["Average sortie length (FH)", (f) => fn(f.sorties_12mo ? f.fh_12mo / f.sorties_12mo : 0, 2)],
    ["Serviceability", (f) => (f.kpis ? `${fn(f.kpis.serviceability_pct, 1)}%` : "not available")],
    ["Hard-time items due in 30 days", (f) => f.kpis?.due_30_days_count ?? "not available"],
    ["Unscheduled removals per 1,000 FH", (f) => (f.kpis ? fn(f.kpis.unscheduled_removal_rate_per_1000fh, 2) : "not available")],
    ["Open recommendations", (f) => f.open_recs],
    ["Critical or high", (f) => (f.open_recs_by_priority.Critical ?? 0) + (f.open_recs_by_priority.High ?? 0)],
  ];
  const busiest = [...fs].sort((a, b) => perAc(b) - perAc(a))[0];
  const withK = fs.filter((f) => f.kpis);
  const lowest = [...withK].sort((a, b) => a.kpis!.serviceability_pct - b.kpis!.serviceability_pct)[0];
  const worstRate = [...withK].sort((a, b) => b.kpis!.unscheduled_removal_rate_per_1000fh - a.kpis!.unscheduled_removal_rate_per_1000fh)[0];
  let text = `Comparing ${fs.map((f) => TYPE_PLURAL[f.type]).join(", ")} over the last 12 months. ` +
    `Highest utilisation per aircraft: ${TYPE_PLURAL[busiest.type]} at ${fn(perAc(busiest), 1)} FH per aircraft per month.`;
  if (lowest) text += ` Lowest serviceability: ${TYPE_PLURAL[lowest.type]} at ${fn(lowest.kpis!.serviceability_pct, 1)}%.`;
  if (worstRate) text += ` Highest unscheduled removal rate: ${TYPE_PLURAL[worstRate.type]} at ${fn(worstRate.kpis!.unscheduled_removal_rate_per_1000fh, 2)} per 1,000 FH.`;
  return {
    intent: "fleet_type",
    text,
    table: { columns: ["Measure", ...fs.map((f) => f.name)], rows: rows.map(([label, g]) => [label, ...fs.map(g)]) },
    sources: sources([...picked, kb.byId.get("kpi:fleet")]),
    followups: fs.map((f) => `How are the ${TYPE_PLURAL[f.type]} doing?`).slice(0, 3),
  };
}

function groundRuns(ctx: Ctx, tail: string): GroundRunFacts["rows"] {
  return ((ctx.kb.byId.get(`groundruns:${tail}`)?.facts as GroundRunFacts | undefined)?.rows ?? []) as GroundRunFacts["rows"];
}

export async function composeOperating(ctx: Ctx): Promise<Answer> {
  const { kb, e, q } = ctx;
  const wantsApu = /\bapu\b|\bauxiliary power\b/.test(q);
  const wantsRuns = /\bground runs?\b|\bengine runs?\b|\brun ups?\b/.test(q);
  const tails = scopeTails(ctx) ?? kb.tails;
  // One aircraft, whole data window: the exported totals and every engine.
  if (e.tails.length === 1 && !e.window) {
    const tail = e.tails[0];
    const doc = kb.aircraft(tail);
    const a = doc?.facts;
    if (!a) return notFound(ctx, tail);
    const op = a.operating_hours;
    const runs = groundRuns(ctx, tail);
    const multi = (a.engines ?? []).length > 1;
    let text = op
      ? `${tail} (${lower(a.type_name ?? "aircraft")}) since ${fd(op.window_start)}: ${fn(op.flight_hours, 1)} FH flown, plus ${fn(op.taxi_hours, 1)} taxi hours and ` +
        `${plural(op.ground_runs ?? 0, "engine ground run")} (${fn(op.ground_run_hours, 1)} hours) of engine running on the ground. ` +
        (a.apu_hours !== null && a.apu_hours !== undefined ? `APU ${fn(a.apu_hours, 1)} APU hours.` : "No APU is fitted to this type.")
      : `No operating hours summary is exported for ${tail}.`;
    if ((a.engines ?? []).length) {
      text += ` Engine operating hours run ahead of EFH by the taxi and ground running while each engine was installed: ` +
        (a.engines ?? []).map((x) => `${multi ? `engine ${x.position} ` : "engine "}${x.serial} ${fn(x.efh, 1)} EFH, ${fn(x.operating_hours, 1)} operating hours`).join("; ") + ".";
    }
    const recent = [...runs].sort((x, y) => y[1].localeCompare(x[1]) || y[0].localeCompare(x[0]));
    const table: AnswerTable = wantsRuns
      ? {
          columns: ["Run", "Date", "Engine", "Hours", "APU hours", "Reason"],
          rows: recent.slice(0, 20).map((r) => [r[0], fd(r[1]), r[2] === "All" ? "All engines" : r[2], fn(r[3], 2), fn(r[4], 2), r[5]]),
        }
      : {
          columns: ["Engine", "Serial", "EFH", "Operating hours", "Ground-run hours"],
          rows: (a.engines ?? []).map((x) => [x.position, x.serial, fn(x.efh, 1), fn(x.operating_hours, 1), fn(x.ground_run_hours, 1)]),
        };
    const bullets = recent.slice(0, wantsRuns ? 0 : 3).map((r) => `Ground run ${r[0]} on ${fd(r[1])}: ${r[2] === "All" ? "all engines" : `engine ${r[2]}`}, ${fn(r[3], 2)} hours, ${lower(r[5])}.`);
    return {
      intent: "operating",
      text,
      bullets,
      table,
      sources: sources([doc, kb.byId.get(`groundruns:${tail}`)]),
      followups: tailFollowups(ctx, tail, "operating"),
      context: { tail },
    };
  }
  // A window or several aircraft: exact sums from every sortie and ground run.
  const sorties = (await kb.allSorties(tails)).filter((s) => inWindow(s.date, e.window));
  const rows = tails.map((t) => {
    const list = sorties.filter((s) => s.tail === t);
    const runs = groundRuns(ctx, t).filter((r) => inWindow(r[1], e.window));
    const apuFitted = !!kb.typeInfo(kb.typeOfTail.get(t) as TypeKey)?.apu;
    return {
      t,
      fh: list.reduce((n, s) => n + s.duration, 0),
      taxi: list.reduce((n, s) => n + s.taxi, 0),
      runs: runs.length,
      runHours: runs.reduce((n, r) => n + r[3], 0),
      apu: apuFitted ? list.reduce((n, s) => n + s.apu, 0) + runs.reduce((n, r) => n + r[4], 0) : null,
    };
  });
  const sum = (k: "fh" | "taxi" | "runs" | "runHours") => rows.reduce((n, r) => n + r[k], 0);
  const apuRows = rows.filter((r) => r.apu !== null);
  const apuTotal = apuRows.reduce((n, r) => n + (r.apu ?? 0), 0);
  const subject = e.tails.length ? e.tails.join(" and ") : e.types.length ? `The ${typesLabel(e.types)}` : "The fleet";
  const windowLabel = e.window ? `${e.window.label} (${fd(e.window.from)} to ${fd(e.window.to)})` : "the data window";
  let text = `${subject} in ${windowLabel}: ${fn(sum("fh"), 1)} FH flown, ${fn(sum("taxi"), 1)} taxi hours, ${plural(sum("runs"), "engine ground run")} (${fn(sum("runHours"), 1)} hours).`;
  if (apuRows.length) text += ` APU: ${fn(apuTotal, 1)} APU hours across ${plural(apuRows.length, "aircraft", "aircraft")} with an APU.`;
  else if (wantsApu) text += " No APU is fitted to the aircraft in scope (fighters have none).";
  if (rows.length > 1) {
    const key = wantsApu && apuRows.length ? "apu" : wantsRuns ? "runs" : "fh";
    const ranked = [...rows].filter((r) => r[key] !== null).sort((x, y) => (e.direction === "asc" ? 1 : -1) * ((x[key] as number) - (y[key] as number)) || x.t.localeCompare(y.t));
    const lead = ranked[0];
    if (lead) text += ` ${e.direction === "asc" ? "Least" : "Most"} ${key === "apu" ? "APU hours" : key === "runs" ? "ground runs" : "flying"}: ${lead.t} (${key === "runs" ? plural(lead.runs, "run") : `${fn(lead[key] as number, 1)} ${key === "apu" ? "APU hours" : "FH"}`}).`;
    rows.sort((x, y) => (ranked.indexOf(x) === -1 ? 999 : ranked.indexOf(x)) - (ranked.indexOf(y) === -1 ? 999 : ranked.indexOf(y)));
  }
  return {
    intent: "operating",
    text,
    table: {
      columns: ["Aircraft", "FH", "Taxi hours", "Ground runs", "Ground-run hours", "APU hours"],
      rows: rows.map((r) => [r.t, fn(r.fh, 1), fn(r.taxi, 1), r.runs, fn(r.runHours, 1), r.apu === null ? "No APU" : fn(r.apu, 1)]),
      links: rows.map((r) => `/aircraft/${r.t}`),
    },
    sources: sources(tails.slice(0, 3).flatMap((t) => [kb.aircraft(t), kb.byId.get(`groundruns:${t}`)])),
    followups: e.tails.length === 1 ? tailFollowups(ctx, e.tails[0], "operating") : ["Which airlifter logged the most APU hours last month?", "Compare utilisation by aircraft type"],
    context: e.tails.length === 1 ? { tail: e.tails[0] } : undefined,
  };
}

const TASK_TYPE_WORDS: [string, RegExp][] = [
  ["Replace", /\b(replace\w*|chang(e|ing)|remov(e|al)|swap)\b/],
  ["Inspect", /\b(inspect\w*|check\w*|examin\w*)\b/],
  ["Troubleshoot", /\btroubleshoot\w*|\bfault find\w*/],
  ["Borescope", /\bborescope\b/],
  ["Sample", /\bsoap\b|\bsample\b/],
];

export function composeTaskCard(ctx: Ctx): Answer {
  const { kb, e, q } = ctx;
  const all = kb.docs<TaskCardFacts>("task_card");
  const describe = (c: TaskCardFacts) =>
    `${c.task_card}: ${c.title}. ATA ${c.ata}, applies to the ${c.types.map((t) => TYPE_PLURAL[t] ?? t).join(", ")}. ` +
    `Task type ${lower(c.task_type)}, standard ${fn(c.man_hours, 1)} man-hours (elapsed ${fn(c.elapsed_hours, 1)} hours), interval ${lower(c.interval)}. Reference ${c.reference}.`;
  if (e.taskCards.length) {
    const d = all.find((x) => x.facts!.task_card === e.taskCards[0]);
    if (!d) return notFound(ctx, `task card ${e.taskCards[0]}`);
    const c = d.facts!;
    const recs = sortRecs(openRecs(ctx).filter((r) => r.task_card === c.task_card));
    const tasks = planTasks(ctx).filter((t) => (t as PlanTaskFacts & { task_card?: string }).task_card === c.task_card).sort(taskSort);
    const bullets = [
      ...recs.map((r) => `Cited by ${r.id} (${r.priority.toLowerCase()}): ${humanize(r.title)}.`),
      ...tasks.map((t) => `Planned as ${t.id} on ${t.tail ?? "the fleet"}, ${fd(t.planned_date)}.`),
    ];
    return {
      intent: "task_card",
      text: describe(c),
      bullets,
      sources: sources([d, ...recs.slice(0, 3).map((r) => kb.byId.get(`rec:${r.id}`))]),
      followups: c.part_number ? [`What is the MTBF of the ${lcName(kb.componentByPn(c.part_number)?.name ?? "component")}?`] : [],
    };
  }
  let cards = all;
  const pns = pnFilter(ctx);
  if (pns) cards = cards.filter((d) => d.facts!.part_number && pns.has(d.facts!.part_number));
  else if (e.atas.length) cards = cards.filter((d) => e.atas.includes(d.facts!.ata));
  const types = scopeTypes(ctx);
  if (types.length) cards = cards.filter((d) => d.facts!.types.some((t) => types.includes(t)));
  const wanted = TASK_TYPE_WORDS.filter(([, re]) => re.test(q)).map(([t]) => t);
  if (wanted.length) {
    const narrowed = cards.filter((d) => wanted.includes(d.facts!.task_type));
    if (narrowed.length) cards = narrowed;
  }
  if (!pns && !e.atas.length && !types.length && !wanted.length) {
    const byType = countBy(all, (d) => d.facts!.task_type);
    return {
      intent: "task_card",
      text: `The approved procedures hold ${plural(all.length, "task card")}: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${lower(t)}`).join(", ")}. Name a component, part number, aircraft or task card id to look one up.`,
      sources: [{ title: "Data and integration", href: "/data" }],
      followups: ["What task card covers the cabin outflow valve?", "How long does it take to replace the APU on a transport?"],
    };
  }
  if (!cards.length) return { intent: "task_card", text: `No task card${scopeLabel(ctx)} matches.`, sources: [], followups: [] };
  cards = [...cards].sort((a, b) => a.facts!.task_card.localeCompare(b.facts!.task_card));
  const first = cards[0].facts!;
  const text = cards.length === 1
    ? describe(first)
    : `${plural(cards.length, "task card")}${scopeLabel(ctx)}. ${describe(first)}`;
  return {
    intent: "task_card",
    text,
    table: cards.length > 1
      ? {
          columns: ["Task card", "Title", "Applies to", "Task", "Man-hours", "Elapsed (hours)", "Interval", "Reference"],
          rows: cards.map((d) => {
            const c = d.facts!;
            return [c.task_card, c.title, c.types.map((t) => TYPE_PLURAL[t] ?? t).join(", "), c.task_type, fn(c.man_hours, 1), fn(c.elapsed_hours, 1), c.interval, c.reference];
          }),
        }
      : undefined,
    sources: sources(cards.slice(0, 4)),
    followups: [`Which recommendations cite ${first.task_card}?`],
  };
}

// ---------------------------------------------------------------------------
// Fallback retrieval
// ---------------------------------------------------------------------------
export function notFound(ctx: Ctx, what: string): Answer {
  return {
    intent: "fallback",
    text: `I could not find ${what} in the records.`,
    sources: [],
    followups: ["What can you answer?"],
  };
}

export function composeFallback(ctx: Ctx): Answer {
  const { kb, e, question } = ctx;
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/\d/.test(w));
  const unknown = words.filter((w) => {
    const toks = w.length ? [w] : [];
    return toks.every((t) => !kb.index.has(t) && !kb.index.has(t.replace(/s$/, "")) && !kb.index.has(t.replace(/(ing|ed)$/, "")));
  }).filter((w) => !["what", "which", "show", "tell", "about", "many", "much", "does", "have", "there", "please", "give", "know", "when", "where", "will", "would", "could", "should"].includes(w));
  const hasEntities = e.tails.length || e.serials.length || e.partNumbers.length || e.lots.length || e.componentKeys.length;
  const hits = kb.index.search(question, {
    limit: 5,
    filter: hasEntities
      ? (d) => (!e.tails.length || (!!d.keys.tail && e.tails.includes(d.keys.tail))) && (!e.serials.length || (!!d.keys.serial && e.serials.includes(d.keys.serial)))
      : undefined,
  });
  const passages = hits.map((h) => ({ title: h.doc.title, text: h.doc.text, href: h.doc.href }));
  if (!hits.length) {
    return {
      intent: "fallback",
      text: `I could not find anything in the records that matches "${question.trim()}". Try naming an aircraft (for example FX-307, TX-404 or CX-502), an aircraft type, a serial, a part number, a task card, or a topic such as snags, sorties, EGT or ITT trends, operating hours, fatigue, lots or recommendations.`,
      sources: [],
      followups: EXAMPLE_QUESTIONS.slice(0, 3),
    };
  }
  const lead = unknown.length
    ? `I could not find ${unknown.map((w) => `"${w}"`).join(", ")} in the records, so there is no direct answer. Closest matches in the records:`
    : "I did not recognise a specific question type, so here are the closest matches in the records:";
  return {
    intent: "fallback",
    text: lead,
    passages,
    sources: sources(hits.map((h) => h.doc)),
    followups: EXAMPLE_QUESTIONS.slice(0, 3),
  };
}

