// Rule-based intent detection: weighted keyword patterns plus entity hints.
import type { Entities } from "./entities";
import type { Intent } from "./types";

type Rule = [Intent, RegExp, number];

const RULES: Rule[] = [
  ["help", /\b(help|what can you (do|answer)|how do i use|what can i ask|example questions?)\b/, 5],
  ["next_action", /\b(what happens if|if we keep|keep flying|outlook|prognosis|what should (we|i|be)|what to do|to do next|do next|next steps?|next actions?|course of action|plan of action|what needs|needs? attention|priorit(y|ies|ise|ize)|urgent|tentative plan|action plan|recommended actions?)\b/, 4],
  ["plan", /\b(spares?|spare parts|workload|man ?hours? (plan|forecast|next)|spares? (demand|needed|required)|availability forecast|planned tasks?|maintenance plan|plan summary|projected availability|plan tasks?|this week'?s tasks)\b/, 4],
  ["recommendations", /\b(recommendations?|recs?|work orders? raised|approved|rejected|deferred|evidence|audit)\b/, 3],
  ["due", /\b(due|hard ?time|ht items?|tbo|overdue|expir\w*|life limits?|calendar limits?|falling due|coming up|limit governs|governing limit)\b/, 3],
  ["risk", /\b(risk\w*|probabilit\w*|likely to fail|likely|remaining life|life left|life remaining|fh to (tau|threshold)|tau|survival|predict\w*|forecast\w*|next to fail|fail next|failure chance|chance)\b/, 3],
  ["snags", /\b(snags?|defects?|faults?|issues?|problems?|troubles?|reported|recurring|repeat(ed|ing)?|intermittent|write ups?|squawks?|wrong with|the matter with|going on with)\b/, 3],
  ["removals", /\b(remov(al|als|ed)|replaced|replacements?|swap(s|ped)?|installed|install(ation|ations)?|history cards?|cannibali[sz]\w*|changed|unit history|installation history)\b/, 3],
  ["maintenance", /\b(phase inspections?|periodic servicings?|servicings?|maintenance records?|work orders?|rectifications?|chip detectors?|man ?hours?|inspections?)\b/, 2],
  ["sorties", /\b(sorties?|flights?|flew|flown|fly|flying|utili[sz]ation|flight hours|hours flown|fh|missions?|landings?|lcf|cycles|take ?offs?|mission mix|g load|peak g)\b/, 2],
  ["engine", /\b(egt|itt|engines?|borescope|margin|efh|exhaust gas|inter turbine|turbine temperature|hot section|turboprops?)\b/, 2],
  ["operating", /\b(operating hours?|engine hours|running hours|run time|ground runs?|engine runs?|run ups?|taxi( hours| time)?|apu (hours|usage|time|running|utili[sz]ation)|hours on the apu|apu log\w*)\b/, 5],
  ["task_card", /\b(task cards?|procedures?|manual references?|maintenance manual|which card|how long (does it take|to)|man ?hours? (for|to|needed|required)|standard (man ?)?hours)\b/, 5],
  ["fleet_type", /\b(by (aircraft )?type|per type|each type|aircraft types?|fleet types?|types? of aircraft|fleet mix|fleet composition|mixed fleet)\b/, 5],
  ["fatigue", /\b(fatigue|fi|fatigue index|withdrawal|airframe life|ttl|structural|too much acm|acm share|acm heavy|over ?flying|overused?)\b/, 3],
  ["reliability", /\b(mtbf|mtbur|nff rate|reliab\w*|failure rates?|removal rates?|lots?|batch|manufacturing|hot climate|climate|environment\w*|temperature effect|weibull|per 1000)\b/, 3],
  ["kpi", /\b(kpis?|serviceability|serviceable|fleet status|fleet overview|fleet summary|dashboard|headline|how is the fleet)\b/, 4],
  ["data_quality", /\b(data quality|quality checks?|checks? pass|ingestion|duplicates?|pipeline|bronze|silver|gold|imputed|data cleaning|cleaned|issues resolved)\b/, 4],
  ["patterns", /\b(patterns?|anomal\w*|what did (the )?models? find|detections?|detected|precursors?|findings?|what has pre found|insights?)\b/, 3],
  ["models", /\b(models?|validation|backtest|accura\w*|concordance|model cards?|how does (it|pre) work|methods?|algorithm)\b/, 2],
  ["aircraft", /\b(status|tell me about|overview|summary|profile|how is|state of|condition|details? (of|for|on)|info(rmation)? (on|about))\b/, 2],
  ["compare", /\b(compare|comparison|versus|vs|difference between|side by side)\b/, 4],
  ["rank", /\b(which|highest|lowest|most|least|top|rank\w*|worst|best|fewest|max|min)\b/, 1],
];

/** Every plain word the intent rules listen for, so the unknown-word check
 * does not treat question vocabulary as missing data. */
export const INTENT_VOCAB: string[] = Array.from(
  new Set(RULES.flatMap(([, re]) => re.source.replace(/\\[bsw]/g, " ").match(/[a-z]{3,}/g) ?? []))
);

/** True when a word is something the intent rules listen for. */
export function isIntentWord(word: string): boolean {
  const w = ` ${word.toLowerCase()} `;
  return RULES.some(([, re]) => re.test(w));
}

const DEFINITION_OPENER = /^\s*(what\s+(is|are|does|do)\s+(an?\s+|the\s+)?|what's\s+(an?\s+)?|define\s+|definition of\s+|meaning of\s+|explain\s+|what does\s+)/i;

export interface IntentResult {
  intent: Intent;
  scores: Partial<Record<Intent, number>>;
}

export function detectIntent(question: string, e: Entities): IntentResult {
  const q = ` ${question.toLowerCase().replace(/[‘’]/g, "'").replace(/-/g, " ").replace(/[?!.,;:]/g, " ")} `;
  const scores: Partial<Record<Intent, number>> = {};
  const add = (i: Intent, w: number) => (scores[i] = (scores[i] ?? 0) + w);

  for (const [intent, re, w] of RULES) {
    const m = q.match(new RegExp(re.source, "g"));
    if (m) add(intent, w + 0.25 * (m.length - 1));
  }

  // Entity hints.
  if (e.lots.length) add("reliability", 4);
  if (e.recIds.length) add("recommendations", 6);
  if (e.taskIds.length) add("plan", 6);
  if (e.taskCards.length) add("task_card", 8);
  if (e.enginePositions.length) add("engine", 3);
  if (e.metric) add("engine", 1);
  // Several aircraft types named, or a type compared: answer by type.
  if (e.types.length >= 2 && !e.tails.length) add("fleet_type", 3);
  if (e.types.length && scores.compare && !e.tails.length) add("fleet_type", 5);
  if (e.sortieIds.length) add("sorties", 6);
  if (e.missions.length) add("sorties", 2);
  if (/\b(too much|excessive|heavy|over)\b/.test(q) && e.missions.includes("Air combat manoeuvring")) add("fatigue", 4);
  if (e.recordTypes.length && !scores.risk) add("maintenance", 1.5);
  if (e.reasons.length && /\bnff rate\b|\bfailure rate\b/.test(q) === false) add("removals", 1);
  if (e.window && !scores.due) add("sorties", 0.5);
  if (e.horizonDays) add("due", 1);
  if (e.componentKeys.includes("ENGINE") && !scores.due) add("engine", 1);
  if (e.serials.length && !Object.keys(scores).some((k) => k !== "aircraft" && k !== "rank")) add("component", 3);
  if (e.tails.length >= 2 && (scores.compare || /\band\b/.test(q))) add("compare", 2);

  // Glossary: a definitional question naming a glossary term and no records.
  if (e.glossaryTerm && DEFINITION_OPENER.test(question) && !e.tails.length && !e.serials.length && !e.lots.length &&
      !e.partNumbers.length && !e.recIds.length) {
    const specific = /\b(rate|trend|status|for|on|of the|which|how many|highest|lowest)\b/.test(q.replace(DEFINITION_OPENER, ""));
    if (!specific) return { intent: "glossary", scores: { ...scores, glossary: 99 } };
  }

  // "rank" only stands alone when no topic intent matched.
  const topical = (Object.keys(scores) as Intent[]).filter((k) => k !== "rank" && k !== "aircraft");
  if (!topical.length) {
    if (e.tails.length === 1 && !e.serials.length) return { intent: "aircraft", scores };
    if (e.types.length && !e.tails.length && !e.serials.length && !e.componentKeys.length) return { intent: "fleet_type", scores };
    if (e.serials.length) return { intent: "component", scores };
    if (e.partNumbers.length || e.componentKeys.length) return { intent: "reliability", scores };
    if (scores.rank) return { intent: "rank", scores };
    if (scores.aircraft) return { intent: "kpi", scores };
    return { intent: "fallback", scores };
  }

  const order: Intent[] = [
    "help", "task_card", "fleet_type", "compare", "plan", "next_action", "operating", "data_quality", "kpi", "recommendations", "due", "risk", "engine",
    "fatigue", "reliability", "snags", "removals", "maintenance", "sorties", "patterns", "models", "component",
    "aircraft", "rank",
  ];
  let best: Intent = "fallback";
  let bestScore = 0;
  for (const i of order) {
    const s = scores[i] ?? 0;
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  }
  return { intent: best, scores };
}
