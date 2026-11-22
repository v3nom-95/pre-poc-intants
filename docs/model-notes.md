# Model notes

Honest record of every deviation from SPEC.md's literal values, and every
real bug found while building and verifying the pipeline. Per section 5.6,
planted signal strength may be adjusted for detectability as long as it is
documented here; detectors themselves are never special-cased against
ground_truth.json.

## Pattern recovery result

All 9 planted patterns (P1 to P7 on the fighter, P8 and P9 on the
transport and airlifter, SPEC section 14.4) are recovered by the data-driven
detectors on the current data (checked engine-side by
`engine/tests/test_mixed_fleet.py`, which never reads ground_truth.json).
Run `python -m pre_engine.validate` for the live table. P2 is recovered on
the airlifter fuel boost pump; the fighter's two P2 parts on their own are
still under-powered, see below.

## Signal strength adjustments (config.py)

- **P1, hydraulic pump lot defect.** SPEC's literal eta multiplier (x0.55)
  produced only a roughly 2x fleet failure-rate difference for the
  defective lot, which did not clear significance after Bonferroni
  correction across 4 lots (the one-sided binomial test on failure share vs
  exposure share is under-powered when the defective lot also happens to
  hold the majority of fleet exposure, which it does here). Strengthened to
  x0.22. With that value the defective lot shows roughly 4x the rest-of-fleet
  rate and the Bonferroni-corrected binomial test reaches p approx 0.018
  (p approx 0.004 after the temperature profile fix below).
- **P2, hot-climate acceleration.** SPEC's literal factors (ECS cooling
  turbine x1.7, fuel boost pump x1.4) were strengthened to x2.2 and x1.8.
  Section 14 changes (22 Nov 2026): the planted acceleration now applies by
  component function to the ECS units and fuel boost pumps of every type
  (fighter ECS cooling turbine and boost pump, transport and airlifter ECS
  packs and boost pumps), since heat ageing is a physical effect, not a
  fighter one. The airlifters are split 3 and 3 between Base A and Base B
  and fly about 400 FH a year each with 2 ECS packs and 4 boost pumps, which
  gives the AFT hot_share covariate the contrast the 16-aircraft fighter
  fleet lacks. Airlifter ECS pack and boost pump characteristic lives were
  set to 2,000 FH and 2,500 FH (section 14.1 leaves new-type lives to
  config). With the same x2.2 and x1.8 factors (no further strengthening),
  the airlifter fuel boost pump is flagged (time ratio 0.06 for full hot
  exposure, p approx 0.003). A sweep showed the fighter parts alone stay
  under p<0.01 even at x5 (p approx 0.03 for the ECS cooling turbine), and
  at that strength P1 is lost, so the factors were not raised. Before the
  section 14 work, the fighter-only result was the one described next:
  the AFT hot_share covariate for these two parts did not reach
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
  size, not multiplier strength. After the section 14 data changes the
  observed rate is 100% (every fighter oil pump failure in the window had a
  chip detector event within 50 FH), again a small-count result.

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

Superseded. The temporal backtest of SPEC 5.6 was first descoped and has
since been built (`backtest.py`, run by `validate.py`). Method and results
are in `docs/validation.md` and on the Models page.

## Predictive action plan (extension)

