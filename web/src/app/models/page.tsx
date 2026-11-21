import { AppShell } from "@/components/shell/app-shell";
import { getModels } from "@/lib/data";

export default function ModelsPage() {
  const { model_cards, validation } = getModels();

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Models and validation</h1>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {model_cards.map((m) => (
            <div key={m.name} className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
              <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">{m.name}</h3>
              <dl className="flex flex-col gap-1.5 text-[12px]">
                <Row label="Purpose" value={m.purpose} />
                <Row label="Inputs" value={m.inputs} />
                <Row label="Method" value={m.method} />
                <Row label="Outputs" value={m.outputs} />
                <Row label="Known limits" value={m.limits} />
              </dl>
            </div>
          ))}
        </section>

        {validation ? (
          <>
            <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[13px] font-semibold text-(--ink)">Pattern recovery</h3>
                <span className="text-[12px] tabular text-(--ink-2)">{validation.patterns_detected} detected</span>
              </div>
              <p className="mb-3 text-[11px] text-(--ink-3)">{validation.note}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-(--ink-2)">
                      <th className="pb-1.5 font-medium">ID</th>
                      <th className="pb-1.5 font-medium">Pattern</th>
                      <th className="pb-1.5 font-medium">Detector</th>
                      <th className="pb-1.5 font-medium">Statistic</th>
                      <th className="pb-1.5 font-medium">Detected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.pattern_recovery.map((p) => (
                      <tr key={p.id} className="border-t border-(--rule)">
                        <td className="py-1.5 tabular text-(--ink-2)">{p.id}</td>
                        <td className="py-1.5 text-(--ink)">{p.title}</td>
                        <td className="py-1.5 text-(--ink-2)">{p.detector}</td>
                        <td className="py-1.5 text-(--ink-2)">{p.statistic}</td>
                        <td className="py-1.5">
                          {p.detected ? (
                            <span className="text-(--status-serviceable)">Yes</span>
                          ) : (
                            <span className="text-(--status-action-due)">No</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
              <h3 className="mb-2 text-[13px] font-semibold text-(--ink)">Model fit summary (in-sample)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-(--ink-2)">
                      <th className="pb-1.5 font-medium">Part</th>
                      <th className="pb-1.5 font-medium">Units</th>
                      <th className="pb-1.5 font-medium">Events</th>
                      <th className="pb-1.5 font-medium">In-sample concordance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.model_fit_summary.map((r) => (
                      <tr key={r.part_number} className="border-t border-(--rule)">
                        <td className="py-1.5 text-(--ink)">{r.name}</td>
                        <td className="py-1.5 tabular text-(--ink-2)">{r.n_units}</td>
                        <td className="py-1.5 tabular text-(--ink-2)">{r.n_events}</td>
                        <td className="py-1.5 tabular text-(--ink-2)">{r.in_sample_concordance ?? "N/A"}</td>
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
          <p>
            Connect to your maintenance and flight data records; refit every model on your fleet&apos;s actual history
            instead of synthetic data; set urgency thresholds from your approved maintenance schedule rather than the
            placeholder values used here; validate detections and recommendations with your own engineers before any
            automated output is trusted operationally.
          </p>
        </section>

        <p className="text-[11px] text-(--ink-3)">All figures on this page are computed on synthetic, fictional data.</p>
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-(--ink-3)">{label}</dt>
      <dd className="text-(--ink)">{value}</dd>
    </div>
  );
}
