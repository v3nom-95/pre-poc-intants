// Rule-based entity extraction. Every relative date is resolved against the
// corpus as-of date (15 Nov 2026), never the system clock.
import { normalise } from "./text";
import type { KnowledgeBase } from "./knowledge";
import type { Priority } from "@/lib/domain-types";
import type { TypeKey } from "./types";

export interface DateWindow {
  from: string; // inclusive ISO date
  to: string; // inclusive ISO date
  label: string;
}

export interface Entities {
  tails: string[];
  serials: string[];
  partNumbers: string[];
  recIds: string[];
  taskIds: string[];
  sortieIds: string[];
  lots: string[];
  atas: string[];
  componentKeys: string[];
  missions: string[];
  bases: string[];
  priorities: Priority[];
  statuses: string[];
  actions: string[];
  reasons: string[];
  recordTypes: string[];
  /** Aircraft types named in the question (fighter, transport, airlifter). */
  types: TypeKey[];
  /** Engine positions named ("engine 3", "no 3 engine"), as "1" to "4". */
  enginePositions: string[];
  /** Task card ids (TC-21-03-01). */
  taskCards: string[];
  /** "EGT margin" or "ITT margin" when the question names a metric. */
  metric?: string;
  glossaryTerm?: string;
  /** Identifier-shaped tokens that match no record (for an honest not-found). */
  unknownIds: string[];
  window?: DateWindow;
  horizonDays?: number;
  horizonLabel?: string;
  latest: boolean;
  limit?: number;
  direction?: "desc" | "asc";
}

// Component families: one phrase can name the same kind of unit on several
// aircraft types (for example "generator" is GEN-MAIN on the fighter, TR-GEN
// on the transport and AL-GEN on the airlifter). Longer phrases come first so
// they are consumed before their shorter parts ("ELT battery" before
// "battery", "propeller control unit" before "propeller").
const COMPONENT_FAMILIES: [string[], RegExp][] = [
  [["TR-PCU", "AL-PCU"], /\bprop(eller)? control units?\b|\bpcus?\b|\bprop(eller)? governors?\b|\bpitch control( units?)?\b/],
  [["TR-ELT", "AL-ELT"], /\b(elt|emergency locator( transmitter)?|emergency beacon)( batter(y|ies))?\b/],
  [["TR-CPC", "AL-CPC"], /\bcabin pressure controllers?\b|\bpressuri[sz]ation controllers?\b|\bcpcs?\b/],
  [["TR-OFV", "AL-OFV"], /\b(cabin )?outflow valves?\b|\bofvs?\b/],
  [["TR-WXR", "AL-WXR"], /\bweather radars?\b|\bwx radars?\b|\bwxrs?\b/],
  [["TR-FDR", "AL-FDR"], /\bflight data recorders?\b|\bfdrs?\b|\bblack box(es)?\b/],
  [["TR-APU", "AL-APU"], /\bauxiliary power units?\b|\bapus?\b/],
  [["AL-RAMP-ACT"], /\b(cargo )?ramp( actuators?)?\b/],
  [["TR-NLG", "AL-NLG"], /\bnose (landing )?gears?( assembl(y|ies))?\b|\bnlg\b/],
  [["FCU", "TR-FCU", "AL-FCU"], /\b(engine )?fuel control units?\b|\bfcus?\b/],
  [["OIL-PUMP", "TR-OIL-PUMP", "AL-OIL-PUMP"], /\b(engine )?lube( oil)? pumps?\b|\boil pumps?\b/],
  [["FUEL-BOOST", "TR-FUEL-BOOST", "AL-FUEL-BOOST"], /\bfuel boost pumps?\b|\bboost pumps?\b/],
  [["HYD-PUMP", "TR-HYD-PUMP", "AL-HYD-PUMP"], /\b(engine driven )?hydraulic pumps?\b|\bhyd pumps?\b|\bedps?\b/],
  [["HPT"], /\bhpt( module)?s?\b|\bturbine discs?\b|\bllps?\b/],
  [["ECS-COOL", "TR-ECS-PACK", "AL-ECS-PACK"], /\becs( cooling turbines?| packs?)?\b|\bcooling turbines?\b|\bair cycle machines?\b|\bair conditioning packs?\b/],
  [["GEN-MAIN", "TR-GEN", "AL-GEN"], /\b(main |engine driven )?generators?\b/],
  [["BATT-MAIN", "TR-BATT", "AL-BATT"], /\b(main )?batter(y|ies)\b/],
  [["CADPAD"], /\bcad ?pad\b|\bejection seats?\b|\bpyrotechnics?\b/],
  [["STAB-ACT"], /\bstabilator( actuators?)?\b|\bstab actuators?\b/],
  [["FCC"], /\bflight control computers?\b|\bfccs?\b/],
  [["MLG", "TR-MLG", "AL-MLG"], /\b(main )?landing gears?( assembl(y|ies))?\b|\bmain gears?\b|\bmlg\b|\bundercarriage\b|\bgear assembl(y|ies)\b/],
  [["BRAKE", "TR-BRAKE", "AL-BRAKE"], /\b(wheel )?brakes?\b/],
  [["TYRE", "TR-TYRE", "AL-TYRE"], /\b(wheel )?(tyres?|tires?)\b/],
  [["RADALT", "TR-RADALT", "AL-RADALT"], /\bradar altimeters?\b|\brad ?alts?\b|\bradio altimeters?\b/],
  [["INU"], /\binertial navigation( units?)?\b|\binus?\b/],
  [["JFS"], /\bjet fuel starters?\b|\bjfs\b/],
  [["TR-PROP", "AL-PROP"], /\bpropellers?( assembl(y|ies))?\b|\bprops?\b/],
  [["ENGINE", "TR-ENGINE", "AL-ENGINE"], /\bengines?\b|\bturboprops?\b|\bturbofans?\b/],
];

