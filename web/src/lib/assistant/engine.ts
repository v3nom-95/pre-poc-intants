// The offline query assistant: entity extraction, intent routing, template
// composition over exact records, then BM25 retrieval for supporting passages.
// No network beyond the app's own static data files, no language model.
import * as C from "./compose";
import { extractEntities, type Entities } from "./entities";
import { detectIntent, INTENT_VOCAB, isIntentWord } from "./intents";
import { isStopword, normalise, stem } from "./text";
import { KnowledgeBase, type SortieLoader } from "./knowledge";
import type { Answer, Corpus, Intent } from "./types";

const FOLLOW_UP = /\b(it|its|this aircraft|that aircraft|the same aircraft|this one|that one|this jet|that jet|this unit|that unit|this tail|same tail)\b|^\s*(and|also|what about|how about)\b/i;

// Everyday question words that carry no record meaning; never reported as
// "not found" even though they do not occur in the corpus.
const QUERY_WORDS = new Set(
  (
    "doing going look looks like need needs want know tell show give list please many much overall currently current " +
    "right today happening happened anything something everything info information details detail summary does done " +
    "have been being made make makes recent latest last next will would could should find fleet aircraft jets jet " +
    "records record data thing things total number count times time ever since during between across every each " +
    "whole entire also again still okay thanks thank answer question explain describe tell give known happen soon " +
    "fastest slowest quickest worst best highest lowest largest smallest oldest newest youngest summarise summarize " +
    "deteriorating deteriorate deterioration accurate accuracy reliable concern concerns worried worry urgently " +
    "happens keep flying going like this that those these doing ok fine healthy wrong matter versus compare logged log"
  )
    .split(" ")
    .map(stem)
);
const VOCAB = new Set(INTENT_VOCAB.map(stem));
const GENERIC: Intent[] = ["aircraft", "component", "kpi", "rank"];

function quoteList(words: string[]): string {
  return words.map((w) => `"${w}"`).join(", ");
}

interface Memory {
  tail?: string;
  serial?: string;
  partNumber?: string;
  intent?: Intent;
}

export class Assistant {
  readonly kb: KnowledgeBase;
  private memory: Memory = {};

  constructor(corpus: Corpus, loader: SortieLoader) {
    this.kb = new KnowledgeBase(corpus, loader);
  }

  reset() {
    this.memory = {};
  }

