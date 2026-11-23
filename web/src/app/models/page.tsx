import { Check, X } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { getModels, getTypes } from "@/lib/data";
import type { ValidationPayload } from "@/lib/validation-types";
import { BacktestSection } from "./backtest-section";

export default function ModelsPage() {
  const { validation: rawValidation } = getModels();
  const typeNames = Object.fromEntries(getTypes().map((t) => [t.key, t.name]));
  const validation = rawValidation as unknown as ValidationPayload | undefined;

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Models and validation</h1>

        {validation ? (
          <>
            {validation.backtest ? (
              <BacktestSection bt={validation.backtest} typeNames={typeNames} />
            ) : (
              <p className="text-[12px] text-(--ink-2)">The temporal backtest is not in this export. Run validate before export.</p>
            )}

            <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[13px] font-semibold text-(--ink)">Pattern recovery</h3>
                <span className="text-[12px] tabular text-(--ink-2)">{validation.patterns_detected} planted patterns detected</span>
              </div>
              <p className="mb-3 text-[11px] text-(--ink-3)">{validation.note}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-(--ink-2)">
                      <th className="pb-1.5 pr-3 font-semibold">ID</th>
                      <th className="pb-1.5 pr-3 font-semibold">Pattern</th>
                      <th className="pb-1.5 pr-3 font-semibold">Detector</th>
                      <th className="pb-1.5 pr-3 font-semibold">Statistic</th>
                      <th className="pb-1.5 font-semibold">Detected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.pattern_recovery.map((p) => (
                      <tr key={p.id} className="border-t border-(--rule)">
                        <td className="py-1.5 pr-3 tabular text-(--ink-2)">{p.id}</td>
                        <td className="py-1.5 pr-3 text-(--ink)">{p.title}</td>
                        <td className="py-1.5 pr-3 text-(--ink-2)">{p.detector}</td>
                        <td className="py-1.5 pr-3 text-(--ink-2)">{p.statistic}</td>
                        <td className="py-1.5">
                          {p.planted === false ? (
                            <span className="text-(--ink-2)">Not planted</span>
                          ) : p.detected ? (
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
            </section>

            <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
              <h3 className="mb-1 text-[13px] font-semibold text-(--ink)">Model fit summary (in-sample)</h3>
              <p className="mb-3 text-[11px] text-(--ink-3)">
                Production models fitted on all data and scored on the same data. Optimistic by construction; the backtest above is
                the held-out test.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-(--ink-2)">
                      <th className="pb-1.5 font-semibold">Part</th>
                      <th className="pb-1.5 font-semibold">Units</th>
                      <th className="pb-1.5 font-semibold">Events</th>
                      <th className="pb-1.5 font-semibold">In-sample concordance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.model_fit_summary.map((r) => (
                      <tr key={r.part_number} className="border-t border-(--rule)">
                        <td className="py-1.5 text-(--ink)">{r.name}</td>
                        <td className="py-1.5 tabular text-(--ink-2)">{r.n_units}</td>
                        <td className="py-1.5 tabular text-(--ink-2)">{r.n_events}</td>
                        <td className="py-1.5 tabular text-(--ink-2)">{r.in_sample_concordance ?? "Not computed"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          <p className="text-[12px] text-(--ink-2)">Validation has not been run yet.</p>
        )}

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4 text-[12px] text-(--ink-2)">
          <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">What changes with real data</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>Connect to your maintenance and flight data records instead of synthetic extracts.</li>
            <li>Refit every model on your fleet&apos;s actual history and rerun this backtest on it.</li>
            <li>Set urgency thresholds and task card hours from your approved maintenance schedule and procedures.</li>
            <li>Validate detections and recommendations with your own engineers before any output is trusted operationally.</li>
            <li>
              Move review decisions from this browser&apos;s local storage to a shared, access-controlled service, so approvals,
              rejections and the audit trail are the same for every reviewer.
            </li>
          </ul>
        </section>

        <p className="text-[11px] text-(--ink-3)">All figures on this page are computed on synthetic, fictional data.</p>
      </div>
    </AppShell>
  );
}