const MISSION_SYNONYMS: [string, RegExp][] = [
  ["Air combat manoeuvring", /\bair combat( manoeuvring| maneuvering)?\b|\bacm\b/],
  ["Ground attack", /\bground attack\b|\bgat\b/],
  ["Air defence", /\bair defen[cs]e\b|\badf\b/],
  ["General flying", /\bgeneral flying\b|\bcircuits?\b|\btouch and go\b/],
  ["Navigation / ferry", /\bnavigation\b|\bferry\b|\bnav sorties?\b/],
  ["Functional test flight", /\bfunctional test( flights?)?\b|\btest flights?\b|\bftf\b/],
  ["Passenger transport", /\bpassenger( transport)? (sorties|flights|missions)\b|\bpassenger transport\b|\bpax\b/],
  ["Troop and logistics", /\btroop and logistics\b|\blogistics\b|\btroop (sorties|flights|lifts?)\b/],
  ["VIP and communications", /\bvip( and communications)?\b|\bcommunications (sorties|flights)\b/],
  ["Route and circuit training", /\broute( and circuit)? training\b|\bcircuit training\b|\bcircuits?\b|\broute flying\b/],
  ["Medical evacuation", /\bmedical evacuations?\b|\bmedevacs?\b|\bcasevacs?\b/],
  ["Cargo airlift", /\bcargo airlifts?\b|\bairlift (sorties|flights|missions)\b|\bcargo (sorties|flights|runs|missions)\b/],
  ["Air drop", /\bair ?drops?\b|\bpara ?drops?\b|\bparachute drops?\b/],
  ["Tactical low level", /\btactical low level\b|\blow level\b/],
  ["Troop and aeromedical", /\btroop and aeromedical\b|\baeromedical\b|\btroop (sorties|flights|lifts?)\b/],
];

const TYPE_WORDS: [TypeKey, RegExp][] = [
  ["fighter", /\bfighters?\b|\bfast jets?\b|\bcombat (aircraft|jets?|fleet)\b|\bmultirole\b/],
  ["transport", /\b(twin engine )?transports?\b|\bpassenger (aircraft|fleet|planes?)\b|\butility (aircraft|fleet)\b|\btwins\b/],
  ["airlifter", /\b(four engine )?airlifters?\b|\bcargo (aircraft|fleet|planes?|lifters?)\b|\bfreighters?\b|\bheavy lift(ers?)?\b|\bcargo\b/],
];