`engine/src/pre_engine/action_plan.py` turns the open recommendation queue
into a dated, sequenced 90-day plan (`web/public/data/plan.json`, shown on
the Action plan screen and in each aircraft's Plan tab). It is a
deterministic scheduling layer on top of the existing models, not a new
statistical model: it never reads `ground_truth.json`, never uses the system
clock (the plan day is the as-of date) and uses no randomness.

Method:

- **Scheduled inputs.** Each aircraft's next periodic servicing (50 FH) and
  phase inspection (150 FH) are projected from the FH flown since the last
  recorded one in the maintenance records, at the aircraft's trailing 90-day
  FH per day (the same rate `rules.py` uses for hard-time due dates). An input
  already due starts on the as-of date; one recorded within its planned
  length with no flying since is treated as in progress. A phase inspection
  also covers the periodic servicing (both counters reset), which is a
  planning assumption: the simulator keeps the two counters independent.
- **Package lengths.** The midpoint of the configured ranges, rounded up:
  13 days for a phase inspection, 3 days for a periodic servicing. Bundled
  task work extends a package by whole days only, at a planning capacity of
  16 man-hours per aircraft per day (two technicians on one 8 hour shift).
- **Deadlines.** A task's deadline is the recommendation's due date, or the
  date its FH margin runs out at the trailing rate, whichever comes first.
- **Slotting.** Each task goes into the earliest scheduled input that starts
  at least 3 days and 5 FH before its deadline (deadline-aware bundling, as
  SPEC section 6 asks for hard-time items). Tasks of 10 man-hours or more
  (engine and module changes, gear changes, wiring troubleshooting) only go
  into a phase inspection. Critical tasks and tasks due now go into an input
  that starts before the aircraft flies again, or a before-next-flight input
  opened on the as-of date. Otherwise a dedicated input is planned as late as
  the margin allows; dedicated tasks on one aircraft within 7 days share one
  input (moving work earlier is always still inside the deadline). Fatigue
  allocation items go to the next monthly tasking review with no downtime.
- **Man-hours.** Each task's man-hours are the standard man-hours of the
  approved task card its recommendation cites (silver
  `maintenance_procedures`, SPEC section 14.3): remove and install per part
  number, on-condition inspection 2.5, oil filter, chip detector and SOAP
  sample 2.0, system troubleshooting 10.0, borescope inspection 6.0
  man-hours (fictional). The phase and periodic packages come from
  `config.py`. Parts aged in APU hours get no FH-horizon deferral risk.
- **Deferral risk.** For on-condition and condition-monitored units, the
  conditional failure probability `1 - S(t + N) / S(t)` from the exported
  Weibull AFT parameters (`survival_params.json`) and the unit's covariates,
  where N is the FH until the phase inspection the task would fall back to if
  it missed its planned slot. A test checks this math reproduces the survival
  model's own 150 FH probability for in-service units. Rule items, trend items
  and wiring troubleshooting get no model risk (the LRU's own failure risk does
  not describe a wiring fault).
- **Workload and availability.** Weekly man-hours spread each input's
  package and task hours evenly over its days. Availability is the share of
  aircraft not in any planned input, averaged over the week.

Known limits: unscheduled failures inside the horizon are not forecast here
(the what-if planning screen covers expected unscheduled removals); dedicated
inputs are not assumed to delay later scheduled servicing; spares are listed
as demand only, because the spares pool state at the as-of date is not
exported, so no availability is claimed.

## Mixed fleet (SPEC section 14, 22 Nov 2026)

**Fleet.** 16 multirole fighters (`FX-301` to `FX-316`), 8 twin-engine
transports (`TX-401` to `TX-408`, passenger and utility) and 6 four-engine
airlifters (`CX-501` to `CX-506`, cargo), all generic and fictional. Each
type has its own missions, components (18, 21 and 22), zones, utilisation,
TTL, withdrawal year and fatigue model in `config.py` (`AIRCRAFT_TYPES`;
`COMPONENTS` stays one flat dict, every entry tagged with `type` and a
planform `zones` map per position). Realised utilisation is about 13 FH
(fighter, unchanged), 29 FH (transport) and 33 FH (airlifter) per aircraft
per month; the configured ranges are planned rates on available days,
because scheduled inputs and unserviceability are not made up.

**Simulation streams.** Each type is simulated in its own pass with its own
seeded generator; the fighter pass consumes the main generator exactly as
before and all operating-hours draws (taxi, ground runs, APU) use separate
auxiliary generators. Before the temperature fix below, the fighter bronze
data was verified byte-identical to the single-type simulation.

**Operating hours (14.2).** Sorties carry `taxi_h` (engine running on the
ground per sortie) and `apu_h` (transport and airlifter). `ground_runs.csv`
logs ground runs after phase inspections (all engines), engine changes and
engine accessory replacements (that position). Engine operating hours are
EFH plus taxi and ground-run hours; the history card records them at every
engine install and removal, and data quality check 10 reconciles every
engine removal (the operating-hours ledger uses the logged 2-decimal sortie
time, like an engine log book). The APU ages in APU hours and its survival
model is fitted in APU hours (`exposure_unit` in the exports).

**Approved procedures (14.3).** `maintenance_procedures.csv` holds 154
fictional task cards (`TC-{ATA}-{NN}-{SS}`). Every recommendation cites one;
the action plan takes man-hours from them.

**P8 and P9 (14.4).** P8: `TX-404` "cabin altitude fluctuation" snags every
8 to 15 sorties over the last 8 months, two outflow valve removals NFF,
latest snag open; the repeat-snag and repeat-NFF detectors flag it and the
recommendation is to troubleshoot the pressurisation ducting and door seals
instead of a third valve. P9: `CX-502` engine 3 ITT margin deteriorates
about 10x the fleet slope over the last 300 EFH, projected to cross 15 °C in
about 61 EFH; the trend monitor flags exactly the two planted engines (P5
and P9) across all 56 installed engines.

**Real bugs found and fixed during this work (not signal tuning).**
1. **Temperature profile overshoot.** `generate.mean_temp_c` used a single
   cosine scaled by its value at the peak month, which overshoots after the
   peak: Base A reached about 37 °C in July (counted as hot, at or above
   35 °C) against SPEC's 31 °C peak, leaking hot exposure into temperate
   flying and blurring P2. Now a half-cosine rise from January to the peak
   and a half-cosine fall back: Base A peaks at 31 °C in May, Base B at
   about 42 °C between May and June (hot April to August). This changed the
   fighter data; P1 to P7 were re-verified.
2. **Time since new missing for units installed before the window.** The
   simulator starts those OC and CM units part way through their life, but
   their history card recorded 0 hours, so the survival model saw only
   in-window hours and a well-used unit looked like an early failure. The
   initial install row now carries the unit's time since new and gold
   `life_exposure` includes it (the lot test still uses in-window FH).
   Follow-up fix (left truncation): see "Survival model: delayed entry"
   below. Adding the time since new without conditioning on it inflated the
   fitted lives.
3. **Engine trend mixed two lives.** An overhauled engine returns from the
   pool with EFH reset to 0, but the trend took all readings for the serial
   sorted by EFH, so the old life's readings were picked. Trends now use
   readings since the current installation only.
4. **Scripted chip detector event could silently not fire.** P6's FX-302
   event needed a sortie within one day of the target date; it now fires on
   the first sortie at or after that day.

**Model rules added (documented, not tuned to ground truth).**
- Survival: a covariate enters a part's model only if its spread across
  that part's units is at least 0.02 (otherwise the design is singular, for
  example hot-climate share on parts flown only from the temperate base); a
  part needs at least 2 confirmed failures before any Weibull fit (the
  fighter radar altimeter has 0 confirmed failures in the window, every
  removal was NFF, so it has no model risk rather than a meaningless fit).
