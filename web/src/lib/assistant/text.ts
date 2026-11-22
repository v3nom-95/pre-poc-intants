// Tokenisation shared by the BM25 index and the query parser.

const STOPWORDS = new Set(
  (
    "a an the and or of to in on for at by with from is are was were be been being do does did " +
    "what which who whom whose when where why how this that these those it its as if then than " +
    "me my we our us you your i can could should would will shall may might must has have had " +
    "show tell give list please about any all there their them they he she his her into over under " +
    "so such not no yes up down out also just only very much many more most some each per vs"
  ).split(" ")
);

/** Lowercase, unify quotes, and join hyphenated identifiers (FX-307, HP-0001,
 * 29-1140-03, L-2207, REC-2026-0011) into single tokens. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(?<=[a-z0-9])-(?=[0-9])/g, "")
    .replace(/\//g, " ");
}

export function stem(token: string): string {
  if (/\d/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string, keepStopwords = false): string[] {
  const out: string[] = [];
  for (const raw of normalise(text).split(/[^a-z0-9°]+/)) {
    if (!raw) continue;
    if (!keepStopwords && STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}
