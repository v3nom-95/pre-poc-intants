# PRE: Predictive Recommendation Engine (Use Case 4 POC)

Build spec for Claude Code. Read this whole file before writing any code.

---

## 0. Mission and non-negotiables

**What we are building.** A working proof of concept of SoW Use Case 4, "AI-Based Predictive Recommendation Engine", for a fleet of fighter aircraft. It analyses (fictional) historical operational and maintenance data, tracks aircraft and component utilisation, finds recurring defects and failure patterns, and generates explainable maintenance recommendations that authorised personnel review and approve.

**Who will judge it.** Senior aircraft maintenance engineers and technical officers in a defence aerospace organisation. They know this domain far better than a typical software buyer. They will notice wrong terminology, impossible numbers and hand-waved "AI" within seconds. Precision in domain detail matters as much as visual quality.

**Product name in the UI:** "Predictive Recommendation Engine", short form "PRE". No other branding. No logos.

**Non-negotiables (read twice):**

1. **All data is synthetic and fictional.** No real aircraft type, real unit, real base, real serial format or real person. A persistent, quiet notice in the app shell says: "Proof of concept. All aircraft, data and figures are fictional."
2. **Nothing is hardcoded in the UI that should be computed.** Every number on screen comes from the pipeline and models. Every metric on the validation page is actually computed. If a planted pattern is not recovered, report it honestly; never fake a detection.
3. **Deterministic.** One global seed. Running the full pipeline twice produces byte-identical output files.
4. **Offline by design.** No runtime network calls, no CDNs, no external fonts at runtime, no LLM or external API calls. Fonts are bundled from npm. The built site must run from a laptop with Wi-Fi off. This is a selling point for defence buyers.
5. **Explainable.** Every recommendation shows exactly why it exists: which rule fired, which model output, what evidence.
6. **Copy rules.** Sentence case everywhere. No all-caps labels. No em dashes or en dashes anywhere in UI copy, code comments or docs (use commas, colons, parentheses or "to" for ranges). Units always shown (FH, landings, cycles, °C, days). Dates as `16 Nov 2026`. Numbers with thousands separators (`1,240 FH`).
7. **Quality floor.** No console errors or warnings. No layout overflow at 1280x720 (projectors), 1440x900, 1920x1080. Keyboard navigable, visible focus, `prefers-reduced-motion` respected, light and dark themes both designed (not auto-inverted).

**Work in phases (section 11). Stop at the end of each phase, run its acceptance checks, and report results before continuing.**

---

## 1. Domain model and glossary

Use these terms exactly. Show a glossary drawer in the app (help icon in the top bar) with these definitions.

| Term | Meaning |
|---|---|
| FH | Flight hours (airframe). |
| EFH | Engine flight hours. |
| LCF cycles | Low cycle fatigue cycles on the engine (full throttle excursions). Drives life of engine rotating parts. |
| Sortie | One flight: take-off to final landing. One sortie can have several landings (touch-and-go circuits). |
| TSN / TSO | Time since new / time since overhaul (FH, EFH or cycles depending on component). |
| TBO | Time between overhauls. |
| TTL | Total technical life (airframe). |
| Fatigue index (FI) | Airframe structural fatigue consumed, 0 to 100, accumulated per sortie from g-loading. 100 = design fatigue life. |
| Hard time (HT) | Component removed at a fixed limit (FH, cycles, landings or calendar), whichever comes first. |
| On-condition (OC) | Component inspected or checked periodically and replaced when condition requires. |
| Condition monitoring (CM) | No scheduled task; failures are monitored and analysed statistically. |
| Life-limited part (LLP) | Part with a mandatory hard life (for example engine turbine disc). |
| Snag | A defect reported against an aircraft, recorded in the snag register. |
| Repeat snag | Same defect recurring on the same aircraft within a defined window. |
| Unscheduled removal | Component removed due to a failure or suspected failure. |
| NFF | No fault found: removed unit tests serviceable in the shop. |
| MTBF / MTBUR | Mean time between failures (confirmed) / mean time between unscheduled removals (includes NFF). |
| Phase inspection | Scheduled major inspection every 150 FH. Minor periodic servicing every 50 FH. |
| EGT margin | Exhaust gas temperature margin below the limit (°C). Decreases with engine deterioration. |
| Borescope inspection | Internal visual inspection of engine hot section through access ports. |
| SOAP | Spectrometric oil analysis programme. |
| Cannibalisation | Moving a serviceable part from one aircraft to another. |
| Serviceability | Share of aircraft serviceable (available to fly) over a period. |
| CAD/PAD | Cartridge / propellant actuated devices (ejection seat pyrotechnics), calendar-life items. |

**Maintenance concepts must be applied correctly:**
- HT items: remaining life = the minimum over all applicable limits ("whichever comes first"). Show which limit governs.
- OC and CM items: no fixed life. Risk comes from the survival model. Never show a "life limit" for them; show predicted remaining life with an interval instead.

---

## 2. The fictional fleet