- Engine trend: a slope needs at least 100 EFH and 30 readings since
  installation (with 1.5 to 2 °C sensor noise a shorter span is too noisy;
  a freshly installed engine otherwise looked like an outlier by chance).
  Fleet comparison is within the same metric (EGT or ITT), and an outlier
  must be at or past the 5th percentile and have its whole confidence
  interval steeper than the fleet median slope.
- Fatigue: the reallocation what-if moves 15 points of the type's most
  fatigue-heavy mission (ACM, route and circuit training, tactical low
  level) to its relief mission, valued at the FI per FH each mission
  actually consumed on that tail (the fighter keeps its original formula).
- Recommendations: model-based items in urgency band U3 (within 150 FH or
  90 days) are now included, as section 6 defines (Medium for flight
  safety, Low for mission). Target for 30 aircraft: about 40 to 110 open;
  the current run has 43 (2 Critical). Transports currently carry only 1
  open item (the P8 troubleshoot): no transport hard-time item falls due
  within 90 days and no transport unit is inside an urgency band, which is
  reported as is rather than padded.

## Survival model: delayed entry (left truncation), 22 Nov 2026

**The defect.** About a quarter of the unit installations in gold
`unit_exposure.csv` (550 of 2,032 legs) were already fitted when the data
window opened on 16 Nov 2021. Since the mixed-fleet change their history card
carries their time since new, and `life_exposure` includes it. But such a unit
is in the data only because it survived to that age: units of the same
vintage that failed earlier were removed before the window and are never
seen. Fitting their whole age as if it had been watched from new is
survivorship bias, and it inflated the fitted characteristic lives (plain
Weibull scale on the backtest training data: median ratio 1.85 against a
truncation-aware fit). The backtest showed it as under-prediction: 26.7
expected failures against 64 observed in the test year.

**The fix.** `pipeline.py` writes a new gold column, `entry_exposure`: the
unit's age at the start of the data window, in the same life basis as
`life_exposure` (APU hours for APUs, FH otherwise; 0 for units installed
inside the window and for landings-based parts). `survival.fit_part` fits
`WeibullAFTFitter` with `entry_col`, so each such unit's likelihood is
conditioned on surviving to its entry age, S(t) / S(entry). Entry is kept just
below the duration (0.005 h), as lifelines requires.

**What did not change.** Public function names and signatures, scoring
(conditional probability S(t + N) / S(t) at the unit's full age, hours to tau,
the 200-draw parametric bootstrap, explanations) and the exported parameter
format (rho, intercept, coefficients). The what-if module and its TypeScript
parity test consume the same parameters and still match to 1e-6.

**Effect.**

