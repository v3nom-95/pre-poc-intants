# Model validation and performance

This is the "model validation and performance documentation" deliverable (SoW Use Case 4; SPEC sections 5.6 and 14.5). Everything here is computed on synthetic data by `engine/src/pre_engine/backtest.py` and `validate.py`, written to `engine/data/gold/validation.json`, exported into `web/public/data/models.json`, and shown on the Models page (`/models`). The figures in the results section are a snapshot; the Models page always shows the current run.

## Run it

```
cd engine
uv run python -m pre_engine.validate   # prints the backtest and pattern recovery summary
uv run python -m pre_engine.export     # copies validation.json into models.json
uv run pytest tests/test_validate.py -q
```

Run validate before export, or the Models page will say the backtest is not in the export.

## Temporal backtest

| Setting | Value |
|---|---|
| Training data | Everything dated on or before 15 Nov 2025 |
| Test window | 16 Nov 2025 to 15 Nov 2026 |
| Models | One Weibull AFT model per OC and CM part number, fitted with the production code (`survival.fit_part`, same covariate rule) |
| Units scored | Every installation of a modelled part active in the test window: in service on the cutoff date, or installed during the window |

### No leakage

`backtest.build_training_exposure` rebuilds the unit exposure table as it would have looked on the cutoff date, from silver tables:

- only component events dated on or before the cutoff are used, so a unit still installed on the cutoff date is censored there (event 0), even if it failed a week later;
- age (FH since installation) and covariates (hot-climate share, ACM share) count only flying on or before the cutoff;
- lot comes from the installation record, which is known at installation.

A test deletes every row after the cutoff and checks that the training table is byte-for-byte unchanged.

### Survival metrics

- **Concordance index.** For each unit, the model predicts its median remaining life at the start of the test window (from its age and covariates at that point). Concordance measures how often units that failed sooner were predicted to have less remaining life (1 is perfect, 0.5 is chance). It is reported per part number where the test window holds 5 or more failures, and pooled across all units.
- **Calibration.** Each unit's predicted probability of failing over the FH it actually flew in the test window: `P = 1 - S(t0 + h) / S(t0)`. Units are sorted into ten risk deciles. Each decile compares expected failures (the sum of P) with observed failures. The Brier score (mean squared error of P against the 0 or 1 outcome) is also reported.

### Recommendation recall, lead time and alert rate

At monthly as-of points (the 15th of each month, 15 Nov 2025 to 15 Oct 2026), the backtest replays **every recommendation source in the live engine**, each using only data dated on or before that point:

| Source | How it is replayed | Coverage scope |
|---|---|---|
| Hard-time rules | `rules.compute_ht_due_items` run as it would have run on that date (silver tables cut to that date), then the section 6 bands and priority matrix | The unit |
| Survival model | Hours to tau with the training-fitted parameters, the unit aged as production ages it (life-basis hours plus time since new), days from trailing 90-day utilisation (APU hours through the trailing APU rate). All three bands, as the live queue | The unit |
| Lot defect | Binomial lot test on the exposure table as it stood on that date; every unit in service from a flagged lot (Inspect High, or Replace) | The unit |
| Repeat snag and repeat NFF | Snag clusters (3 or more within 60 days) and NFF pairs (2 within 120 days) on snags and removals up to that date; Troubleshoot or Inspect, High for flight-safety parts, else Medium | The recommended component's part number on that aircraft, any position |
| Engine trend | Theil-Sen slope on readings up to that date, fleet comparison among engines installed on that date | The engine |
| Oil precursor | Chip detector event within 50 FH on an installed lube oil pump | The pump |
| Fatigue | FI 100 projected before the withdrawal year from sorties up to that date | None: an aircraft tasking review cannot cover a component failure, but it counts in the alert rate |

The production pattern detectors read the full data set, so the backtest mirrors each one in `backtest.py` with an as-of cut. Tests in `engine/tests/test_validate.py` check that every mirror reproduces its production detector exactly at 15 Nov 2026, and that cutting the input at an earlier date gives the same output as running the mirror at that date.

