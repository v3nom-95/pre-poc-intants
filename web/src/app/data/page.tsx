import fs from "fs";
import path from "path";
import { AppShell } from "@/components/shell/app-shell";
import { getPipeline } from "@/lib/data";
import { formatNumber } from "@/lib/format";

function listBronzeFiles(): string[] {
  const dir = path.join(process.cwd(), "public", "bronze");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
  } catch {
    return [];
  }
}

export default function DataPage() {
  const { data_quality, ingestion_issues } = getPipeline();
  const BRONZE_FILES = listBronzeFiles();

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Data and integration</h1>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Pipeline</h3>
          <div className="flex flex-wrap items-center justify-center gap-3 text-[12px] text-(--ink-2)">
            {["Sources", "Bronze", "Silver", "Gold", "Models", "Recommendations"].map((stage, i, arr) => (
              <div key={stage} className="flex items-center gap-3">
                <span className="rounded-[6px] border border-(--rule) bg-(--paper) px-3 py-2 text-(--ink)">{stage}</span>
                {i < arr.length - 1 && (
                  <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden>
                    <line x1="0" y1="5" x2="16" y2="5" stroke="var(--ink-2)" strokeWidth="1.25" />
                    <path d="M12 1 L16 5 L12 9" fill="none" stroke="var(--ink-2)" strokeWidth="1.25" />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Issues found and resolved</h3>
          {ingestion_issues ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {Object.entries(ingestion_issues).map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <span className="text-[20px] font-semibold tabular text-(--ink)">{formatNumber(v)}</span>
                  <span className="text-[11px] text-(--ink-2)">{k.replace(/_/g, " ")}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-(--ink-2)">No ingestion report available.</p>
          )}
        </section>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Data quality checks</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-(--ink-2)">
                  <th className="w-[28%] py-1.5 pr-4 font-medium">Check</th>
                  <th className="w-20 py-1.5 pr-4 font-medium">Result</th>
                  <th className="py-1.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {(data_quality ?? []).map((c, i) => (
                  <tr key={i} className="border-t border-(--rule)">
                    <td className="py-2 pr-4 align-top text-(--ink)">{c.check}</td>
                    <td className="py-2 pr-4 align-top">
                      {c.pass ? (
                        <span className="text-(--status-serviceable)">Pass</span>
                      ) : (
                        <span className="text-(--status-critical)">Fail ({c.count})</span>
                      )}
                    </td>
                    <td className="py-2 align-top text-(--ink-2)">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">Bronze source files</h3>
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {BRONZE_FILES.map((f) => (
              <li key={f} className="flex items-center justify-between rounded-[6px] border border-(--rule) px-3 py-2">
                <span className="text-(--ink)">{f}</span>
                <a href={`/bronze/${f}`} className="text-(--accent) hover:underline" download>
                  Download
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
