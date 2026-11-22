# PRE: Predictive Recommendation Engine (proof of concept)

Fictional mixed fleet of 30 aircraft: 16 multirole fighters (FX-301 to FX-316), 8 twin-engine transports (TX-401 to TX-408) and 6 four-engine airlifters (CX-501 to CX-506). Fully synthetic data, fully offline static site. See `SPEC.md` (source of truth) and `CLAUDE.md`.

## Install

```
cd engine && uv sync
cd web && npm ci && npx playwright install chromium
```

## Run the pipeline (order matters: validate before export)

```
cd engine
uv run python -m pre_engine.generate
uv run python -m pre_engine.pipeline
uv run python -m pre_engine.validate
uv run python -m pre_engine.export
```

Export writes `web/public/data/*.json`, including `plan.json` (action plan) and `knowledge/` (the Ask PRE corpus and per-aircraft sortie files).

## Build and serve the site

```
cd web
npm run build          # static export to web/out, then scripts/flatten-rsc.cjs
                       # (node scripts/locked-build.cjs serialises builds if several workers share the folder)
npx serve out -p 4173  # open http://localhost:4173
```

## Tests

```
cd engine && uv run pytest -q        # pipeline, action plan, knowledge corpus
cd web && npm run test:unit          # vitest: Ask PRE answers and what-if parity with Python (1e-6)
cd web && npx playwright test        # visual suite, review flows, roles, print, axe, offline (no external requests)
cd web && node check-console.cjs     # console error sweep (needs the server on port 4173)
```

## Screens added in SPEC section 13

- `/plan`: Action plan. 90-day dated plan of action built from the open recommendations.
- `/assistant` (and the "Ask PRE" button in the top bar): offline query assistant over the pipeline's records. No language model; see `docs/assistant.md`.

## Added in SPEC section 14

- Mixed fleet with type-aware screens, per-engine EGT or ITT trends, engine operating hours (flight plus ground running) and APU hours.
- Approved task cards (`maintenance_procedures.csv`) cited by every recommendation and used for action plan man-hours.
- Temporal backtest on `/models` (train to 15 Nov 2025, test to 15 Nov 2026), see `docs/validation.md`.
- What-if on `/planning` computed from exported survival parameters, with a TypeScript and Python parity test.
- Per-aircraft printable report at `/aircraft/{tail}/report`.
- Review decisions stay in this browser's local storage (single-browser POC).

## Deploy (Vercel, static)

`vercel.json` at the repo root builds only the web app (the exported data in `web/public/data` is committed, so no Python runs on Vercel) and serves the static export from `web/out` with clean URLs.

1. Import the GitHub repo in Vercel, keep the root directory as the repo root, framework "Other" (the config sets it).
2. Deploy. Node 20 or later is required (Next.js 16).
3. After changing data, re-run the pipeline locally, commit `web/public/data`, and push; Vercel rebuilds.

Local equivalent of the deployed site: `cd web && npm run build && npx serve out -p 4173`.