const ORDINAL: Record<string, string> = { first: "1", second: "2", third: "3", fourth: "4", one: "1", two: "2", three: "3", four: "4" };

const REASONS: [string, RegExp][] = [
  ["Unscheduled: NFF", /\bnff\b|\bno fault found\b/],
  ["Unscheduled: confirmed failure", /\bconfirmed failures?\b|\bfailures?\b|\bfailed\b/],
  ["Scheduled (hard time)", /\bscheduled removals?\b|\bhard time removals?\b/],
  ["Cannibalisation", /\bcannibali[sz](ation|ed)?\b/],
  ["Scheduled (engine change)", /\bengine changes?\b/],
];

const RECORD_TYPES: [string, RegExp][] = [
  ["Phase inspection", /\bphase( inspections?)?\b/],
  ["Periodic servicing", /\bperiodic( servicings?)?\b|\bservicings?\b/],
  ["Rectification", /\brectifications?\b/],
  ["Work order", /\bwork orders?\b/],
  ["Chip detector", /\bchip detectors?\b|\bchip lights?\b/],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";

// ---------------------------------------------------------------------------
// Date helpers (UTC, ISO strings)
// ---------------------------------------------------------------------------
export function isoAdd(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoAddMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function monthEnd(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);
}

function monthStart(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0, 1)).toISOString().slice(0, 10);
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3));
}

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, eighteen: 18, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
};

function num(s: string | undefined): number {
  if (!s) return 1;
  return NUM_WORDS[s] ?? Number(s);
}

const NUM_RE = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|thirty|sixty|ninety)";

function parseWindow(q: string, asOf: string): DateWindow | undefined {
  const [ay, am] = asOf.split("-").map(Number);
  const asOfLabel = asOf;
  let m: RegExpMatchArray | null;

  if ((m = q.match(new RegExp(`\\b(?:last|past|previous|trailing)\\s+${NUM_RE}\\s+(day|week|month|year)s?\\b`)))) {
    const n = num(m[1]);
    const unit = m[2];
    let from: string;
    if (unit === "day") from = isoAdd(asOf, -n + 1);
    else if (unit === "week") from = isoAdd(asOf, -7 * n + 1);
    else if (unit === "month") from = isoAdd(isoAddMonths(asOf, -n), 1);
    else from = isoAdd(isoAddMonths(asOf, -12 * n), 1);
    return { from, to: asOfLabel, label: `the last ${n} ${unit}${n === 1 ? "" : "s"}` };
  }
  if (/\b(?:last|past|previous)\s+(?:12 months|year)\b/.test(q)) {
    return { from: isoAdd(asOf, -364), to: asOf, label: "the last 12 months" };
  }
  if (/\b(?:last|past|previous)\s+week\b/.test(q)) {
    return { from: isoAdd(asOf, -6), to: asOf, label: "the last 7 days" };
  }
  if (/\b(?:last|previous|past) month\b/.test(q)) {
    const y = am === 1 ? ay - 1 : ay;
    const mo = am === 1 ? 11 : am - 2;
    return { from: monthStart(y, mo), to: monthEnd(y, mo), label: `${MONTH_LONG[mo]} ${y}` };
  }
  if (/\bthis month\b/.test(q)) {
    return { from: monthStart(ay, am - 1), to: asOf, label: `${MONTH_LONG[am - 1]} ${ay} to date` };
  }
  if (/\bthis year\b|\byear to date\b|\bytd\b/.test(q)) {
    return { from: `${ay}-01-01`, to: asOf, label: `${ay} to date` };
  }
  if ((m = q.match(new RegExp(`\\bsince\\s+${MONTH_RE}\\s+(20\\d\\d)\\b`)))) {
    const mo = monthIndex(m[1]);
    return { from: monthStart(Number(m[2]), mo), to: asOf, label: `${MONTH_LONG[mo]} ${m[2]} to date` };
  }
  if ((m = q.match(new RegExp(`\\b${MONTH_RE}\\s+(20\\d\\d)\\b`)))) {
    const mo = monthIndex(m[1]);
    const y = Number(m[2]);
    return { from: monthStart(y, mo), to: monthEnd(y, mo), label: `${MONTH_LONG[mo]} ${y}` };
  }
  if ((m = q.match(new RegExp(`\\b(?:in|during|for|of|since)\\s+${MONTH_RE}\\b`)))) {
    const mo = monthIndex(m[1]);
    const y = mo + 1 > am ? ay - 1 : ay;
    if (/\bsince\b/.test(m[0])) return { from: monthStart(y, mo), to: asOf, label: `${MONTH_LONG[mo]} ${y} to date` };
    return { from: monthStart(y, mo), to: monthEnd(y, mo), label: `${MONTH_LONG[mo]} ${y}` };
  }
  if ((m = q.match(/\b(?:in|during|for|of|since)\s+(20[12]\d)\b/))) {
    const y = Number(m[1]);
    if (/\bsince\b/.test(m[0])) return { from: `${y}-01-01`, to: asOf, label: `${y} to date` };
    return { from: `${y}-01-01`, to: y === ay ? asOf : `${y}-12-31`, label: y === ay ? `${y} to date` : `${y}` };
  }
  if ((m = q.match(/\b(202[1-6])\b/))) {
    const y = Number(m[1]);
    return { from: `${y}-01-01`, to: y === ay ? asOf : `${y}-12-31`, label: y === ay ? `${y} to date` : `${y}` };
  }
  return undefined;
}

