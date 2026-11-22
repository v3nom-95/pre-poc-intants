import fs from "fs";
import path from "path";
import { Check, OctagonAlert } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { getPipeline } from "@/lib/data";
import { formatNumber } from "@/lib/format";

const BRONZE_DIR = path.join(process.cwd(), "public", "bronze");

function listBronzeFiles(): string[] {
  try {
    return fs.readdirSync(BRONZE_DIR).filter((f) => f.endsWith(".csv")).sort();
  } catch {
    return [];
  }
}

/** Data rows in a bundled bronze CSV (records, not physical lines: quoted
 * free text may contain line breaks). Counted at build time. */
function countCsvRecords(file: string): number | null {
  try {
    const text = fs.readFileSync(path.join(BRONZE_DIR, file), "utf-8");
    let records = 0;
    let inQuotes = false;
    let lineHasContent = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') inQuotes = !inQuotes;
      if (ch === "\n" && !inQuotes) {
        if (lineHasContent) records++;
        lineHasContent = false;
      } else if (ch !== "\r") {
        lineHasContent = true;
      }
    }
    if (lineHasContent) records++;
    return Math.max(records - 1, 0);
  } catch {
    return null;
  }
}

/** What each source extract represents (SPEC sections 4, 14.2 and 14.3). */
const SOURCE_DESCRIPTION: Record<string, string> = {
  "aircraft.csv": "Aircraft register: type, base, induction, hours at window start",
  "sortie_log.csv": "Flight authorisation records, one row per sortie",
  "snag_register.csv": "Defects reported against aircraft",
  "component_history.csv": "Component history cards: installs and removals",
  "maintenance_records.csv": "Inspections, servicing, rectifications and work orders",
  "engine_trend.csv": "EGT or ITT margin readings per engine per sortie",
  "maintenance_schedule.csv": "Approved maintenance schedule: tasks, intervals and limits",
  "ground_runs.csv": "Engine ground runs and APU running per tail and engine position",
  "maintenance_procedures.csv": "Approved task cards: task type, standard man-hours, manual reference",
};

/** Which source each logged ingestion fix belongs to (SPEC section 4). */
const ISSUE_SOURCE: Record<string, string> = {
  duplicate_sorties_removed: "sortie_log.csv",
  durations_imputed: "sortie_log.csv",
  dates_normalised: "sortie_log.csv",
  ata_inferred: "snag_register.csv",
};

function sentence(s: string) {
  const t = s.replace(/_/g, " ").replace(/ata/gi, "ATA");
  return t.charAt(0).toUpperCase() + t.slice(1);
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
                  <span className="text-[11px] text-(--ink-2)">{sentence(k)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-(--ink-2)">No ingestion report available.</p>
          )}
        </section>

        <section className="rounded-[8px] border border-(--rule) bg-(--sheet) p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-(--ink)">
            Data quality checks{" "}
            <span className="font-normal text-(--ink-2)">
              ({(data_quality ?? []).filter((c) => c.pass).length} of {(data_quality ?? []).length} pass)
            </span>
          </h3>
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
                        <span className="inline-flex items-center gap-1 text-(--ink)">
                          <Check className="size-3.5 text-(--status-serviceable)" strokeWidth={2.5} aria-hidden />
                          Pass
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-(--ink)">
                          <OctagonAlert className="size-3.5 text-(--status-critical)" strokeWidth={2.5} aria-hidden />
                          Fail ({c.count})
                        </span>
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
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-(--ink-2)">
                  <th className="py-1.5 pr-4 font-medium">File</th>
                  <th className="py-1.5 pr-4 font-medium">Contents</th>
                  <th className="whitespace-nowrap py-1.5 pr-4 text-right font-medium">Rows in bronze</th>
                  <th className="py-1.5 pr-4 font-medium">Issues resolved in silver</th>
                  <th className="py-1.5 font-medium">
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {BRONZE_FILES.map((f) => {
                  const rows = countCsvRecords(f);
                  const fixes = Object.entries(ingestion_issues ?? {}).filter(([k]) => ISSUE_SOURCE[k] === f);
                  return (
                    <tr key={f} className="border-t border-(--rule)">
                      <td className="py-2 pr-4 align-top whitespace-nowrap text-(--ink)">{f}</td>
                      <td className="py-2 pr-4 align-top text-(--ink-2)">{SOURCE_DESCRIPTION[f] ?? "Source extract"}</td>
                      <td className="py-2 pr-4 align-top text-right tabular text-(--ink)">
                        {rows !== null ? formatNumber(rows) : "Unknown"}
                      </td>
                      <td className="py-2 pr-4 align-top text-(--ink-2)">
                        {fixes.length > 0
                          ? fixes.map(([k, v]) => `${sentence(k)}: ${formatNumber(v)}`).join("; ")
                          : "None logged"}
                      </td>
                      <td className="py-2 align-top text-right">
                        <a href={`/bronze/${f}`} className="text-(--accent) underline underline-offset-2" download>
                          Download<span className="sr-only"> {f}</span>
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-(--ink-2)">
            Row counts are counted from the bundled bronze extracts. Silver row counts are not part of the export.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
