# CLAUDE.md

This repo is a proof of concept: PRE, the Predictive Recommendation Engine (SoW Use Case 4) for a fictional fighter fleet.

## Rules
- SPEC.md is the source of truth. Read it fully before any work and re-read the relevant section before each phase.
- Work in the phases of SPEC.md section 11. Stop at the end of each phase, run its acceptance checks, and report results. Do not start the next phase until told to.
- Never hardcode a number in the UI that should come from the pipeline. Never fake a metric or a pattern detection.
- Never read `engine/data/ground_truth.json` from model or recommendation code. Only `validate.py` may read it.
- Deterministic: all randomness goes through the seed in `config.py`. Never use the system clock; the as-of date is 15 Nov 2026.
- Offline: no runtime network calls, CDNs, external fonts or LLM/API calls.
- Copy: sentence case, no all-caps labels, no em dashes or en dashes anywhere, units always shown, dates as `16 Nov 2026`.
- If something in SPEC.md looks wrong or contradictory, stop and ask rather than guess.
- After any UI change, take screenshots (Playwright) and look at them before saying it is done.

## Commands
- `make all` runs data, models, export, web build and tests.
- `make test` runs pytest, vitest and Playwright.