All values below are fictional. Put them in `engine/src/pre_engine/config.py` as the single source of truth.

**Fleet:** 16 single-seat, single-engine multirole fighters of a generic, unnamed type. Tail numbers `FX-301` to `FX-316`.

**Bases:**
| Base | Climate | Monthly mean temperature profile |
|---|---|---|
| Base A | Temperate | 12 °C (Jan) to 31 °C (May), sinusoidal |
| Base B | Hot, arid | 18 °C (Jan) to 42 °C (May/Jun), sinusoidal |

10 aircraft home at Base A, 6 at Base B. Each year, 3 Base A aircraft (rotating selection) go on a Base B summer detachment, April to June. This creates varied hot-climate exposure across the fleet.

**Time window:** 16 Nov 2021 to 15 Nov 2026. The as-of date is fixed: **15 Nov 2026**. Never use the system clock.

**Aircraft attributes:** induction date (2009 to 2018), airframe FH at window start (900 to 3,600 FH), airframe TTL 6,000 FH, FI at window start (consistent with past hours, 15 to 55), planned withdrawal year 2036.

**Utilisation:** fleet average about 15 FH per aircraft per month, varying by aircraft (12 to 19) and season (lower in monsoon months Jul to Sep, about 20% down). An aircraft cannot fly while in phase inspection (10 to 16 days), in periodic servicing (2 to 3 days) or unserviceable awaiting spares (after some unscheduled removals, 1 to 20 days, longer if the spares pool for that part number is empty).

**Mission types** (fleet default shares; per-aircraft variation of plus or minus 5 points):

| Mission | Share | Avg duration (h) | Landings / sortie | LCF cycles / sortie | FI per FH (factor) | Peak g range |
|---|---|---|---|---|---|---|
| Air combat manoeuvring (ACM) | 25% | 0.9 | 1 | 4 to 6 | 2.2 | 6 to 9 |
| Ground attack | 20% | 1.2 | 1 | 2 to 3 | 1.4 | 4 to 7 |
| Air defence | 15% | 1.4 | 1 | 2 to 3 | 1.2 | 4 to 7 |
| General flying / circuits | 25% | 1.0 | 3 to 6 | 2 to 4 | 1.0 | 2 to 4 |
| Navigation / ferry | 10% | 1.8 | 1 | 1 | 0.4 | 1.5 to 3 |
| Functional test flight | 5% | 0.7 | 1 to 2 | 2 to 3 | 0.8 | 3 to 5 |

Functional test flights happen after phase inspections and major component changes, not randomly. FI per sortie = base rate x mission factor x duration, with base rate set so a 100% general-flying aircraft would consume FI 100 at about 7,500 FH.

**Components per aircraft** (part numbers are fictional and start with the ATA chapter, format `CC-NNNN-NN`, for example `29-1140-03`; serials are part-prefix plus number, for example `HP-0231`):

| ATA | Component | Positions | Concept | Life basis (fictional) | Criticality |
|---|---|---|---|---|---|
| 21 | ECS cooling turbine | 1 | OC | Weibull beta 1.8, eta 1,400 FH | Mission |
| 24 | Main generator | 1 | OC | beta 1.4, eta 2,600 FH | Flight safety |
| 24 | Main battery | 1 | HT | 24 months calendar | Flight safety |
| 25 | Ejection seat CAD/PAD set | 1 | HT | 36 months calendar | Flight safety |
| 27 | Horizontal stabilator actuator | 2 (L, R) | OC | beta 2.2, eta 3,000 FH | Flight safety |
| 27 | Flight control computer | 1 | CM | beta 1.0, eta 6,000 FH | Flight safety |
| 28 | Fuel boost pump | 1 | OC | beta 1.6, eta 2,200 FH | Flight safety |
| 29 | Engine-driven hydraulic pump | 1 | OC | beta 2.0, eta 1,900 FH | Flight safety |
| 32 | Main landing gear assembly | 2 (L, R) | HT | 4,000 landings or 12 years | Flight safety |
| 32 | Main wheel brake | 2 (L, R) | OC | wear per landing, limit by wear pin | Flight safety |
| 32 | Main wheel tyre | 2 (L, R) | OC | about 120 to 220 landings | Mission |
| 34 | Radar altimeter | 1 | CM | beta 1.0, eta 3,500 FH, NFF prone | Mission |
| 34 | Inertial navigation unit | 1 | CM | beta 1.1, eta 4,500 FH | Mission |
| 49 | Jet fuel starter | 1 | OC | beta 1.7, eta 1,600 FH | Mission |
| 72 | Engine (installed) | 1 | HT | TBO 1,200 EFH or 2,400 LCF cycles | Flight safety |
| 72 | HPT module (turbine disc LLP) | 1 | HT | 3,000 LCF cycles | Flight safety |
| 73 | Engine fuel control unit | 1 | CM | beta 1.0, eta 5,000 FH | Flight safety |
| 79 | Engine lube oil pump | 1 | OC | beta 2.1, eta 2,800 FH | Flight safety |