  async ask(question: string): Promise<Answer> {
    const q = question.trim();
    if (!q) return C.composeHelp();
    const e = extractEntities(q, this.kb);
    let { intent } = detectIntent(q, e);

    // Carry the previous subject into pronoun follow-ups ("and its engine?").
    let carried: string | undefined;
    const noSubject = !e.tails.length && !e.serials.length && !e.partNumbers.length && !e.lots.length && !e.recIds.length;
    if (noSubject && FOLLOW_UP.test(q)) {
      if (this.memory.serial && !e.componentKeys.length) {
        e.serials.push(this.memory.serial);
        carried = this.memory.serial;
      } else if (this.memory.tail) {
        e.tails.push(this.memory.tail);
        carried = this.memory.tail;
      }
      if (carried) intent = detectIntent(q, e).intent;
    }
    // "What about FX-305?" repeats the previous question type for a new subject.
    if ((intent === "aircraft" || intent === "component" || intent === "fallback") && /^\s*(and|what about|how about)\b/i.test(q) && this.memory.intent) {
      intent = this.memory.intent;
    }

    const ctx: C.Ctx = { kb: this.kb, e, q: q.toLowerCase(), question: q };
    const known = e.tails.length || e.serials.length || e.partNumbers.length || e.lots.length || e.recIds.length || e.taskIds.length || e.taskCards.length;
    if (e.unknownIds.length && !known) return C.notFound(ctx, quoteList(e.unknownIds).replace(/"/g, ""));

    const answer = await this.route(intent, ctx);
    if (carried) answer.text = `Taking ${carried} from the previous question. ${answer.text}`;
    if (e.unknownIds.length) answer.text += ` I could not find ${e.unknownIds.join(", ")} in the records.`;
    const unknown = answer.intent === "fallback" ? [] : this.unknownWords(q);
    if (unknown.length) {
      answer.text = GENERIC.includes(answer.intent)
        ? `I could not find ${quoteList(unknown)} in the records, so here is what they do hold. ${answer.text}`
        : `${answer.text} (${quoteList(unknown)} does not appear in the records, so it was not used.)`;
    }
    this.addPassages(answer, q, e);
    if (answer.context) this.memory = { ...answer.context, intent: answer.intent };
    else if (answer.intent !== "fallback" && answer.intent !== "help" && answer.intent !== "glossary") this.memory = { ...this.memory, intent: answer.intent };
    return answer;
  }

  /** Content words in the question that occur nowhere in the records. */
  unknownWords(q: string): string[] {
    const words = normalise(q)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !/\d/.test(w) && !isStopword(w));
    return Array.from(new Set(words.filter((w) => {
      const s = stem(w);
      return !this.kb.index.has(s) && !this.kb.index.has(w) && !QUERY_WORDS.has(s) && !QUERY_WORDS.has(w) && !VOCAB.has(s) && !VOCAB.has(w) && !isIntentWord(w);
    })));
  }

  private route(intent: Intent, ctx: C.Ctx): Answer | Promise<Answer> {
    const { e } = ctx;
    switch (intent) {
      case "help":
        return C.composeHelp();
      case "glossary":
        return C.composeGlossary(ctx);
      case "aircraft":
        return e.tails.length ? C.composeAircraft(ctx, e.tails[0]) : e.serials.length ? C.composeComponent(ctx, e.serials[0]) : C.composeKpi(ctx);
      case "component":
        return e.serials.length ? C.composeComponent(ctx, e.serials[0]) : C.composeFallback(ctx);
      case "next_action":
        return C.composeNextAction(ctx);
      case "plan":
        return C.composePlan(ctx);
      case "recommendations":
        return C.composeRecommendations(ctx);
      case "due":
        return C.composeDue(ctx);
      case "risk":
        return C.composeRisk(ctx);
      case "snags":
        return C.composeSnags(ctx);
      case "removals":
        return C.composeRemovals(ctx);
      case "maintenance":
        return C.composeMaintenance(ctx);
      case "sorties":
        return C.composeSorties(ctx);
      case "engine":
        return C.composeEngine(ctx);
      case "fatigue":
        return C.composeFatigue(ctx);
      case "reliability":
        return C.composeReliability(ctx);
      case "kpi":
        return C.composeKpi(ctx);
      case "rank":
        return C.composeRank(ctx);
      case "compare":
        return C.composeCompare(ctx);
      case "data_quality":
        return C.composeDataQuality(ctx);
      case "patterns":
        return C.composePatterns(ctx);
      case "models":
        return C.composeModels(ctx);
      case "fleet_type":
        return C.composeFleetType(ctx);
      case "operating":
        return C.composeOperating(ctx);
      case "task_card":
        return C.composeTaskCard(ctx);
      default:
        return C.composeFallback(ctx);
    }
  }

  /** Attach up to three related records from BM25 retrieval, restricted to the
   * entities in the question so they stay on topic. */
  private addPassages(answer: Answer, q: string, e: Entities) {
    if (answer.passages || answer.intent === "help" || answer.intent === "glossary") return;
    const hasEntities = e.tails.length || e.serials.length || e.partNumbers.length || e.lots.length;
    if (!hasEntities) return;
    const seen = new Set(answer.sources.map((s) => s.title));
    const hits = this.kb.index.search(q, {
      limit: 8,
      filter: (d) =>
        d.type !== "glossary" &&
        !seen.has(d.title) &&
        (!e.tails.length || (!!d.keys.tail && e.tails.includes(d.keys.tail))) &&
        (!e.serials.length || (!!d.keys.serial && e.serials.includes(d.keys.serial))) &&
        (!e.lots.length || e.lots.some((l) => d.text.includes(l))) &&
        (!e.window || !d.date || (d.date >= e.window.from.slice(0, 7) && d.date <= e.window.to)),
    });
    if (hits.length) answer.passages = hits.slice(0, 3).map((h) => ({ title: h.doc.title, text: h.doc.text, href: h.doc.href }));
  }
}