A recommendation counts if its priority is Medium or higher, and stays open until the unit is removed. A test-window unscheduled confirmed failure is **covered** if a qualifying recommendation was open while that unit was fitted, at least 25 FH before the failure. Lead time runs from the first such recommendation to the failure. As in production, a unit covered by a lot recommendation does not also get a survival recommendation.

**Alert rate** is the number of recommendation episodes (consecutive monthly points on the same recommendation count once) per 1,000 FH flown by the fleet in the test window, over all sources.

**Trade-off (analysis only).** The survival source is re-run at 0.5, 1, 1.5, 2 and 3 times the section 6 thresholds, with every other source unchanged, to show recall against alert rate. Production keeps the section 6 thresholds; choosing a different operating point is a policy decision for the operator's engineers.

### Simplifications

These are also listed on the Models page:

1. Recommendations are evaluated monthly, not continuously.
2. Tyres and brakes are excluded from every metric, as they are from the live recommendation queue.
3. A repeat-snag cluster stays a trigger once it has occurred, because the production detector looks at the full snag history up to the as-of date. The oil precursor rule covers the fighter's lube oil pump, as in production.
4. Units installed during the test window start at their card's time since new (zero for units fitted new or after repair inside the window). Their covariates come from their aircraft's flying over the 365 days before installation.
5. Exposure uses the production definition (gold `unit_exposure.csv`): hours flown inside the data window in the part's life basis (APU hours for APUs, FH otherwise) plus the time since new carried on the history card for units already fitted when the window opens. As in production, the survival fit conditions those units on their age at the window start (delayed entry, gold column `entry_exposure`). A test (`test_training_exposure_matches_production_definition`) checks that every training leg closed before the cutoff matches the gold table exactly, entry included.

## Results (mixed fleet, 30 aircraft, run of 22 Nov 2026, full replay of every source)

These figures come from the latest backtest run while the simulator was being corrected in parallel; the next full pipeline run regenerates them, and the Models page always shows the current export.

| Metric | Value |
|---|---|
| Training data | 1,759 unit installations, 616 confirmed failures, 35 part-number models |
| Test units and failures | 515 units, 40 unscheduled confirmed failures on modelled parts (44 including parts with no model) |
| Concordance, pooled | 0.705 (event-weighted mean over the 2 part numbers with 5 or more test failures: 0.649) |
| Calibration | 40 failures observed against 43.9 expected (observed to expected 0.91); Brier score 0.079 |
| Recommendation recall, all sources | 18.2% (8 of 44 failures had a Medium or higher recommendation at least 25 FH ahead) |
| Recall, hard-time rules and survival model only | 13.6% (6 of 44) |
| Lead time of covered failures | 78 to 269 FH (median 141 FH), 151 to 281 days |
| Alert rate, all sources | 19.9 recommendation episodes per 1,000 FH (156 episodes over 7,832 FH) |

**By source** (alone: failures that source would have covered by itself; first: covered failures it flagged earliest):

| Source | Covered alone | First alert for | Alerts per 1,000 FH |
|---|---|---|---|
| Hard-time rules | 0 | 0 | 8.04 |
| Survival model | 6 | 3 | 7.53 |
| Lot defect | 5 | 5 | 2.68 |
| Repeat snag | 0 | 0 | 0.26 |
| Engine trend | 0 | 0 | 1.15 |
| Oil precursor | 0 | 0 | 0.13 |
| Fatigue (cannot cover) | not applicable | not applicable | 0.13 |

Hard-time rules cover no failure by design: hard-time parts are removed at their limit, and the failures being scored are unscheduled failures of on-condition and condition-monitored parts.

**By type:** fighter 5 of 18 covered, transport 1 of 5, airlifter 2 of 21. Calibration by type, expected against observed: fighter 14.0 against 16, transport 10.9 against 5, airlifter 19.0 against 19.

**Trade-off (analysis only, production thresholds unchanged):**

| Threshold (times section 6 tau) | Survival alerts per 1,000 FH | Survival recall | All-source recall | All alerts per 1,000 FH |
|---|---|---|---|---|
| 0.5 | 19.66 | 31.8% | 36.4% | 32.05 |
| 1 (production) | 7.53 | 13.6% | 18.2% | 19.92 |
| 1.5 | 3.32 | 9.1% | 15.9% | 15.70 |
| 2 | 1.40 | 4.5% | 11.4% | 13.79 |
| 3 | 0.64 | 4.5% | 11.4% | 13.02 |