Maintain a spares pool per part number (about 25% of fleet quantity). Removed units go to repair (30 to 90 days turnaround), then back to the pool. Units move between aircraft over time. Allow occasional cannibalisation (about 3% of removals) when the pool is empty.

**Removal reasons:** `Scheduled (hard time)`, `Unscheduled: confirmed failure`, `Unscheduled: NFF`, `Cannibalisation`, `Scheduled (engine change)`. NFF rate: 8% generally, 35% for radar altimeter.

**Maintenance man-hours** (fictional standard hours per task, used for workload forecasting): include a table per part number for remove/install, plus phase inspection 180 man-hours, periodic servicing 24 man-hours.

---

## 3. Planted patterns (ground truth)

Write these to `engine/data/ground_truth.json`. The models must discover them from data alone. The ground truth file is used only by the validation step, never as model input.

| ID | Pattern | How to plant it |
|---|---|---|
| P1 | Defective hydraulic pump lot | 12 of the hydraulic pumps belong to manufacturing lot `L-2207`. Their characteristic life is x0.55. Other pumps are in lots `L-2105`, `L-2301`, `L-2312`. |
| P2 | Hot-climate acceleration | ECS cooling turbine ages x1.7 faster, fuel boost pump x1.4 faster, during flying hours at a base with monthly mean temperature of 35 °C or above. |
| P3 | Mission-mix fatigue | FX-304, FX-309, FX-312 fly 45% ACM. FX-309 is projected to reach FI 100 before its planned withdrawal year. |
| P4 | Recurring snag with a wrong fix | FX-307: radar altimeter "flag intermittent" snags every 6 to 12 sorties over the last 9 months. Rectifications: connector reseated, ground run satisfactory. Two radar altimeter removals were NFF. True cause (not stated in data): wiring harness chafe. Still active at the as-of date. |
| P5 | Engine deterioration | The engine on FX-311: EGT margin deteriorates 3x faster than fleet normal over the last 300 EFH. Projected to cross the 10 °C margin threshold within about 40 to 80 EFH. |
| P6 | Oil system precursor | Lube oil pump failures are preceded by chip detector events within 50 FH in about 70% of cases. FX-302 had a chip detector event 18 FH before the as-of date and no failure yet. |
| P7 | Hard-time items approaching | FX-305 CAD/PAD set due in about 20 days. FX-314 engine within about 40 EFH of TBO. FX-301 left main gear at about 3,880 landings. No item is ever overdue (fighter fleets do not fly overdue items; an overdue item would be a data error). |

**How to simulate component failures correctly (AFT-consistent):** for each installed unit, draw a damage threshold `E ~ Exponential(1)`. Track effective age `a`: each sortie adds `duration x accel`, where `accel` is the product of applicable acceleration factors (hot climate, lot, ACM share effects for stabilator actuators at x1.3 on ACM hours). The unit fails when `(a / eta)^beta >= E`. This makes the planted effects recoverable by a Weibull accelerated failure time model. Failures happen during or right after sorties; record the failure on the snag register with a realistic description for that component, then the removal.

**Realistic noise:** utilisation, sortie durations, temperatures and repair turnaround all vary naturally. Silver data is complete and consistent; bronze (raw) data carries the deliberate ingestion issues listed in section 4.

---

## 4. Data pipeline (bronze, silver, gold)

This is the "historical operational data integration module" deliverable. Build it as a real pipeline, not a single script.

**Bronze (raw, as received).** CSV files that look like source system extracts, with realistic issues injected at a known, logged rate:
- `sortie_log.csv` (flight authorisation records): about 0.4% exact duplicate rows, about 0.2% missing duration (but take-off and landing times present), mixed date formats in 1% of rows (`2024-03-07` vs `07/03/2024`).
- `snag_register.csv`: free-text descriptions, ATA chapter sometimes missing (1%) but inferable from the component field.
- `component_history.csv` (history cards): install and removal events.
- `maintenance_records.csv`: inspections, servicing, rectifications, work orders.
- `engine_trend.csv`: EGT margin readings per sortie for each engine serial (with sensor noise, sd 1.5 °C).
- `maintenance_schedule.csv`: the approved schedule (task, interval, limits).

**Silver (validated, conformed).** Deduplicate, impute missing durations from block times, normalise dates, infer missing ATA from component, enforce types, build conformed tables. Every fix is counted and logged.

**Gold (analytics-ready).** Feature tables (unit-level exposure: FH, hot-climate share, ACM share, lot), aggregates (monthly utilisation per aircraft, removal rates per 1,000 FH), model outputs and recommendations.

**Data quality checks** (run on silver; results exported to the UI with pass/fail and counts):
1. Sortie hours reconcile to airframe hours per aircraft (tolerance 0.1 FH).
2. No serial installed on two aircraft at once.
3. No position with two serials installed at once.
4. Every removal is after its installation.
5. No hard-time item ever exceeds its limit.
6. No sortie while the aircraft is in scheduled maintenance or unserviceable.
7. Every snag references a valid tail and ATA chapter.
8. No duplicate sortie IDs.
9. Engine EFH equals sum of sortie hours while installed.

