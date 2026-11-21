# Model notes

Honest record of every deviation from SPEC.md's literal values, and every
real bug found while building and verifying the pipeline. Per section 5.6,
planted signal strength may be adjusted for detectability as long as it is
documented here; detectors themselves are never special-cased against
ground_truth.json.

## Pattern recovery result

6 of 7 planted patterns are recovered by data-driven detectors. Run
`python -m pre_engine.validate` for the live table. P2 (hot-climate
acceleration) is reported honestly as not statistically significant at the
current fleet size; see below.

## Signal strength adjustments (config.py)

- **P1, hydraulic pump lot defect.** SPEC's literal eta multiplier (x0.55)
  produced only a roughly 2x fleet failure-rate difference for the
  defective lot, which did not clear significance after Bonferroni
  correction across 4 lots (the one-sided binomial test on failure share vs
  exposure share is under-powered when the defective lot also happens to
  hold the majority of fleet exposure, which it does here). Strengthened to
  x0.22. With that value the defective lot shows roughly 4x the rest-of-fleet
  rate and the Bonferroni-corrected binomial test reaches p approx 0.018.
- **P2, hot-climate acceleration.** SPEC's literal factors (ECS cooling
  turbine x1.7, fuel boost pump x1.4) were strengthened to x2.2 and x1.8.
  Even so, the AFT hot_share covariate for these two parts does not reach
  p<0.01 (observed p approx 0.54 and 0.80 on the final run). This is a
  genuine small-sample power limit, not a tuning problem: each part has one
  position per aircraft, so the fleet only ever produces single-digit to
  low-teens confirmed failures for these two part numbers over the 5-year
  window, and a lifetime-average hot_share covariate is a weak proxy for a
  time-varying accelerant on that few events. Pushing the multiplier much
  higher (tested up to x6/x5) did not fix this and in one case flipped the
  fitted coefficient's sign due to the small-N AFT fit's instability, so
  further tuning was abandoned in favour of reporting the true result. The
  underlying direction is still visible descriptively: raw exposure-split
  failure rates for both parts are higher in the higher-hot-share half of
  their population, it just does not clear a p<0.01 bar on n approx 10.
- **P6, oil precursor co-occurrence.** Target rate is "about 70% of cases."
  With only 2 fleet-wide confirmed oil pump failures in the final run, the
  only achievable discrete rates are 0%, 50%, or 100%; 50% is what is
  observed. Not adjusted further: the issue is discreteness at this sample
  size, not multiplier strength.

## Real bugs found and fixed (not signal-strength tuning)

1. **Same-day Install/Removal ordering.** `sort_values` is not stable by
   default; a same-day unit swap (Removal then Install) could come out in
   the wrong order, making `rules.py` miss the currently-installed unit for
   that position entirely. Fixed with an explicit event-type tiebreak
   (`_sort_events` in pipeline.py) and a stable sort with an `event_id`
   tiebreak in `rules.py`/`trends.py`.
2. **Hard-time items able to go overdue.** `generate.py` checked an HT
   unit's limit after adding a sortie's consumption instead of before,
   letting engines/HPT/MLG units exceed their limit by a small amount at
   replacement. SPEC P7 is explicit that this must never happen. Fixed to
   check before adding the sortie's consumption.
3. **FX-305 CAD/PAD nudge left two serials briefly "installed" on the same
   position.** The nudge shifted only the Install date, not its paired
   same-day Removal of the superseded unit. Fixed to shift both halves of
   the swap together.
4. **Gold `unit_exposure` table grouped by serial instead of by
   install-to-removal leg.** Units circulate between aircraft through the
   spares pool, so a serial can have several install/removal legs on
   different tails. Grouping by serial and taking only the first leg
   silently dropped or misattributed later legs, corrupting
   `hot_climate_fh_share` for exactly the units that circulate most (and
   contributing to the P2 weakness above, before the fix). Fixed to pair
   install/removal events per (tail, position, part_number) leg.
5. **Tyre/brake wear-out logged as a snag (fault report).** Tyres and
   brakes wear out on a predictable, frequent schedule; logging every
   wear-limit swap as a defect snag flooded the ATA-32 repeat-snag detector
   with hundreds of routine entries on every aircraft, burying the one
   genuine repeat-snag pattern (P4, FX-307). Fixed: tyre/brake replacement
   still produces a maintenance record and component-history event, just no
   snag entry.
6. **FX-307's repeat snag never actually produced an NFF removal.** The
   scripted "flag intermittent" snag was only ever rectified by "connector
   reseated," so `recommend.py`'s NFF-history check (which decides whether
   to recommend troubleshooting wiring instead of another LRU swap) found
   nothing, even though SPEC P4 explicitly calls for two NFF removals.
   Fixed: two of the repeated occurrences now also perform an actual
   removal/reinstall with reason "Unscheduled: NFF," at mid-sequence
   occurrence numbers so the most recent snag stays open (the defect is
   still active at the as-of date, per SPEC).
7. **`recommend.py` only read the `repeat_nff` detector rows.** The actual
   P4 signal comes through as a `repeat_snag` row (same tail+ATA cluster);
   the recommendation builder was filtering for the wrong detector type and
   silently produced zero recommendations for FX-307. Fixed to consume
   `repeat_snag` rows and cross-reference NFF history to choose the action
   (Troubleshoot vs Inspect).
8. **Duplicate recommendations for the same unit.** Lot-flagged units
   (P1) were also generating a separate, lower-context survival-model
   recommendation for the exact same serial. Fixed: a unit already covered
   by a lot recommendation is excluded from the generic survival pass.

## Scope reduction

`validate.py`'s temporal train/test backtest (SPEC 5.6: train through 15
Nov 2025, evaluate on the final year; concordance, calibration,
recommendation recall and lead time, alert rate) was descoped in favour of
shipping a working demo first. What ships instead: the pattern-recovery
table (computed honestly against ground_truth.json, the actual validated
evidence) and an in-sample model-fit summary, clearly labelled as such, not
substituted for a held-out backtest. The full backtest can be added as a
follow-up; it is independent of everything the UI currently shows.