function parseHorizon(q: string, asOf: string): { days: number; label: string } | undefined {
  const m = q.match(new RegExp(`\\b(?:next|within|coming|upcoming|in)\\s+(?:the\\s+)?(?:next\\s+)?${NUM_RE}\\s+(day|week|month|year)s?\\b`));
  if (m) {
    const n = num(m[1]);
    const unit = m[2];
    let days: number;
    if (unit === "day") days = n;
    else if (unit === "week") days = 7 * n;
    else if (unit === "month") days = daysBetween(asOf, isoAddMonths(asOf, n));
    else days = daysBetween(asOf, isoAddMonths(asOf, 12 * n));
    return { days, label: `the next ${n} ${unit}${n === 1 ? "" : "s"}` };
  }
  if (/\b(next|this|coming) week\b/.test(q)) return { days: 7, label: "the next 7 days" };
  if (/\bnext month\b/.test(q)) return { days: daysBetween(asOf, isoAddMonths(asOf, 1)), label: "the next month" };
  if (/\bnext (quarter|3 months)\b/.test(q)) return { days: daysBetween(asOf, isoAddMonths(asOf, 3)), label: "the next 3 months" };
  if (/\bnext year\b/.test(q)) return { days: daysBetween(asOf, isoAddMonths(asOf, 12)), label: "the next 12 months" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Glossary aliases
// ---------------------------------------------------------------------------
export function glossaryAliases(term: string): string[] {
  const out = new Set<string>();
  const n = normalise(term).replace(/\s+/g, " ").trim();
  out.add(n);
  const paren = term.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (paren) {
    out.add(normalise(paren[1]).trim());
    out.add(normalise(paren[2]).trim());
  }
  if (term.includes(" / ")) for (const part of term.split(" / ")) out.add(normalise(part).trim());
  return Array.from(out).filter((a) => a.length >= 2);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------
export function extractEntities(question: string, kb: KnowledgeBase): Entities {
  const raw = question.trim();
  let q = ` ${raw.toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,;:]+(\s|$)/g, " ")} `;
  q = q.replace(/\//g, " ").replace(/-/g, (m, i: number, s: string) => (/[a-z0-9]/.test(s[i - 1] ?? "") && /[a-z]/.test(s[i + 1] ?? "") ? " " : m));
  const e: Entities = {
    tails: [], serials: [], partNumbers: [], recIds: [], taskIds: [], sortieIds: [], lots: [], atas: [],
    componentKeys: [], missions: [], bases: [], priorities: [], statuses: [], actions: [], reasons: [],
    recordTypes: [], types: [], enginePositions: [], taskCards: [], latest: false, unknownIds: [],
  };
  const push = <T,>(arr: T[], v: T) => {
    if (!arr.includes(v)) arr.push(v);
  };

  // Identifiers first (then blank them out so later rules do not reuse digits).
  q = q.replace(/\brec-?(\d{4})-?(\d{4})\b/g, (_m, a: string, b: string) => {
    const id = `REC-${a}-${b}`;
    if (kb.recIds.has(id)) push(e.recIds, id);
    else push(e.unknownIds, id);
    return " ";
  });
  q = q.replace(/\bsrt-?(\d{6})\b/g, (_m, a: string) => {
    push(e.sortieIds, `SRT-${a}`);
    return " ";
  });
  for (const id of kb.taskIds) {
    const re = new RegExp(`\\b${escape(id.toLowerCase())}\\b`, "g");
    if (re.test(q)) {
      push(e.taskIds, id);
      q = q.replace(re, " ");
    }
  }
  q = q.replace(/\btc[\s-]?(\d{2})[\s-]?(\d{2})[\s-]?(\d{2})\b/g, (_m, a: string, b: string, c: string) => {
    const id = `TC-${a}-${b}-${c}`;
    if (kb.taskCards.has(id)) push(e.taskCards, id);
    else push(e.unknownIds, id);
    return " ";
  });
  // Engine positions ("engine 3", "engine no 3", "no 3 engine", "third engine").
  const posRe = [
    /\b(?:engine|eng)\s*(?:no|number|#|position)?\s*([1-4]|one|two|three|four)\b/g,
    /\b(?:no|number|#)\s*([1-4])\s+engines?\b/g,
    /\b(first|second|third|fourth)\s+engines?\b/g,
  ];
  for (const re of posRe) {
    q = q.replace(re, (_m, p: string) => {
      push(e.enginePositions, ORDINAL[p] ?? p);
      return " engine ";
    });
  }
  q = q.replace(/\b(\d{2})-?(\d{4})-?(\d{2})\b/g, (_m, a: string, b: string, c: string) => {
    push(e.partNumbers, `${a}-${b}-${c}`);
    return " ";
  });
  const prefixes = new Set(kb.tails.map((t) => t.slice(0, 2).toLowerCase()));
  q = q.replace(/\b([a-z]{2})[\s-]?(\d{3})\b/g, (m, p: string, n: string) => {
    if (!prefixes.has(p)) return m;
    const t = `${p.toUpperCase()}-${n}`;
    if (kb.tails.includes(t)) push(e.tails, t);
    else push(e.unknownIds, t);
    return " ";
  });
  q = q.replace(/\bl-?(\d{4})\b/g, (m, n: string) => {
    const lot = `L-${n}`;
    if (kb.lots.has(lot)) {
      push(e.lots, lot);
      return " ";
    }
    if (m.includes("-")) push(e.unknownIds, lot);
    return m;
  });
  q = q.replace(/\b([a-z]{2})-?(\d{4})\b/g, (m, a: string, n: string) => {
    const s = `${a.toUpperCase()}-${n}`;
    if (kb.serials.has(s)) {
      push(e.serials, s);
      return " ";
    }
    if (m.includes("-")) push(e.unknownIds, s);
    return m;
  });
  q = q.replace(/\b(?:ata|chapter)\s*(\d{2})\b/g, (_m, n: string) => {
    push(e.atas, n);
    return " ";
  });
  // Tail shorthand ("307", "404") when it is not a quantity.
  const byNumber = new Map(kb.tails.map((t) => [t.slice(3), t]));
  q = q.replace(/(^|[^\d.,-])\b(\d{3})\b(?!\s*(?:fh|efh|h\b|hours?|days?|weeks?|months?|landings?|cycles?|%|man|sorties?|flights?|units?|runs?|°|c\b))/g,
    (m, pre: string, n: string) => {
      const t = byNumber.get(n);
      if (!t) return m;
      push(e.tails, t);
      return `${pre} `;
    });

  // Glossary term (before component synonyms consume words like "engine").
  const glossary = kb.docs<{ term: string }>("glossary");
  let bestTerm: { term: string; len: number } | undefined;
  for (const d of glossary) {
    for (const alias of glossaryAliases(d.facts!.term)) {
      const re = new RegExp(`(^|\\s)${escape(alias)}(\\s|$)`);
      if (re.test(q) && (!bestTerm || alias.length > bestTerm.len)) bestTerm = { term: d.facts!.term, len: alias.length };
    }
  }
  if (bestTerm) e.glossaryTerm = bestTerm.term;

  // "twin-engine transport" and "four-engine airlifter" name a type, not an engine.
  q = q.replace(/\b(twin|four|single) engined?\b/g, (_m, w: string) => ` ${w} `);
  // Metric words (before "engine" is consumed by the component families).
  if (/\bitt\b|\binter turbine\b|\bturbine temperature\b/.test(q)) e.metric = "ITT margin";
  else if (/\begt\b|\bexhaust gas\b/.test(q)) e.metric = "EGT margin";

  // Components (longest phrases first; consume matches). Each family expands
  // to the keys that exist in the corpus.
  const known = new Set(kb.corpus.components.map((c) => c.key));
  for (const [keys, re] of COMPONENT_FAMILIES) {
    const g = new RegExp(re.source, "g");
    if (g.test(q)) {
      for (const k of keys) if (known.has(k)) push(e.componentKeys, k);
      q = q.replace(g, " ");
    }
  }
  // Missions; their phrases are blanked in a copy so that "cargo airlift" or
  // "passenger transport" do not also read as an aircraft type.
  let qt = q;
  for (const [mission, re] of MISSION_SYNONYMS) {
    if (re.test(q)) {
      push(e.missions, mission);
      qt = qt.replace(new RegExp(re.source, "g"), " ");
    }
  }
  for (const [type, re] of TYPE_WORDS) if (re.test(qt)) push(e.types, type);
  // Topic words that point at an ATA chapter rather than one unit.
  if (/\bpressuri[sz]ation\b|\bcabin (altitude|pressure)\b|\bcabin leaks?\b/.test(q)) push(e.atas, "21");
  if (/\bbase a\b|\btemperate base\b/.test(q)) push(e.bases, "Base A");
  if (/\bbase b\b|\bhot base\b|\barid base\b/.test(q)) push(e.bases, "Base B");

  if (/\bcritical\b/.test(q)) push(e.priorities, "Critical");
  for (const p of ["high", "medium", "low"] as const) {
    if (new RegExp(`\\b${p}(\\s+|-)?(priority|recs?|recommendations?|items?)\\b|\\bpriority\\s+${p}\\b`).test(q)) {
      push(e.priorities, (p[0].toUpperCase() + p.slice(1)) as Priority);
    }
  }
  for (const [s, re] of [["Approved", /\bapproved\b/], ["Rejected", /\brejected\b/], ["Deferred", /\bdeferred\b/], ["Open", /\bopen\b|\boutstanding\b|\bpending\b/]] as const) {
    if (re.test(q)) push(e.statuses, s);
  }
  for (const [a, re] of [
    ["Inspect", /\binspect\b/], ["Replace", /\breplace\b/], ["Troubleshoot", /\btroubleshoot/],
    ["Monitor", /\bmonitor\b/], ["Service", /\bservice\b/], ["Review allocation", /\breview allocation\b|\ballocation\b/],
    ["Remove for overhaul", /\boverhaul\b/],
  ] as const) {
    if (re.test(q)) push(e.actions, a);
  }
  for (const [r, re] of REASONS) if (re.test(q)) push(e.reasons, r);
  for (const [t, re] of RECORD_TYPES) if (re.test(q)) push(e.recordTypes, t);

  e.window = parseWindow(q, kb.asOf);
  const h = parseHorizon(q, kb.asOf);
  if (h && !(e.window && /\b(last|past|previous)\b/.test(q))) {
    e.horizonDays = h.days;
    e.horizonLabel = h.label;
  }
  e.latest = /\b(last|latest|most recent|recent|previous)\s+(\w+\s+)?(sortie|flight|snag|defect|removal|phase|periodic|inspection|servicing|record|event|install|maintenance|change|replacement)/.test(q) ||
    /\bwhen (was|did)\b/.test(q);
  const top = q.match(/\btop\s+(\d+)\b/);
  if (top) e.limit = Number(top[1]);
  if (/\b(highest|most|max(imum)?|largest|biggest|worst|greatest|longest|top|heaviest|fastest)\b/.test(q)) e.direction = "desc";
  else if (/\b(lowest|least|min(imum)?|fewest|smallest|best|shortest)\b/.test(q)) e.direction = "asc";
  return e;
}