Also export an "issues found and resolved" summary (for example "47 duplicate sorties removed"), with real counts from the run.

---

## 5. Models

Use Python 3.11+, pandas, numpy, scipy, scikit-learn, lifelines. Pin versions in `pyproject.toml`. No deep learning; it is the wrong tool here and harder to defend.

### 5.1 Hard-time rules engine
For every HT item: remaining = min over its limits (FH, EFH, LCF cycles, landings, calendar days). Convert all to a projected due date using that aircraft's trailing 90-day utilisation rate. Record which limit governs.

### 5.2 Survival model (OC and CM items): Weibull AFT
- Per part number, fit `lifelines.WeibullAFTFitter` on unit lives. Duration = operating FH since installation (or overhaul). Event = `Unscheduled: confirmed failure`. Right-censored = still installed at the as-of date, scheduled removals, NFF removals, cannibalisation.
- Covariates: `hot_share` (share of the unit's FH flown at a hot base and month), `acm_share`, and lot as categorical (one-hot, reference = largest lot). Only include a covariate for a part number if it has enough events; document the rule (for example 15 or more events), otherwise fit plain Weibull.
- Outputs per in-service unit:
  - Conditional failure probability within the next N FH, using the unit's covariates: `P = 1 - S(t + N) / S(t)`.
  - FH until conditional failure probability reaches the criticality threshold tau (section 6), with an 80% interval from the fitted parameter uncertainty (parametric bootstrap, 200 draws, seeded).
  - Explanation: covariate effects as time ratios, for example "Expected life x0.62 (hot-climate share 58%)".
- Export fitted parameters (rho, intercept, coefficients) to JSON so the frontend what-if module can recompute risk exactly.

### 5.3 Engine trend monitoring
Per engine serial, robust slope of EGT margin over the last 150 EFH (`scipy.stats.theilslopes`, with its confidence interval). Compare with the fleet distribution of slopes. Flag if slope is beyond the fleet 95th percentile of deterioration, or projected EFH to the 10 °C threshold is under 100 EFH. Output projected crossing EFH with interval.

### 5.4 Fatigue projection
Per aircraft, FI consumption rate per FH over the trailing 12 months, by mission mix. Project the date FI reaches 100 at current utilisation and mission mix. Flag aircraft projected to reach FI 100 before the planned withdrawal year, and estimate how much shifting ACM sorties to other missions would extend life.

### 5.5 Pattern detectors
- **Lot analysis:** per part number, compare failure rate per 1,000 FH of each lot against the rest (exact conditional binomial test on counts given exposure, Bonferroni corrected). Flag lots with significant excess.
- **Environmental effect:** report the AFT time ratio and p-value for `hot_share` per part number. Flag significant effects (p < 0.01).
- **Repeat snags:** same tail, same ATA chapter, 3 or more snags within 60 days, or 2 or more NFF removals of the same position within 120 days.
- **Precursor rule:** chip detector event within the last 50 FH means oil system inspection plus SOAP sample.

### 5.6 Validation (temporal backtest)
- Train on data up to 15 Nov 2025. Evaluate on 16 Nov 2025 to 15 Nov 2026.
- Survival: concordance index per part number (where 5 or more test events) and pooled; calibration: expected failures (sum of predicted probabilities over the test window) vs observed, by risk decile.
- Recommendation recall: share of test-window unscheduled failures that had an open recommendation of Medium or higher at least 25 FH before the failure. Report the lead-time distribution.
- Alert rate: recommendations per 1,000 FH.
- Pattern recovery: for P1 to P7, the detector used, its statistic, and detected yes/no, computed against `ground_truth.json`.
- Write `validation.json`. If a metric is weak, show it as is. Never tune detectors against the ground truth file. You may adjust planted signal strength in config to be realistic yet detectable, and must note that in `docs/model-notes.md`.

---

## 6. Recommendation engine

**Recommendation object:**
```
id                REC-2026-0412
created           date (engine run date)
tail, position, serial, part_number, ata
action            Inspect | Service | Replace | Troubleshoot | Monitor | Review allocation
title             "Replace engine-driven hydraulic pump HP-0231 at next phase inspection"
priority          Critical | High | Medium | Low
due               { fh_remaining, date, governing: "FH" | "EFH" | "Cycles" | "Landings" | "Calendar" | "Model" }
basis             Rule | Model | Hybrid
evidence[]        typed items: rule_trigger, model_output, trend, history, similar_events
confidence        for model-based: probability and interval
status            Open | Approved | Rejected | Deferred
audit[]           { at, by, role, action, remarks }
work_order        WO number once approved (fictional, generated)
```

**Thresholds (tau) for model-based urgency:** flight safety 0.10, mission 0.20. Urgency = FH until conditional failure probability reaches tau.

**Urgency bands:** U1 within 25 FH or 14 days; U2 within 75 FH or 45 days; U3 within 150 FH or 90 days.

**Priority matrix:**
| | U1 | U2 | U3 |
|---|---|---|---|
| Flight safety | Critical | High | Medium |
| Mission | High | Medium | Low |

Fleet-level items (fatigue allocation) are Medium by default, High if projected FI 100 is within 3 years.

**Action logic examples** (implement all):
- HT item in U1 to U3: Replace (or "Remove for overhaul" for engines), timed to the next scheduled input if it falls before the limit.
- OC item with model urgency in band: Inspect first if the part has an inspection task; Replace if probability before next phase inspection exceeds 0.5.
- Lot flagged: Inspect all in-service units from that lot; also Replace units already in U2 or worse.
- Repeat snag with NFF history: Troubleshoot (wiring and connectors) instead of a further LRU replacement. Text must say why.
- EGT trend flag: Borescope inspection of hot section; Monitor until done.
- Chip detector precursor: Inspect oil filter and chip detector, take SOAP sample.
- Fatigue: Review allocation (rotate away from ACM-heavy tasking) with projected life gain.

**History:** run the engine monthly over the last 12 months (as-of points) to produce historical recommendations with synthetic dispositions: approved where a failure or finding followed, a realistic minority rejected ("Inspected at phase, no findings") or deferred. Reviewers are fictional names with role only, for example "R. Menon (approver)". Target about 30 to 60 open recommendations at the as-of date.

**Roles in the UI (simulated, switch in top bar):** Viewer (read only), Engineer (can add remarks), Approver (can approve, reject, defer). Reject needs a reason. Defer needs a reason and a new review date within 30 days. Approve creates a fictional work order number. The audit trail is append-only.

**Text generation is template-based.** No LLM. Templates per action type must read like an engineering officer wrote them: specific, short, with serial numbers, hours and the reason.

---

## 7. Design direction

**Concept: "Engineering drawing meets servicing record."** The visual language comes from the maintenance world itself: aircraft drawn as schematic planforms with station lines and zones, components with serviceability tags, history shown like a component history card. Calm, precise, quiet. One memorable element (the planform drawing); everything else disciplined.

**Default theme is light** (projectors and conference room screens wash out dark UIs). Dark theme ("hangar night") is fully designed too, with a toggle.

### 7.1 Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#EEF1F3` | `#101418` | Page background (cool aluminium, not cream) |
| `--sheet` | `#FAFBFB` | `#171C21` | Panels, chart surface |
| `--ink` | `#16202A` | `#E8ECEF` | Primary text |
| `--ink-2` | `#4E5A66` | `#AEB8C1` | Secondary text, axis tick labels, drawing lines |
| `--ink-3` | `#7D8893` | `#7D8893` | Muted, non-essential only (never body text) |
| `--rule` | `#D3D9DF` | `#2A3138` | Hairlines, gridlines |
| `--accent` | `#2D4FD6` | `#7C93F2` | Interactive: selection, focus, links, primary buttons |

**Status palette (reserved, always paired with icon and label, never color alone):**
| Status | Hex | Meaning |
|---|---|---|
| Serviceable | `#0CA30C` | Good |
| Monitor | `#FAB219` | Watch |
| Action due | `#EC835A` | Act within band |
| Critical | `#D03B3B` | Act now |

**Chart categorical palette (fixed order, validated for color vision deficiency against these surfaces, do not reorder):**
- Light: `#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300`
- Dark: `#3987e5, #d95926, #199e70, #c98500, #d55181, #0ca30c`
- Mission types map to slots 1 to 6 in the order of the mission table. Color follows the entity, never its rank; filtering must not repaint survivors.
- In light mode, slots 3, 4, 5 are below 3:1 contrast on the sheet, so any chart using them must have a legend plus direct labels or a table view.
- Sequential (heatmaps): single blue ramp `#cde2fb, #9ec5f4, #6da7ec, #3987e5, #256abf, #184f95, #0d366b`.

### 7.2 Typography
- One family: **Archivo** variable (width axis 62 to 125, weight 100 to 900), bundled via `@fontsource-variable/archivo`. Use the width axis for hierarchy instead of a second family.
- Tail numbers: Archivo width 112, weight 700, slight positive tracking. They are the stencilled identity of each aircraft.
- Scale (px): 12, 13, 15 (body), 18, 22, 28, 36, 48. Line height 1.5 body, 1.2 headings.
- `font-variant-numeric: tabular-nums` for tables and axis ticks only. Proportional figures for large standalone numbers.
- Table headers: sentence case, weight 600, `--ink-2`. No all caps, no tracked-out eyebrow labels, no monospace data labels.

### 7.3 Surfaces and shape
- No drop shadows on panels. Hairline borders (`--rule`). Shadows only on overlays (drawer, dialog, popover).
- Radius by hierarchy: panels 8px, controls 6px, status tags 3px.
- Status tags look like servicing tags: small rectangular tag, colored left edge, icon, label. Not pills, not glowing dots.
- No gradients, no glassmorphism, no glow.

### 7.4 The planform drawing (the signature element)
An original, schematic, generic single-engine fighter planform, top view, drawn as an engineering line drawing. Not traced from or resembling any specific real aircraft. Conventional layout to match the component list: trapezoidal mid-mounted wings, all-moving horizontal stabilators, single vertical tail (seen edge-on from above as a thin centreline element).

Starting geometry (viewBox `0 0 600 1000`, centreline x=300, nose at top). Right-half outline points; mirror for the left half and smooth with gentle curves while keeping proportions:
```
(300,40) (312,110) (322,200) (330,300) (334,340) (380,420) (398,470)
(560,600) (560,640) (402,660) (346,690) (346,800) (470,880) (470,905)
(350,915) (336,950) (318,962) (300,962)
```
Canopy: ellipse at (300,235), rx 14, ry 46. Vertical tail: thin rounded rect along centreline from y=780 to y=950, width 6.

Drawing style: 1.25px `--ink-2` strokes, no fill (or 3% ink fill). Overlay a faint engineering grid: fuselage station lines every 100 units labelled `FS 100`, `FS 200`, and so on in 11px `--ink-3`; wing butt lines at plus or minus 100 and 200 labelled `BL 100`. Zone outlines dashed only for zone boundaries (dashes allowed here because they are drawing conventions, never in charts).

Hotspots (grouped by location, each showing the worst status of its components; popover lists components with status tags; click opens the component):
| Hotspot | Position | Components |
|---|---|---|
| Cockpit and avionics bay | (300,300) | Flight control computer, inertial navigation unit, battery, ejection seat CAD/PAD |
| Forward fuselage underside | (300,560) | Radar altimeter |
| Centre fuselage | (300,450) | ECS cooling turbine, fuel boost pump |
| Left main gear / Right main gear | (240,640) / (360,640) | Gear assembly, brake, tyre (that side) |
| Engine bay | (300,780) | Engine, HPT module, fuel control unit, oil pump, jet fuel starter, generator, hydraulic pump |
| Left / right stabilator | (230,880) / (370,880) | Stabilator actuator (that side) |

Hotspot marker: 14px circle in status color, 2px sheet-colored ring, status icon inside, 32px hit area. Keyboard focusable.

Small planforms (fleet flight line): the same drawing scaled down without grid, colored outline by aircraft status.

### 7.5 Motion
One orchestrated moment only: on first load of Fleet overview, the flight line planforms draw in (stroke animation, staggered 40ms, total under 900ms). Everything else: motion only in response to user action (drawer opens, approve confirmation, what-if numbers transitioning). Respect `prefers-reduced-motion` (no stroke animation).

---

## 8. Screens

App shell: narrow left navigation rail (icon plus label), top bar with: product name, as-of date ("Data as of 15 Nov 2026"), global search (Cmd/Ctrl+K: tails, serials, part numbers, recommendation IDs), role switcher, theme toggle, glossary. Fictional data notice in the shell footer. Max content width 1600px, 12-column grid, 24px gutters.

Every chart: hover tooltip, keyboard focus equivalent, legend for 2+ series, and a "Table" toggle that shows the same data as a table. Empty states give direction ("No open recommendations for this aircraft"). Loading never flashes skeletons on revisit.

### 8.1 Fleet overview (`/`)
```
+--------------------------------------------------------------------------+
| Fleet overview                                  Last 12 months  [v]       |
|                                                                          |
| Flight line: 16 small planforms in two rows of 8, each with tail number, |
| status tag, airframe FH, FI bar, open recs count. Click = aircraft page. |
|                                                                          |
| Strip of 5 figures (inline, not cards): Fleet FH (12 mo) | Serviceability|
| | Open recommendations by priority | Items due in 30 days | Unscheduled  |
| removals per 1,000 FH (12 mo, with delta vs prior 12 mo)                 |
|--------------------------------------+-----------------------------------|
| Utilisation: monthly FH by base,     | Due in the next 90 days: timeline |
| 24 months, 2 lines                   | rows = aircraft, marks = due items|
|                                      | colored by priority               |
|--------------------------------------+-----------------------------------|
| Top recommendations (5, Critical/High first) with link to the queue      |
+--------------------------------------------------------------------------+
```

### 8.2 Aircraft (`/aircraft/[tail]`)
Header: tail number (large), status tag, base, induction date, airframe FH, landings, FI, engine serial.
Left (5 cols): the planform drawing with hotspots. Right (7 cols): tabs:
- **Components:** table: ATA, component, position, serial, concept (HT/OC/CM), life display, status, next action. Life display for HT: bar of consumed vs limit with governing limit named. For OC/CM: the "life strip" (8.3).
- **Utilisation:** monthly FH (24 months) with mission mix as stacked bars; FI projection chart (actual to date, projection to 100 with interval band, planned withdrawal line).
- **Engine:** EGT margin over EFH since install with robust trend line, projection to the 10 °C threshold with interval; LCF cycles per module against limits.
- **History:** timeline of maintenance events, removals, snags (filterable).
- **Snags:** snag register for this aircraft, repeat snags grouped and flagged.
- **Recommendations:** open and past for this aircraft.

### 8.3 Component (`/components/[serial]`)
Header: component name, part number, serial, lot, current position (tail and side), concept, criticality.
- **Life strip (novel visual):** a horizontal axis in FH since install. Solid segment = hours used. Beyond "now": the conditional failure probability density from the survival model as a soft area, with markers for next periodic servicing, next phase inspection and the tau crossing point with its interval. One glance tells an engineer where risk sits relative to their next maintenance opportunity.
- Figures: probability of failure before next phase inspection; FH until tau with 80% interval.
- "Why": covariate effects as time ratios in plain words, plus population context ("Fleet units of this part number: 38, confirmed failures: 21").
- Installation history across aircraft (table and mini timeline), removal reasons, shop findings.
- Survival curve of this part number (Kaplan-Meier steps with Weibull fit overlay), this unit's age marked.

### 8.4 Recommendations (`/recommendations`)
Filters in one row: priority, action, basis, aircraft, ATA, status. Table sorted by priority then urgency. Columns: ID, priority tag, aircraft, title, due (FH and date, governing limit), basis, status.
Row click opens a right-side drawer:
1. Title, priority, due, action.
2. **Evidence trace** in order: rule triggers, model output (probability, interval, time ratios), trend (mini chart if relevant), history (related snags and removals), similar past events in the fleet.
3. Actions by role: Approve (creates work order number), Reject (reason required), Defer (reason plus date), Add remark.
4. Audit trail.
Decisions persist in `localStorage` (Zustand persist). Settings has "Reset demo state".

### 8.5 Reliability (`/reliability`)
- Snags by ATA chapter: ranked horizontal bars (count), with cumulative share as a direct text label at the end of each bar. No second axis.
- MTBF and MTBUR per part number with NFF rate (table plus dot plot).
- Unscheduled removal rate per 1,000 FH, monthly, fleet.
- Lot comparison for each part number (P1 must visibly stand out) with test statistic shown.
- Hot vs temperate exposure effect per part number (time ratio with interval, forest-plot style).
- Repeat snag list.

### 8.6 Planning (`/planning`): what-if
Controls: utilisation change (minus 30% to plus 50%), ACM share change (minus 15 to plus 15 points), summer detachment size to Base B (0 to 6 aircraft), horizon (next 3, 6 or 12 months).
Outputs (recomputed instantly in the browser from exported model parameters):
- Expected unscheduled removals in horizon, with 80% interval (Poisson-binomial).
- Hard-time items falling due in horizon, list.
- Maintenance workload in man-hours per month (stacked by scheduled vs unscheduled).
- Projected serviceability per month.
- FI 100 dates per aircraft, baseline vs scenario.
Baseline vs scenario always shown side by side. The TypeScript math must match Python for the baseline scenario (parity test, tolerance 1e-6).

### 8.7 Models and validation (`/models`)
- Model cards for each model: purpose, inputs, method, outputs, known limits.
- Backtest results: concordance index, calibration chart (expected vs observed by decile), recommendation recall and lead-time distribution, alert rate.
- Pattern recovery table P1 to P7 with detector, statistic, detected yes/no.
- A short, honest "What changes with real data" section: connect to their records, refit on their history, thresholds from their approved maintenance schedule, validation with their engineers.
- All labelled as computed on synthetic data.

### 8.8 Data and integration (`/data`)
- Pipeline diagram: sources, bronze, silver, gold, models, recommendations (drawn in SVG in the same drawing style).
- Source table: file, rows in bronze, rows in silver, issues resolved, last run.
- Data quality checks with pass/fail and counts.
- Download links for the bronze CSVs (bundled).

### 8.9 Reports (`/reports`)
Printable fleet report (print stylesheet, A4 portrait): fleet utilisation, serviceability, top recommendations, due items, reliability highlights. Also per-aircraft report from the aircraft page. "Print or save as PDF" uses the browser print dialog.

---

## 9. Technical architecture

```
pre-poc/
  SPEC.md
  CLAUDE.md                 short rules: read SPEC.md, phases, checks
  README.md                 how to run, how to demo, how to deploy
  Makefile                  make data | models | export | web | test | all
  engine/
    pyproject.toml
    src/pre_engine/
      config.py             all fictional parameters and seed
      generate.py           fleet simulation, writes bronze + ground_truth
      pipeline.py           bronze -> silver -> gold, data quality checks
      rules.py              hard-time rules
      models/survival.py    Weibull AFT, bootstrap intervals
      models/trends.py      EGT trend
      models/fatigue.py     FI projection
      models/patterns.py    lot, environment, repeat snag, precursor
      recommend.py          recommendation engine + history
      validate.py           temporal backtest, pattern recovery
      export.py             writes web/public/data/*.json
    tests/
    data/bronze, silver, gold (gitignored)
  web/
    Next.js app (App Router, TypeScript strict)
    public/data/*.json      exported, committed so the web builds without Python
    src/lib/model-math.ts   Weibull/AFT math shared by what-if
    src/components/charts/  chart kit
    src/components/planform/
    tests/ (vitest, playwright)
  docs/model-notes.md, docs/demo-script.md
```

**Frontend stack:** Next.js (latest stable) with `output: 'export'` (fully static), React, TypeScript strict, Tailwind CSS, shadcn/ui (Radix) for dialog, sheet, tabs, select, slider, tooltip, command palette; sonner for toasts; Zustand for review state; TanStack Table for tables; charts hand-built with `d3-scale`, `d3-shape`, `d3-array` rendering React SVG (full control over marks, hover, gaps; no chart library peer-dependency issues). Static params for all tails and serials.

**Chart kit rules:** 2px lines, thin bars with 4px rounded data ends anchored at baseline, 2px gap between adjacent fills, solid hairline gridlines (never dashed), one y-axis per chart (never dual axis), selective direct labels (not every point), tooltip plus crosshair on line charts, hit areas at least 24px, every chart has a table view. Confidence intervals as soft bands at 15 to 20% opacity of the series color.

**Data size:** split JSON by aircraft and by part number; keep the initial page payload small. Lazy-load per-aircraft data.

**Performance:** Fleet overview interactive under 2 seconds on a mid-range laptop from a local static server.

---

## 10. Testing

**Python (pytest):** all data quality checks pass on silver; determinism (run twice, compare file hashes); no NaN or infinite values in exports; every recommendation has at least one evidence item; no HT item overdue; all seven planted patterns recovered (test fails loudly if not; the fix is in the generator's signal strength or a real detector bug, never special-casing).

**TypeScript (vitest):** model-math parity with Python fixtures; priority matrix; HT "whichever comes first" logic; date formatting.

**End-to-end (Playwright):** visit every route in light and dark at 1280x720, 1440x900, 1920x1080; assert zero console errors; capture screenshots into `web/tests/screenshots/`; axe accessibility checks with no serious or critical violations; recommendation approve, reject (requires reason), defer (requires date) flows; role restrictions; reset demo state; print view renders.

---

## 11. Build phases and acceptance checks

Stop after each phase and report: what was built, check results, anything that deviated from this spec and why.

**Phase 1: Simulation and pipeline.** Config, generator, bronze files, ground truth, silver, gold, data quality checks.
Accept: all quality checks pass; injected bronze issues found and resolved with logged counts; fleet utilisation, removal counts and failure counts per part number printed in a summary table that looks plausible against section 2; determinism test passes.

**Phase 2: Models, recommendations, validation.** Rules, survival, trends, fatigue, patterns, recommendation engine with history, backtest, export.
Accept: all P1 to P7 recovered; validation metrics computed and printed; 30 to 60 open recommendations with sensible priority mix (a few Critical, not dozens); spot-check five recommendations end to end and print their evidence; exports validated against a JSON schema.

**Phase 3: Frontend foundation.** App shell, tokens, typography, theme toggle, chart kit with table views, planform component with hotspots, data loading.
Accept: chart kit demo page (dev only) showing every chart type in light and dark; planform renders cleanly at all sizes; screenshots reviewed by you before continuing.

**Phase 4: Screens.** All screens in section 8 with real data.
Accept: every number traces to exported data; Playwright suite passes; screenshots reviewed for overflow, collisions, alignment.

**Phase 5: Polish and QA.** Command palette, flight line animation, print view, empty and edge states, copy review against section 0 rule 6, accessibility pass, performance pass, `docs/demo-script.md`.
Accept: full test suite green; a final screenshot review of every screen; grep the codebase and copy for em dashes and en dashes (must be zero); grep for any real aircraft type names (must be zero).

**Phase 6: Deploy.** Static build served locally (`npx serve web/out`) and tested with network disabled. Then deploy to Vercel (free tier) or Cloudflare Pages as a static site. README updated with the steps.

---

## 12. Demo story (write the full version in `docs/demo-script.md`)

Six to seven minutes:
1. **Fleet overview:** 16 aircraft at a glance, serviceability, what is due.
2. **The data:** messy source records cleaned with every fix counted; quality checks green.
3. **FX-307:** the recurring radar altimeter snag. Two LRU swaps, both NFF. PRE recommends troubleshooting the wiring instead of a third replacement. Engineers recognise this instantly.
4. **The hydraulic pump lot:** reliability page shows lot `L-2207` failing early; PRE recommends inspecting every in-service unit from that lot.
5. **FX-311 engine:** EGT margin trend projected to cross the threshold; borescope recommended before it becomes a removal.
6. **Approve a recommendation** as approver, see the work order and audit trail.
7. **What-if:** raise utilisation 25% for an exercise; watch due items, workload and serviceability move.
8. **Validation:** honest backtest numbers and the planted-pattern recovery table. Close with "what changes with your real data".