Halving the thresholds would roughly double recall, at the cost of about 2.6 times as many survival alerts. That is an operating-point decision for the operator's engineers, not something tuned here.

### How the numbers got here

| Run | Recall | Calibration (expected / observed) | Concordance |
|---|---|---|---|
| Fighter-only data, first backtest | 42% (5 of 12) | 21.9 / 12 | 0.613 |
| Mixed fleet, first backtest | 12% (8 of 66) | 77.6 / 64 | 0.657 |
| Backtest aligned with production ageing | 3% (2 of 66) | 26.7 / 64 | 0.674 |
| Production fit with delayed entry | 9% (6 of 66) | 46.1 / 64 | 0.671 |
| Simulator entry ages corrected, every source replayed (current) | 18% (8 of 44) | 43.9 / 40 | 0.705 |

1. **The backtest did not age units the way production does.** Three mismatches were fixed in `backtest.py` so it validates the model that actually runs: model alerts were limited to urgency bands U1 and U2 (the live queue includes U3); units already fitted when the window opens were trained and scored from zero hours; and the APU was aged in FH instead of APU hours.
2. **Left truncation in the production fit (fixed).** Units already fitted when the window opened are observed only because they survived to that age; production now fits with delayed entry (`models/survival.py`, gold column `entry_exposure`). See `docs/model-notes.md`.
3. **Informative entry ages in the simulator (fixed in `generate.py`).** The backtest's calibration diagnostics showed the remaining under-prediction sat entirely in units that entered the window with history (35 observed against 19.5 expected), while the same test units scored by a fit on in-window legs only were well calibrated (21.7 expected against 21 observed). The cause: the simulator set each pre-window unit's starting age as a fraction (10% to 70%) of that unit's own failure-threshold age, so entry age was tied to failure time, which the delayed-entry fit assumes it is not. Fitted Weibull shapes came out at a median 0.61 times the true values. The simulator now draws the entry age independently and conditions the failure threshold on survival to that age. This is a correctness fix (SPEC section 3, AFT-consistent simulation), not tuning. The Models page keeps the diagnostic (expected against observed by entry kind, and the in-window-only fit) so a recurrence would be visible.
4. **Full replay.** Recall used to count hard-time rules and the survival model only. Every source is now replayed with as-of mirrors tested against production; the lot defect source adds coverage that the survival model alone misses.
5. **The alert rule itself (a genuine property, not tuned).** With the section 6 thresholds a unit reaches tau within the bands only near or beyond its characteristic life. Most failures in this data happen earlier, close to randomly in time, so per-unit risk rules flag a minority of them far ahead.

### Reading these numbers honestly

- The ranking is better than chance (0.705) and overall calibration is close (40 observed against 43.9 expected). By entry kind it is not yet even: units with pre-window history are now over-predicted and units installed in the window under-predicted, and the transport type is over-predicted (5 against 10.9). With 40 test failures these splits are noisy.
- Recall across every source is 18%. The survival model and the lot detector do the work; hard-time rules cannot cover unscheduled failures by construction, and the pattern detectors are narrow by design (they fire on specific signatures, not general wear).
- Only 2 part numbers have enough test failures to score concordance on their own. Refitting on real fleet history is the first thing to repeat.
- Thresholds were not tuned to raise recall. The trade-off table shows what earlier warning would cost in alerts.

## Pattern recovery (P1 to P9)

`validate.py` runs every detector first, then reads `ground_truth.json` to score whether the planted pattern was found. It is the only module allowed to read that file. The detectors are never tuned against it. P8 and P9 belong to the transport and airlifter types (SPEC section 14.4). If a pattern is not in the current data, the Models page marks it "Not planted" rather than counting it as a miss.

## In-sample fit summary

The Models page also lists each production model's in-sample concordance (fitted and scored on the same data). That is optimistic by construction and is kept only for reference next to the held-out backtest.
