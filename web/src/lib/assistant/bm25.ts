// Okapi BM25 over the knowledge corpus. Built once in the browser when the
// assistant first opens; a few thousand short documents index in milliseconds.
import { tokenize } from "./text";
import type { KDoc } from "./types";

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2;

export interface Hit {
  doc: KDoc;
  score: number;
}

export class Bm25Index {
  private postings = new Map<string, { doc: number; tf: number }[]>();
  private lengths: number[] = [];
  private avgLength = 0;

  constructor(private docs: KDoc[]) {
    let total = 0;
    docs.forEach((doc, i) => {
      const tokens = [...Array(TITLE_WEIGHT).fill(tokenize(doc.title)).flat(), ...tokenize(doc.text)] as string[];
      this.lengths.push(tokens.length);
      total += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, n] of tf) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ doc: i, tf: n });
      }
    });
    this.avgLength = docs.length ? total / docs.length : 0;
  }

  has(term: string): boolean {
    return this.postings.has(term);
  }

  search(
    query: string,
    opts: { limit?: number; filter?: (d: KDoc) => boolean; boost?: (d: KDoc) => number } = {}
  ): Hit[] {
    const terms = Array.from(new Set(tokenize(query)));
    const n = this.docs.length;
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const len = this.lengths[doc];
        const s = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / this.avgLength)));
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
    const hits: Hit[] = [];
    for (const [i, s] of scores) {
      const doc = this.docs[i];
      if (opts.filter && !opts.filter(doc)) continue;
      hits.push({ doc, score: s * (opts.boost ? opts.boost(doc) : 1) });
    }
    hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
    return hits.slice(0, opts.limit ?? 5);
  }
}
