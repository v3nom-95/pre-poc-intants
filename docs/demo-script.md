# Demo script: PRE (Predictive Recommendation Engine)

Six to seven minutes. Fictional 16-aircraft fleet, fully synthetic data, offline static site.

## 0. Open on Fleet overview (`/`)

"This is PRE: a proof of concept of the AI-based predictive recommendation engine
from the SoW. Sixteen aircraft, five years of simulated flying and maintenance
history, fully offline (this runs from a laptop with Wi-Fi off)."

Point at the flight line: status colors, FI bars, open-recommendation counts.
Point at the five headline figures and the utilisation chart. Everything on
this page is computed from the pipeline underneath, nothing is hardcoded.

## 1. The data (`/data`)

"Before any of this gets to a model, it goes through a real ingestion pipeline."

Show the bronze to silver to gold pipeline diagram, the "issues found and
resolved" counts (duplicate sorties, imputed durations, normalised dates,
inferred ATA codes), and the nine data-quality checks, all passing. This is
the "historical operational data integration module" deliverable: messy
source records cleaned, every fix counted.

## 2. FX-307: the recurring radar altimeter snag

Navigate to `/aircraft/FX-307` → Snags tab, then Recommendations tab.

"FX-307 has had the same radar altimeter fault reported repeatedly. Two LRU
swaps already happened, both came back 'no fault found' in the shop."

Open the Troubleshoot recommendation in `/recommendations` (filter: Aircraft
= FX-307). Show the evidence trace: the NFF history is the evidence, and the
recommended action is "troubleshoot the wiring" instead of a third LRU swap.
"An engineer who's seen this before recognises this instantly: it's exactly
the right call, and the system explains why instead of just flagging it."

## 3. The hydraulic pump lot (`/reliability`)

Scroll to "Manufacturing lot comparison."

"Lot L-2207 hydraulic pumps are failing at roughly four times the rate of the
rest of the fleet, and it's statistically significant, not a coincidence."

Point to the `/recommendations` queue filtered by part: every in-service
unit from that lot gets an Inspect or Replace recommendation, prioritised by
how close each one is to failure.

## 4. FX-311 engine: EGT margin trend

Navigate to `/aircraft/FX-311` → Engine tab.

"This engine's exhaust gas temperature margin is deteriorating about three
times faster than the fleet norm. The model projects it crosses the safety
threshold in about 60 engine hours." Point at the open Monitor/Borescope
recommendation and its evidence (the Theil-Sen trend slope and confidence
interval): "this gets caught before it becomes an unscheduled removal, not
after."

## 5. Approve a recommendation

Switch role to Approver (top bar). Open any Open recommendation, click
Approve. Show the work order number generated and the audit trail entry.
"Every decision is logged, append-only: who approved it, when, and why."
Also show Reject (reason required) and Defer (reason + re-review date) on a
different row to demonstrate both paths.

## 6. What-if (`/planning`)

Move the utilisation slider to +25%.

"If we ramp this fleet up 25% for an exercise, here's what happens to
expected removals, workload and serviceability, recomputed instantly in the
browser, not a server round-trip." Point out the fatigue index table: FX-309
is the one aircraft already flagged to reach its fatigue limit before its
planned withdrawal year, because of its ACM-heavy tasking.

## 7. Validation (`/models`)

Scroll to the pattern-recovery table.

"We planted seven known patterns in the synthetic data (a bad lot, a
wiring fault behind a recurring snag, an engine trend, a fatigue risk, and
so on) and ran the same models a user would see. Six of seven were
recovered and are shown here with the actual statistic. The seventh
honestly reports as not detected, because at this fleet's size, the
signal isn't strong enough to be statistically confident: we're not going
to pretend otherwise." Close on "What changes with real data": real history,
real thresholds from an approved maintenance schedule, and validation with
engineers who know the type.

## Notes for whoever is driving

- Role switcher (top bar) controls what actions are available: Viewer is
  read-only, Engineer can add remarks, Approver can approve/reject/defer.
- "Reset demo state" on the Recommendations page clears every decision made
  in the browser session (stored in localStorage) back to the baseline.
- Theme toggle (top bar, moon/sun icon) switches light/dark, both are fully
  designed, not auto-inverted. Default is light (built for projectors).
- Cmd/Ctrl+K opens global search across tails, serials, part numbers and
  recommendation IDs.
- Every chart has a "Table" toggle in its top-right corner showing the same
  data as a table, if a number needs to be read exactly.

## Mixed fleet additions

### TX-404: the pressurisation snag (`/aircraft/TX-404`)
"The fleet is not only fighters." Show the transport section on Fleet overview, then TX-404: repeated cabin altitude fluctuation snags (ATA 21), two outflow valve removals that came back no fault found. PRE recommends troubleshooting the ducting and door seals instead of a third valve change, and cites the task card.

### CX-502 engine 3 (`/aircraft/CX-502`, Engines tab)
Four engines, each trended on its own ITT margin. Engine 3 is deteriorating about three times faster than the fleet norm and is projected to reach its limit in about 49 EFH. Show the planform hotspot on the right inboard nacelle.

### Ask PRE
Ask "What is wrong with TX-404?", "Show the ITT trend for CX-502 engine 3" and "Compare utilisation by aircraft type". Every answer is computed from the records and links to its sources; there is no language model.

### Honest validation (`/models`)
The backtest replays every recommendation source month by month using only the data available at the time. Across all sources PRE warned ahead of about 1 in 5 test-year failures (18%), with a median 141 FH of notice; the survival model ranks risk well (concordance about 0.71) and its expected failure count is close to what happened (44 expected, 40 observed). Show the trade-off chart: halving the thresholds roughly doubles early warning at about 2.6 times the alerts. Say plainly that the thresholds are a choice for your engineers on real data. All nine planted patterns are recovered.
