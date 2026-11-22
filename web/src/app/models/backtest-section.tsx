"use client";

import { Check, X } from "lucide-react";
import { ChartFrame, ChartLegend } from "@/components/charts/chart-frame";
import { ChartTable } from "@/components/charts/chart-table";
import { LineChart } from "@/components/charts/line-chart";
import { RankedBarChart } from "@/components/charts/ranked-bar-chart";
import { formatDate, formatNumber, formatPct } from "@/lib/format";
import type { Backtest } from "@/lib/validation-types";

const EXPECTED_COLOR = "var(--chart-cat-1)";
const OBSERVED_COLOR = "var(--chart-cat-2)";

function fmt3(v: number | null | undefined) {
  return v === null || v === undefined ? "Not computed" : formatNumber(v, 3);
}

function calibrationVerdict(ratio: number | null): string {
  if (ratio === null) return "No failures were expected in the test window, so calibration cannot be judged.";
  if (ratio < 0.8) return "The models over-predict: fewer failures happened than they expected.";
  if (ratio > 1.25) return "The models under-predict: more failures happened than they expected.";
  return "Expected and observed failures are close overall.";
}

export function BacktestSection({ bt, typeNames = {} }: { bt: Backtest; typeNames?: Record<string, string> }) {
  const c = bt.concordance.summary;
  const cal = bt.calibration.summary;
  const r = bt.recall;
  const recallPct = r.recall === null ? null : r.recall * 100;

  const calibrationSeries = [
    {
      id: "expected",
      label: "Expected failures",
      color: EXPECTED_COLOR,
      points: bt.calibration.deciles.map((d) => ({ x: d.decile, y: d.expected_failures })),
    },
    {
      id: "observed",
      label: "Observed failures",
      color: OBSERVED_COLOR,
      points: bt.calibration.deciles.map((d) => ({ x: d.decile, y: d.observed_failures })),
    },
  ];

  return (
    <section aria-labelledby="backtest-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="backtest-heading" className="text-[22px] font-semibold text-(--ink)">
          Temporal backtest
        </h2>
        <p className="mt-1 max-w-[900px] text-[13px] text-(--ink-2)">
          Models trained only on data up to {formatDate(bt.cutoff)}, then tested on what actually happened from{" "}
          {formatDate(bt.test_start)} to {formatDate(bt.test_end)}. Training used {formatNumber(bt.training.n_legs)} unit
          installations with {formatNumber(bt.training.n_events)} confirmed failures and fitted{" "}
          {formatNumber(bt.training.parts_fitted)} part-number models. Computed on synthetic data; weak results are shown as they are.
        </p>
      </div>

      <div aria-label="Backtest figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Figure
          label="Concordance (pooled)"
          value={fmt3(c.pooled)}
          sub={`${formatNumber(c.n_units)} units, ${formatNumber(c.n_test_events)} test failures; 0.5 is chance`}
        />
        <Figure
          label="Failures: observed vs expected"
          value={`${formatNumber(cal.observed_total)} vs ${formatNumber(cal.expected_total, 1)}`}
          sub={cal.brier_score === null ? "" : `Brier score ${formatNumber(cal.brier_score, 3)}`}
        />
        <Figure
          label="Recommendation recall"
          value={recallPct === null ? "Not computed" : formatPct(recallPct)}
          sub={`${formatNumber(r.covered)} of ${formatNumber(r.failures_in_test_window)} failures alerted ${formatNumber(r.lead_min_fh)} FH or more ahead, all sources`}
        />
        <Figure
          label="Median lead time"
          value={r.lead_time_fh ? `${formatNumber(r.lead_time_fh.median, 1)} FH` : "Not computed"}
          sub={r.lead_time_days ? `${formatNumber(r.lead_time_days.median)} days` : "No covered failures"}
        />
        <Figure
          label="Alert rate"
          value={r.alert_rate_per_1000fh === null ? "Not computed" : formatNumber(r.alert_rate_per_1000fh, 1)}
          sub={`Alerts per 1,000 FH (${formatNumber(r.alerts_raised)} alerts over ${formatNumber(r.test_window_fh)} FH)`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <ChartFrame
            title="Calibration: expected vs observed failures by risk decile"
            legend={
              <ChartLegend
                items={[
                  { label: "Expected", color: EXPECTED_COLOR },
                  { label: "Observed", color: OBSERVED_COLOR },
                ]}
              />
            }
            chart={
              <div>
                <LineChart
                  series={calibrationSeries}
                  xTickFormat={(x) => `${x}`}
                  yTickFormat={(y) => formatNumber(y, y < 10 ? 1 : 0)}
                  yMin={0}
                />
                <p className="mt-1 text-[11px] text-(--ink-3)">
                  Risk decile on the horizontal axis (1 is the lowest predicted risk, 10 the highest).
                </p>
              </div>
            }
            table={
              <ChartTable
                columns={["Risk decile", "Units", "Mean predicted probability", "Expected failures", "Observed failures"]}
                rows={bt.calibration.deciles.map((d) => [
                  d.decile,
                  d.n_units,
                  formatPct(d.mean_predicted_prob * 100, 1),
                  formatNumber(d.expected_failures, 2),
                  d.observed_failures,
                ])}
              />
            }
          />
          <p className="mt-3 text-[12px] text-(--ink-2)">
            {calibrationVerdict(cal.observed_to_expected)} {formatNumber(cal.observed_total)} failures observed against{" "}
            {formatNumber(cal.expected_total, 1)} expected
            {cal.top_decile_share_of_failures !== null
              ? `; the highest-risk decile held ${formatPct(cal.top_decile_share_of_failures * 100)} of the failures.`
              : "."}
          </p>
          <EntryDiagnostics bt={bt} />
        </div>

        <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <ChartFrame
            title="Lead time of covered failures"
            chart={
              <RankedBarChart
                data={r.lead_time_histogram.map((b) => ({ label: b.label, value: b.count }))}
                valueFormat={(v) => `${formatNumber(v)} failures`}
              />
            }
            table={
              <ChartTable
                columns={["Lead time", "Failures"]}
                rows={r.lead_time_histogram.map((b) => [b.label, b.count])}
              />
            }
          />
          <p className="mt-3 text-[12px] text-(--ink-2)">
            {r.lead_time_fh && r.lead_time_days
              ? `Lead time from the first open alert to the failure: ${formatNumber(r.lead_time_fh.min, 1)} to ${formatNumber(
                  r.lead_time_fh.max,
                  1
                )} FH (median ${formatNumber(r.lead_time_fh.median, 1)} FH), ${formatNumber(r.lead_time_days.min)} to ${formatNumber(
                  r.lead_time_days.max
                )} days.`
              : "No failure in the test window had an alert open far enough ahead."}
          </p>
        </div>
      </div>

      {r.by_source && r.by_source.length > 0 && <SourcesPanel bt={bt} />}
      {r.tau_tradeoff && r.tau_tradeoff.length > 0 && <TradeoffPanel bt={bt} />}

      <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-1 text-[13px] font-semibold text-(--ink)">Concordance by part number</h3>
        <p className="mb-3 text-[12px] text-(--ink-2)">
          How well each model ranks units by remaining life (1 is perfect, 0.5 is chance). Scored only where the test window
          has {formatNumber(c.min_test_events)} or more failures: {formatNumber(c.parts_evaluated)} of{" "}
          {formatNumber(c.parts_total)} part numbers qualify
          {c.event_weighted_mean_of_parts !== null
            ? `, event-weighted mean ${formatNumber(c.event_weighted_mean_of_parts, 3)}.`
            : ". The pooled figure above ranks all units together."}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-semibold">Part</th>
                <th className="pb-1.5 font-semibold">Part number</th>
                <th className="pb-1.5 text-right font-semibold">Units in test</th>
                <th className="pb-1.5 text-right font-semibold">Test failures</th>
                <th className="pb-1.5 text-right font-semibold">Concordance</th>
              </tr>
            </thead>
            <tbody>
              {bt.concordance.per_part.map((p) => (
                <tr key={p.part_number} className="border-t border-(--rule)">
                  <td className="py-1.5 text-(--ink)">{p.name}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{p.part_number}</td>
                  <td className="py-1.5 text-right tabular text-(--ink-2)">{formatNumber(p.n_units)}</td>
                  <td className="py-1.5 text-right tabular text-(--ink-2)">{formatNumber(p.n_test_events)}</td>
                  <td className="py-1.5 text-right tabular text-(--ink)">
                    {p.concordance === null ? (
                      <span className="text-(--ink-2)">Too few failures</span>
                    ) : (
                      formatNumber(p.concordance, 3)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-1 text-[13px] font-semibold text-(--ink)">Test-window failures and their alerts</h3>
        <p className="mb-3 text-[12px] text-(--ink-2)">
          Every unscheduled confirmed failure from {formatDate(bt.test_start)} to {formatDate(bt.test_end)}, whether a Medium or
          higher recommendation from any source was open on it at least {formatNumber(r.lead_min_fh)} FH before, and which source
          raised it first.
        </p>
        <div className="max-h-[360px] overflow-auto" tabIndex={0} role="region" aria-label="Test-window failures and their alerts">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-(--sheet)">
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-semibold">Failure date</th>
                <th className="pb-1.5 font-semibold">Aircraft</th>
                <th className="pb-1.5 font-semibold">Component</th>
                <th className="pb-1.5 font-semibold">Serial</th>
                <th className="pb-1.5 font-semibold">First alert source</th>
                <th className="pb-1.5 text-right font-semibold">Lead time</th>
                <th className="pb-1.5 font-semibold">Covered</th>
              </tr>
            </thead>
            <tbody>
              {r.failures.map((f) => (
                <tr key={`${f.serial}-${f.failure_date}`} className="border-t border-(--rule)">
                  <td className="py-1.5 tabular whitespace-nowrap text-(--ink-2)">{formatDate(f.failure_date)}</td>
                  <td className="py-1.5 whitespace-nowrap text-(--ink)">{f.tail}</td>
                  <td className="py-1.5 text-(--ink)">{f.name}</td>
                  <td className="py-1.5 tabular text-(--ink-2)">{f.serial}</td>
                  <td className="py-1.5 text-(--ink-2)">{f.alert_basis ?? "No alert"}</td>
                  <td className="py-1.5 text-right tabular whitespace-nowrap text-(--ink-2)">
                    {f.lead_fh === null ? "Not applicable" : `${formatNumber(f.lead_fh, 1)} FH, ${formatNumber(f.lead_days ?? 0)} days`}
                  </td>
                  <td className="py-1.5">
                    {f.covered ? (
                      <span className="inline-flex items-center gap-1 font-medium text-(--ink)">
                        <Check className="size-3.5 text-(--status-serviceable)" strokeWidth={2.25} aria-hidden /> Yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-medium text-(--ink)">
                        <X className="size-3.5 text-(--status-action-due)" strokeWidth={2.25} aria-hidden /> No
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(r.by_type.length > 0 || bt.calibration.by_type.length > 0) && (
        <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Results by aircraft type</h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-(--ink-2)">
                <th className="pb-1.5 font-semibold">Type</th>
                <th className="pb-1.5 text-right font-semibold">Failures</th>
                <th className="pb-1.5 text-right font-semibold">Covered</th>
                <th className="pb-1.5 text-right font-semibold">Recall</th>
                <th className="pb-1.5 text-right font-semibold">Expected failures</th>
                <th className="pb-1.5 text-right font-semibold">Observed failures</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(new Set([...r.by_type.map((t) => t.type), ...bt.calibration.by_type.map((t) => t.type)])).map((t) => {
                const rr = r.by_type.find((x) => x.type === t);
                const cc = bt.calibration.by_type.find((x) => x.type === t);
                return (
                  <tr key={t} className="border-t border-(--rule)">
                    <td className="py-1.5 text-(--ink)">{typeNames[t] ?? t}</td>
                    <td className="py-1.5 text-right tabular text-(--ink-2)">{rr ? formatNumber(rr.failures) : "None"}</td>
                    <td className="py-1.5 text-right tabular text-(--ink-2)">{rr ? formatNumber(rr.covered) : "None"}</td>
                    <td className="py-1.5 text-right tabular text-(--ink-2)">
                      {rr && rr.recall !== null ? formatPct(rr.recall * 100) : "Not computed"}
                    </td>
                    <td className="py-1.5 text-right tabular text-(--ink-2)">{cc ? formatNumber(cc.expected, 1) : "None"}</td>
                    <td className="py-1.5 text-right tabular text-(--ink-2)">{cc ? formatNumber(cc.observed) : "None"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-(--ink-2)">
            Shown as computed on synthetic data, not tuned per type. Covered means a Medium or higher recommendation from any
            source was open on that unit at least {formatNumber(r.lead_min_fh)} FH before the failure; a type with no covered
            failures had no such recommendation ahead of any of its test-window failures.
          </p>
        </div>
      )}

      <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
        <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">How the backtest is run</h3>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[12px] text-(--ink-2)">
          <li>
            No leakage: the training table is rebuilt as it would have looked on {formatDate(bt.cutoff)}. Units still fitted on that
            date are censored there, and only flying up to that date counts towards age and covariates.
          </li>
          {bt.simplifications.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function EntryDiagnostics({ bt }: { bt: Backtest }) {
  const entry = bt.calibration.by_entry ?? [];
  const hist = entry.find((e) => e.entered_with_history);
  const fresh = entry.find((e) => !e.entered_with_history);
  const fit = bt.calibration.in_window_fit;
  if (!hist && !fresh) return null;
  const ratio = (o: number, e: number) => (e > 0 ? o / e : null);
  const histRatio = hist ? ratio(hist.observed, hist.expected) : null;
  const fitRatio = fit ? ratio(fit.observed, fit.expected_in_window_fit) : null;
  // Interpretation only when the data shows it: the shortfall sits in units
  // that entered the window with history, and a fit without them is close.
  const pointsToEntry = histRatio !== null && histRatio > 1.25 && fitRatio !== null && Math.abs(fitRatio - 1) <= 0.2;
  return (
    <div className="mt-3 border-t border-(--rule) pt-3 text-[12px] text-(--ink-2)">
      <p>
        {hist
          ? `Units already fitted when the data window opened: ${formatNumber(hist.observed)} failures observed against ${formatNumber(hist.expected, 1)} expected (${formatNumber(hist.n_units)} units). `
          : ""}
        {fresh
          ? `Units installed inside the window: ${formatNumber(fresh.observed)} against ${formatNumber(fresh.expected, 1)} (${formatNumber(fresh.n_units)} units).`
          : ""}
      </p>
      {fit && (
        <p className="mt-1">
          Diagnostic: the same {formatNumber(fit.n_units)} test units ({formatNumber(fit.parts)} part numbers) scored by a fit on
          legs installed inside the window only expect {formatNumber(fit.expected_in_window_fit, 1)} failures against{" "}
          {formatNumber(fit.observed)} observed (production fit: {formatNumber(fit.expected_production_fit, 1)}).
        </p>
      )}
      {pointsToEntry && (
        <p className="mt-1">
          The shortfall sits in units that entered the window with history. That pattern fits entry ages that are not
          independent of failure time, which the delayed-entry fit assumes; see the validation notes.
        </p>
      )}
    </div>
  );
}

function SourcesPanel({ bt }: { bt: Backtest }) {
  const r = bt.recall;
  const rows = r.by_source ?? [];
  return (
    <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
      <h3 className="mb-1 text-[13px] font-semibold text-(--ink)">Recall by recommendation source</h3>
      <p className="mb-3 text-[12px] text-(--ink-2)">
        Every source in the live engine replayed at monthly points with only the data available at the time. Alone counts the
        failures that source would have covered by itself; first alert credits each covered failure to the source that flagged
        it earliest.
        {r.rules_and_model_only
          ? ` Hard-time rules and the survival model together cover ${formatNumber(r.rules_and_model_only.covered)} of ${formatNumber(r.failures_in_test_window)}.`
          : ""}
      </p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Recall by recommendation source">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-(--ink-2)">
              <th className="pb-1.5 font-semibold">Source</th>
              <th className="pb-1.5 text-right font-semibold">Covered alone</th>
              <th className="pb-1.5 text-right font-semibold">Recall alone</th>
              <th className="pb-1.5 text-right font-semibold">First alert for</th>
              <th className="pb-1.5 text-right font-semibold">Alerts raised</th>
              <th className="pb-1.5 text-right font-semibold">Alerts per 1,000 FH</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.source} className="border-t border-(--rule)">
                <td className="py-1.5 text-(--ink)">{b.source}</td>
                <td className="py-1.5 text-right tabular text-(--ink-2)">
                  {b.can_cover ? formatNumber(b.covered) : "Not applicable"}
                </td>
                <td className="py-1.5 text-right tabular text-(--ink-2)">
                  {b.can_cover && b.recall !== null ? formatPct(b.recall * 100, 1) : "Not applicable"}
                </td>
                <td className="py-1.5 text-right tabular text-(--ink-2)">
                  {b.can_cover ? formatNumber(b.first_alert_for) : "Not applicable"}
                </td>
                <td className="py-1.5 text-right tabular text-(--ink-2)">{formatNumber(b.alerts_raised)}</td>
                <td className="py-1.5 text-right tabular text-(--ink-2)">
                  {b.alert_rate_per_1000fh === null ? "Not computed" : formatNumber(b.alert_rate_per_1000fh, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-(--ink-2)">
        Fatigue recommendations are aircraft tasking reviews: they add to the alert rate but cannot cover a component failure.
      </p>
    </div>
  );
}

const MODEL_ONLY_COLOR = "var(--chart-cat-1)";
const ALL_SOURCES_COLOR = "var(--chart-cat-2)";

function TradeoffPanel({ bt }: { bt: Backtest }) {
  const rows = [...(bt.recall.tau_tradeoff ?? [])].sort(
    (a, b) => (a.model_alert_rate_per_1000fh ?? 0) - (b.model_alert_rate_per_1000fh ?? 0)
  );
  const prod = rows.find((t) => t.tau_multiplier === 1);
  const series = [
    {
      id: "model",
      label: "Survival model alone",
      color: MODEL_ONLY_COLOR,
      points: rows.map((t) => ({ x: t.model_alert_rate_per_1000fh ?? 0, y: (t.model_recall ?? 0) * 100 })),
    },
    {
      id: "all",
      label: "All sources",
      color: ALL_SOURCES_COLOR,
      points: rows.map((t) => ({ x: t.model_alert_rate_per_1000fh ?? 0, y: (t.all_sources_recall ?? 0) * 100 })),
    },
  ];
  const tableRows = [...rows]
    .sort((a, b) => a.tau_multiplier - b.tau_multiplier)
    .map((t) => [
      `${formatNumber(t.tau_multiplier, 1)}x${t.tau_multiplier === 1 ? " (production)" : ""}`,
      t.model_alert_rate_per_1000fh === null ? "Not computed" : formatNumber(t.model_alert_rate_per_1000fh, 2),
      t.model_recall === null ? "Not computed" : formatPct(t.model_recall * 100, 1),
      t.all_sources_recall === null ? "Not computed" : formatPct(t.all_sources_recall * 100, 1),
      t.all_alert_rate_per_1000fh === null ? "Not computed" : formatNumber(t.all_alert_rate_per_1000fh, 2),
    ]);
  return (
    <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
      <ChartFrame
        title="Trade-off: recall against survival alerts per 1,000 FH (analysis only)"
        legend={
          <ChartLegend
            items={[
              { label: "Survival model alone", color: MODEL_ONLY_COLOR },
              { label: "All sources", color: ALL_SOURCES_COLOR },
            ]}
          />
        }
        chart={
          <LineChart
            series={series}
            xTickFormat={(x) => formatNumber(x, 0)}
            xUnit="alerts per 1,000 FH"
            yTickFormat={(y) => formatPct(y)}
            yMin={0}
            linear
            showPoints
            markers={
              prod && prod.model_alert_rate_per_1000fh !== null
                ? [{ x: prod.model_alert_rate_per_1000fh, label: "Production threshold" }]
                : []
            }
          />
        }
        table={
          <ChartTable
            columns={[
              "Threshold (times section 6 tau)",
              "Survival alerts per 1,000 FH",
              "Survival recall",
              "All-source recall",
              "All alerts per 1,000 FH",
            ]}
            rows={tableRows}
          />
        }
      />
      <p className="mt-3 text-[12px] text-(--ink-2)">
        The survival source re-run at multiples of the section 6 probability thresholds (lower thresholds alert earlier and more
        often). Every other source is unchanged. Horizontal axis: survival alerts per 1,000 FH. This shows the cost of earlier
        warning; production keeps the section 6 thresholds.
      </p>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[8px] border border-(--rule) bg-(--sheet) p-4"
      style={{ borderLeft: "3px solid var(--accent)" }}
    >
      <span className="text-[11px] leading-tight text-(--ink-2)">{label}</span>
      <span className="figure-display text-[28px] leading-none font-semibold text-(--ink)">{value}</span>
      {sub ? <span className="text-[11px] text-(--ink-3)">{sub}</span> : null}
    </div>
  );
}
