# Ask PRE: the offline query assistant

Ask PRE answers plain-language questions about the fictional mixed fleet: 16 multirole fighters (`FX-301` to `FX-316`), 8 twin-engine transports (`TX-401` to `TX-408`) and 6 four-engine airlifters (`CX-501` to `CX-506`). It covers any aircraft or whole aircraft type, every sortie, components, snags, removals, maintenance records, ground runs, engine and APU operating hours, engine trends per engine (EGT on the fighter, ITT on the turboprops), task cards, recommendations, pattern detections, fleet KPIs, data quality and the action plan.

It is a retrieval-based (RAG) assistant with one important difference from the usual kind: **there is no language model**. Answers are composed from templates over the exact records the pipeline produced, so every figure is computed, never generated. It runs entirely in the browser from the app's own static files, with no network calls, which keeps the site usable with Wi-Fi off (SPEC section 0, rule 4).

Open it from the **Ask PRE** item in the navigation rail (`/assistant`) or from the button in the top bar, which opens the same conversation in a side panel on any page.

## How it works

1. **Corpus (Python, at export time).** `engine/src/pre_engine/knowledge.py` runs at the end of `export.py` and writes:
   - `web/public/data/knowledge/corpus.json`: about 9,200 short documents, each a template-generated summary of one record (3,148 component events, 2,114 maintenance records, 1,830 aircraft-months of utilisation, 916 installed units, 339 snags, every open and historical recommendation, 154 task cards, 71 schedule items, the action plan tasks and per-aircraft outlooks, 61 part numbers, the pattern findings, 30 aircraft profiles with every engine, 30 ground-run logs, 3 aircraft type profiles, the glossary, model cards, data quality checks and fleet KPIs by type). Each document has `keys` (tail, serial, part number, ATA, recommendation, plan task or task card id), a link to the matching screen, and a `facts` object of structured values.
   - `web/public/data/knowledge/sorties/{tail}.json`: every sortie for each of the 30 aircraft (23,481 in all) in compact columnar form: sortie id, date, mission, FH, landings, LCF cycles, peak g, base, temperature, take-off and landing times, FI, taxi hours and APU hours.
   - The corpus is stored compactly: a document's type is implied by its id prefix, facts do not repeat values already in `keys` or `date`, component names follow from the part number, and records with a fixed title pattern (events, maintenance records, utilisation months, snags) carry no title or link. `web/src/lib/assistant/knowledge.ts` restores the full shape when the corpus loads.
2. **Loading (browser).** Nothing is fetched until the first question is asked. Then the corpus loads once (about 4.4 MB, 0.38 MB compressed); sortie files load only for the aircraft a question needs.
3. **Understanding the question.** Rule-based, in `web/src/lib/assistant/`:
   - `entities.ts` finds tails of all three types (`FX-307`, `TX-404`, `CX-502`, or the number alone, `404`, when it is not a quantity), aircraft types (fighter, fast jet, transport, passenger aircraft, airlifter, cargo, freighter), engine positions ("engine 3", "no 3 engine", "third engine"), task card ids (`TC-21-04-01`), serials, part numbers, lots, recommendation, plan task and sortie ids, ATA chapters, and component names with their synonyms. A component phrase names a family across types: "generator" covers the fighter's main generator and the turboprops' engine-driven generators, and the question's aircraft or type narrows it. It also reads mission names for all three types (for example air drop, passenger transport, medevac, cargo airlift, circuits), the metric (EGT or ITT), bases, priorities, statuses, removal reasons and record types. "Pressurisation" or "cabin altitude" points at ATA 21. Relative dates ("last month", "last 3 months", "this year", "in March", "next 30 days") resolve against the fixed as-of date, 15 Nov 2026, never the system clock.
   - `intents.ts` scores weighted keyword rules plus entity hints to choose one of: aircraft profile, aircraft type profile or comparison, component, next action, action plan, recommendations, hard-time due items, failure risk, snags ("what is wrong with"), removals, maintenance records, sorties and utilisation, engine trends per engine, operating hours (flight, taxi, ground runs, APU), task cards, fatigue, reliability (MTBF, MTBUR, NFF, lots, hot-climate effect), fleet KPIs, ranking, comparison, data quality, pattern findings, models, glossary or help.
