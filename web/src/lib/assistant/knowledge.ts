// In-memory view over the knowledge corpus plus lazily loaded sortie tables.
//
// corpus.json is stored compactly (engine/src/pre_engine/knowledge.py): a
// document's type is implied by its id prefix, facts do not repeat values held
// in `keys` or `date`, component name and key follow from the part number, and
// template-titled records (events, maintenance, utilisation, snags) carry no
// title or link. Hydration here restores the full KDoc shape before indexing.
import { formatDate } from "@/lib/format";
import { Bm25Index } from "./bm25";
import type {
  AircraftFacts,
  ComponentFacts,
  ComponentInfo,
  Corpus,
  DocType,
  KDoc,
  RawDoc,
  Sortie,
  SortieFile,
  TypeInfo,
  TypeKey,
} from "./types";

export type SortieLoader = (tail: string) => Promise<SortieFile>;

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const FALLBACK_PREFIX: Record<string, DocType> = {
  kpi: "kpi", dq: "data_quality", model: "model", validation: "model", schedule: "schedule", glossary: "glossary",
  type: "fleet_type", aircraft: "aircraft", component: "component", part: "part", taskcard: "task_card",
  pattern: "pattern", rec: "recommendation", plan: "plan", plantask: "plan_task", planac: "plan_aircraft",
  snag: "snag", event: "event", maint: "maintenance", groundruns: "ground_runs", util: "utilisation",
};

/** Plural display label for a type ("fighters", "transports", "airlifters"). */
export const TYPE_PLURAL: Record<TypeKey, string> = {
  fighter: "fighters",
  transport: "transports",
  airlifter: "airlifters",
};

export function decodeSorties(file: SortieFile): Sortie[] {
  const ix = (name: string) => file.columns.indexOf(name);
  const taxi = ix("taxi_h");
  const apu = ix("apu_h");
  return file.rows.map((r) => ({
    id: r[0] as string,
    tail: file.tail,
    date: r[1] as string,
    mission: file.missions[r[2] as number],
    duration: r[3] as number,
    landings: r[4] as number,
    lcf: r[5] as number,
    peakG: r[6] as number,
    base: file.bases[r[7] as number],
    tempC: r[8] as number,
    takeoff: r[9] as string,
    landing: r[10] as string,
    fiConsumed: r[11] as number,
    fiCumulative: r[12] as number,
    taxi: taxi >= 0 ? (r[taxi] as number) : 0,
    apu: apu >= 0 ? (r[apu] as number) : 0,
  }));
}

export class KnowledgeBase {
  readonly index: Bm25Index;
  readonly asOf: string;
  readonly docsAll: KDoc[];
  readonly byId = new Map<string, KDoc>();
  readonly serials = new Set<string>();
  readonly lots = new Set<string>();
  readonly recIds = new Set<string>();
  readonly taskIds = new Set<string>();
  readonly taskCards = new Set<string>();
  readonly sortieIds = new Map<string, string>();
  readonly typeOfTail = new Map<string, TypeKey>();
  private byType = new Map<DocType, KDoc[]>();
  private compByPn = new Map<string, ComponentInfo>();
  private sortieCache = new Map<string, Promise<Sortie[]>>();

  constructor(
    readonly corpus: Corpus,
    private loader: SortieLoader
  ) {
    this.asOf = corpus.as_of;
    for (const c of corpus.components) this.compByPn.set(c.part_number, c);
    for (const [key, t] of Object.entries(corpus.types ?? {})) for (const tail of t.tails) this.typeOfTail.set(tail, key as TypeKey);
    const prefixMap = { ...FALLBACK_PREFIX, ...(corpus.type_by_prefix ?? {}) };
    const withPage = new Set(corpus.docs.filter((d) => d.id.startsWith("component:")).map((d) => d.id.slice("component:".length)));

    this.docsAll = corpus.docs.map((raw) => this.hydrate(raw, prefixMap, withPage));
    for (const d of this.docsAll) {
      this.byId.set(d.id, d);
      const list = this.byType.get(d.type) ?? [];
      list.push(d);
      this.byType.set(d.type, list);
      if (d.keys.serial) this.serials.add(d.keys.serial);
      if (d.keys.rec_id) this.recIds.add(d.keys.rec_id);
      if (d.keys.task_id) this.taskIds.add(d.keys.task_id);
      if (d.type === "task_card" && d.keys.task_card) this.taskCards.add(d.keys.task_card);
      const lot = (d.facts as { lot?: unknown } | undefined)?.lot;
      if (typeof lot === "string") this.lots.add(lot);
    }
    this.index = new Bm25Index(this.docsAll);
  }