| | Before | After |
|---|---|---|
| Backtest calibration (expected / observed failures) | 26.7 / 64 | 46.1 / 64 |
| Backtest concordance, pooled | 0.674 | 0.671 |
| Backtest recall (Medium or higher, at least 25 FH ahead) | 3% (2 of 66) | 9% (6 of 66) |
| Backtest alert rate per 1,000 FH | 11.4 | 13.3 |
| Open recommendations | 43 | 67 |
| Model-based open recommendations | 20 | 44 |
| Critical | 2 | 2 |

The growth is mostly Medium items (urgency band U3 on flight-safety parts):
airlifter fuel boost pumps (12), fighter engine-driven hydraulic pumps (10)
and airlifter engine-driven generators (5). Pattern recovery stays 9 of 9; P2
is still flagged on the airlifter fuel boost pump (AFT hot-share time ratio
0.08, p = 0.0079, was p = 0.0027 before the fix). Nothing was tuned against
ground truth or test outcomes.

**Still open.** The models still under-predict the test year somewhat (46.1
against 64). The Kaplan-Meier curve on the component page (`export.py`) is
still drawn without delayed entry, so its steps sit above the
truncation-aware Weibull overlay for parts with many pre-window units.

## Simulator realism fixes, 22 Nov 2026 (second pass)

Four generator problems were found while investigating a weak backtest, a
near-empty transport queue and planted signals that were stronger than the
spec. None of them is detector tuning; all of them are corrections to how the
synthetic fleet is simulated.

1. **Informative entry ages (left truncation).** Every on-condition and
   condition-monitored unit already fitted at the start of the data window was
   given an age equal to a fraction of its own hidden failure age. Entry age
   was therefore proportional to remaining life, which violates the delayed
   entry assumption and made fitted Weibull shapes look like a decreasing
   hazard. The age is now drawn independently (uniform, 0 to 1 times the
   part's characteristic life), and the damage threshold is conditioned on
   survival to that age with the memoryless property of the exponential
   threshold: `E = (age / eta)^beta + E`. Median fitted shape over planted
   shape across part numbers moved from 0.66x (range 0.24 to 1.23) to about
   1.0x. Test: `test_fitted_weibull_shape_recovers_planted_shape`.
2. **Repaired units kept their old threshold.** A unit that failed early went
   to the shop, came back with its age reset but the same threshold, and failed
   again at the same short age. Shop repair now restores the unit to as good as
   new with a fresh threshold. (Units returned after a no-fault-found removal
   in the planted P4 and P8 sequences keep theirs: they were serviceable.)
3. **One shared random stream per type.** Every draw (missions, durations,
   thresholds, lots, repair times) came from a single sequence, so a change in
   one component's failure timing shifted every later draw. That is why an
   earlier attempt to strengthen P2 appeared to "break" P1: it produced a
   different random fleet, not a causal effect. Every draw now comes from a
   stream keyed by its purpose and its entity (tail and date for flying and
   sorties, serial for unit thresholds and lots, serial and date for failures
   and repairs). Test: `test_keyed_random_streams_are_order_independent`.
4. **Oil precursor on the window edge.** P6 chip detector events were placed
   exactly 50 FH before the failure, the edge of the detector's "within 50 FH"
   window, so ordinary variation pushed them out. They now fall 5 to 45 FH
   before the failure.

**P5 and P9 at 3x.** The planted engines now deteriorate at 3x the fleet
normal margin decay over their last 300 EFH (SPEC 3 and 14.4), instead of the
roughly 10x previously needed to reach the limit from a normal margin. To make
both targets hold at once, each planted engine came back from its last shop
visit with a low margin: its whole trend since installation is rewritten
continuously (normal decay, then 3x in the window), and each reading keeps the
sensor noise it was simulated with. The turboprop ITT sensor noise is now
sd 1.5 °C, the value SPEC section 4 gives for engine trend readings.

**Trend projection fix (models/trends.py).** The projected EFH to the margin
limit was computed from the last single reading, which carries the full sensor
noise and moved the projection by tens of EFH between sorties. It now uses the
Theil-Sen trend line at the latest EFH. Flagging thresholds are unchanged.

**P2 power limit.** The hot-climate factors stay at 2.2x (ECS) and 1.8x (fuel
boost pumps). An approximate power calculation from the actual event counts and
the spread of hot-climate exposure (standard error of the AFT coefficient about
1 / (shape x sd(hot share) x sqrt(events))) says the fighter ECS cooling
turbine would need about a 10x factor and the fighter fuel boost pump about
50x for even a 50% chance of p < 0.01. Those are not realistic. Transports
are based at Base A only and have no hot exposure. P2 is recovered on the
airlifter parts, which have more events and a wider spread of exposure; the
fighter parts are reported honestly as under-powered at this fleet size.