4. **Answering.** `compose.ts` has one composer per intent. Each filters and aggregates the structured records directly (counts, sums, rankings, date windows), scoped to the aircraft or types in the question, then fills a short template in an engineering tone. Answers carry a table where useful, the source records as links, and follow-up suggestions.
5. **Retrieval.** `bm25.ts` indexes every document (Okapi BM25). It supplies the "Related records" passages under an answer, restricted to the entities in the question, and it is the fallback when no intent matches: the assistant then shows the closest matching records.
6. **Conversation.** A pronoun follow-up ("and its engine?") reuses the previous aircraft or serial and says so. "What about FX-305?" repeats the previous question type for a new aircraft.

## Honesty rules

- Every number comes from a record. If the record is missing, the answer says so ("No ITT trend yet: the trend monitor needs enough EFH and readings since installation"). It never estimates.
- Words that appear nowhere in the records are named explicitly: "I could not find "payload" in the records". Identifier-shaped tokens that match nothing (`REC-2099-9999`, `TX-499`, an unknown task card) are reported as not found. Asking for engine 4 of a twin is answered as "there is no engine 4".
- Fighters have no APU; APU questions about them say so instead of reporting zero.
- Fleet risk rankings leave out tyres and brakes of every type (wear consumables), matching the recommendation queue, and the answer says so.
- If the action plan is not in the export, plan questions fall back to the open recommendation queue and say that they did.

## Example questions

- What should we do next on FX-307?
- What is wrong with TX-404?
- Show the ITT trend for CX-502 engine 3
- Show the engines on CX-502
- How many air drop sorties did the airlifters fly in October 2026?
- Which transport flew the most hours in the last 12 months?
- Compare utilisation by aircraft type
- How are the airlifters doing?
- How many APU hours did CX-503 log last month?
- Engine operating hours versus flight hours on TX-404
- What task card covers the cabin outflow valve on the transports?
- How long does it take to replace the APU on a transport?
- What is the MTBF of the generator?
- Why is lot L-2207 flagged?
- Which aircraft are due for hard-time items in the next 30 days?
- What is ITT margin?

## Limits

- It understands questions through rules, not language understanding. Unusual phrasing can land on the wrong question type; the closest-records fallback and follow-up chips help recover. One question type per question.
- It reports what the pipeline computed. It does not run new models, what-if scenarios (use the Planning screen) or forecasts beyond those already exported.
- The corpus is regenerated by `export.py`. A stale corpus answers from the previous run.
- Aircraft-level operating time in a date window is reported as its parts (FH, taxi hours, ground-run hours); engine operating hours per engine are reported from the export for the whole time each engine has been installed.
- Maintenance records, snags, component events, ground runs and sorties are indexed in full; per-aircraft utilisation is also summarised by month for retrieval passages.

## Tests

- `cd web && npm run test:unit` runs the vitest suite (`src/lib/assistant/assistant.test.ts`): 71 tests, more than 60 of them real questions against the real corpus across all three types, with expected values computed independently from the other exported JSON files, the silver sortie, snag and ground-run tables and the bronze task cards, plus entity extraction and copy-rule checks.
- `cd engine && uv run pytest tests/test_knowledge.py` checks the corpus: finite values, required fields per document type, unique ids, every snag, event, maintenance record, task card and ground run indexed, full sortie coverage per aircraft (FH, taxi and APU hours), every engine on every aircraft, byte-identical output on two builds, size, plan handling, display dates, no em or en dashes, and no reads of `ground_truth.json`.
