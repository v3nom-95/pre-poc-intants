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

At monthly as-of points (the 15th of each month, 15 Nov 2025 to 15 Oct 2026), the backtest replays the two quantitative alert sources with the training-only models:

- **Hard-time rules:** `rules.compute_ht_due_items` run as it would have run on that date (every silver table cut to rows dated on or before it), then the urgency bands and priority matrix from section 6.
- **Survival model:** hours to the criticality threshold tau with the training-fitted parameters, the unit aged exactly as production ages it (life-basis hours flown by that date plus the time since new on its history card), and days from the aircraft's trailing 90-day utilisation (APU hours are converted through the trailing APU rate, as the live queue does). As in the live queue, all three urgency bands raise a model alert; the priority matrix makes U3 Medium for flight-safety parts and Low for mission parts.

An alert counts if its priority is Medium or higher, and stays open until the unit is removed. A test-window unscheduled confirmed failure is **covered** if an alert on that unit was open at least 25 FH before the failure. Lead time runs from the first alert in the unit's installation to the failure.

**Alert rate** is the number of alert episodes (consecutive monthly points on the same unit count once) per 1,000 FH flown by the fleet in the test window.

### Simplifications

These are also listed on the Models page:

1. Recall only replays the hard-time rules and the survival model. Pattern-based recommendations (lot, repeat snag, oil precursor, engine trend, fatigue) are not replayed at past dates, so recall is a lower bound for the full engine.
2. Alerts are evaluated monthly, not continuously.
3. Tyres and brakes are excluded from every metric, as they are from the live recommendation queue.
4. Units installed during the test window start at their card's time since new (zero for units fitted new or after repair inside the window). Their covariates come from their aircraft's flying over the 365 days before installation.
5. Exposure uses the production definition (gold `unit_exposure.csv`): hours flown inside the data window in the part's life basis (APU hours for APUs, FH otherwise) plus the time since new carried on the history card for units already fitted when the window opens. As in production, the survival fit conditions those units on their age at the window start (delayed entry, gold column `entry_exposure`). A test (`test_training_exposure_matches_production_definition`) checks that every training leg closed before the cutoff matches the gold table exactly, entry included.

## Results (mixed fleet, 30 aircraft, run of 22 Nov 2026, after the delayed-entry fix)

| Metric | Value |
|---|---|
| Training data | 1,789 unit installations, 638 confirmed failures, 39 part-number models |
| Test units and failures | 561 units, 64 unscheduled confirmed failures on modelled parts (66 including the two parts with no model) |
| Concordance, pooled | 0.671 (event-weighted mean over the 3 part numbers with 5 or more test failures: 0.658) |
| Calibration | 64 failures observed against 46.1 expected (the models under-predict by a factor of 1.39); Brier score 0.109 |
| Recommendation recall | 9% (6 of 66 failures alerted at least 25 FH ahead, all by the survival model) |
| Lead time of covered failures | 34 to 170 FH (median 92 FH), 86 to 174 days |
| Alert rate | 13.3 alert episodes per 1,000 FH (99 episodes over 7,446 FH) |

By type: fighter 3 of 17 covered (hydraulic pumps), transport 1 of 21 (cabin pressure controller), airlifter 2 of 28 (a generator and a fuel boost pump). Calibration by type, expected against observed: fighter 11.4 against 15, transport 13.0 against 21, airlifter 21.7 against 28.

### How the numbers got here

| Run | Recall | Calibration (expected / observed) | Concordance |
|---|---|---|---|
| Fighter-only data, first backtest | 42% (5 of 12) | 21.9 / 12 | 0.613 |
| Mixed fleet, first backtest | 12% (8 of 66) | 77.6 / 64 | 0.657 |
| Backtest aligned with production ageing | 3% (2 of 66) | 26.7 / 64 | 0.674 |
| Production fit with delayed entry (current) | 9% (6 of 66) | 46.1 / 64 | 0.671 |

1. **The backtest did not age units the way production does.** Three mismatches were fixed in `backtest.py`, so it now validates the model that actually runs: model alerts were limited to urgency bands U1 and U2 (the live queue includes U3, which is Medium for flight-safety parts); units already fitted when the window opens were trained and scored from zero hours (production adds their time since new); and the APU was aged in FH instead of APU hours.
2. **Left truncation in the production fit (fixed).** Aligning the backtest exposed a production defect. Units already fitted when the window opened are observed only because they survived to that age, but the fit treated their time since new as if it had been watched from new, which inflated fitted lives (median ratio 1.85) and made the models under-predict badly. Production now fits with delayed entry (`models/survival.py`, gold column `entry_exposure`). See `docs/model-notes.md`, "Survival model: delayed entry".
3. **The alert rule itself (a genuine property, not tuned).** With the section 6 thresholds (10% conditional failure probability for flight-safety parts, 20% for mission parts) and fitted Weibull shapes of about 1.4 to 2.2, a unit only reaches the threshold within 150 FH when it is near or beyond its characteristic life. Most failures in this data happen before that, close to randomly in time, so a per-unit risk rule flags few of them far ahead. On fighter-only data recall looked higher because the strong L-2207 hydraulic pump lot effect dominated a small test set.

### Reading these numbers honestly

- The ranking is better than chance (0.67). Only three part numbers have enough test failures to score on their own.
- The models still under-predict the test year (46.1 expected against 64). Refitting on real fleet history is the first thing to repeat.
- The survival model alone is a weak early-warning source in this data: 9% recall. The live engine also raises lot, repeat-snag, oil precursor, engine trend and fatigue recommendations, which are not replayed here, so 9% is a lower bound for the full engine. It is still the number to report for the survival model.
- Thresholds were not tuned to raise recall. Changing tau or the bands is a policy choice for the operator's engineers, and the backtest is the tool to show its alert-rate cost.

## Pattern recovery (P1 to P9)

`validate.py` runs every detector first, then reads `ground_truth.json` to score whether the planted pattern was found. It is the only module allowed to read that file. The detectors are never tuned against it. P8 and P9 belong to the transport and airlifter types (SPEC section 14.4). If a pattern is not in the current data, the Models page marks it "Not planted" rather than counting it as a miss.

## In-sample fit summary

The Models page also lists each production model's in-sample concordance (fitted and scored on the same data). That is optimistic by construction and is kept only for reference next to the held-out backtest.