  private hydrate(raw: RawDoc, prefixMap: Record<string, DocType>, withPage: Set<string>): KDoc {
    const prefix = raw.id.split(":", 1)[0];
    const type = (raw.type ?? prefixMap[prefix]) as DocType;
    let facts: Record<string, unknown> | undefined;
    if (raw.facts) {
      facts = { ...raw.keys, ...(raw.date ? { date: raw.date } : {}), ...raw.facts };
      const pn = facts.part_number as string | undefined;
      const comp = pn ? this.compByPn.get(pn) : undefined;
      if (comp && facts.component === undefined && (type === "component" || type === "event")) {
        facts.component = comp.name;
        facts.key = comp.key;
      }
      if (type === "event") facts.event_id = raw.id.slice("event:".length);
      if (type === "task_card") facts.task_card = raw.keys.task_card;
      const tail = facts.tail as string | undefined;
      if (tail && facts.type === undefined && type !== "recommendation" && type !== "plan_task") facts.type = this.typeOfTail.get(tail);
    }
    const f = (facts ?? {}) as Record<string, string | undefined>;
    const tail = raw.keys.tail ?? "";
    let title = raw.title;
    let href = raw.href;
    if (title === undefined || href === undefined) {
      if (type === "event") {
        title ??= `${f.event_type} of ${f.component ?? raw.keys.part_number} ${raw.keys.serial} (${tail})`;
        href ??= raw.keys.serial && withPage.has(raw.keys.serial) ? `/components/${raw.keys.serial}` : `/aircraft/${tail}`;
      } else if (type === "maintenance") {
        title ??= `${f.record_type} on ${tail}, ${raw.date ? formatDate(raw.date) : ""}`;
      } else if (type === "utilisation") {
        const month = raw.id.split(":")[2] ?? "";
        title ??= `${tail} utilisation, ${MONTH_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
      } else if (type === "snag") {
        title ??= `Snag ${f.snag_id} on ${tail}`;
      }
      title ??= raw.id;
      href ??= tail ? `/aircraft/${tail}` : "/";
    }
    return { id: raw.id, type, title, text: raw.text, href, keys: raw.keys, date: raw.date, facts };
  }

  docs<F>(type: DocType): KDoc<F>[] {
    return (this.byType.get(type) ?? []) as KDoc<F>[];
  }

  facts<F>(type: DocType): F[] {
    return this.docs<F>(type).map((d) => d.facts as F);
  }

  aircraft(tail: string): KDoc<AircraftFacts> | undefined {
    return this.byId.get(`aircraft:${tail}`) as KDoc<AircraftFacts> | undefined;
  }

  component(serial: string): KDoc<ComponentFacts> | undefined {
    return this.byId.get(`component:${serial}`) as KDoc<ComponentFacts> | undefined;
  }

  componentByPn(pn: string): ComponentInfo | undefined {
    return this.compByPn.get(pn);
  }

  get tails(): string[] {
    return this.corpus.tails;
  }

  get typeKeys(): TypeKey[] {
    return Object.keys(this.corpus.types ?? {}) as TypeKey[];
  }

  typeInfo(type: TypeKey): TypeInfo | undefined {
    return this.corpus.types?.[type];
  }

  /** Tails of the given types, in fleet order. */
  tailsOf(types: TypeKey[]): string[] {
    return this.tails.filter((t) => types.includes(this.typeOfTail.get(t) as TypeKey));
  }

  /** "EGT margin" or "ITT margin" for a tail's engines. */
  metricOf(tail: string): string {
    const t = this.typeOfTail.get(tail);
    return (t && this.corpus.types?.[t]?.metric) || "EGT margin";
  }

  sorties(tail: string): Promise<Sortie[]> {
    let p = this.sortieCache.get(tail);
    if (!p) {
      p = this.loader(tail).then(decodeSorties);
      this.sortieCache.set(tail, p);
    }
    return p;
  }

  async allSorties(tails: string[] = this.corpus.tails): Promise<Sortie[]> {
    const lists = await Promise.all(tails.map((t) => this.sorties(t)));
    return lists.flat();
  }
}
