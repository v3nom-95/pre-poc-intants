// Accuracy suite for the offline query assistant, run against the REAL
// generated corpus (public/data/knowledge). Expected values are computed
// independently here from the other exported JSON files (fleet, aircraft,
// components, reliability, recommendations, pipeline, plan) and from the
// silver tables (sorties, snags, ground runs) or the bronze task cards, never
// from the assistant's own composers.
import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { Assistant } from "./engine";
import { extractEntities } from "./entities";
import { KnowledgeBase } from "./knowledge";
import type { Answer, Corpus, SortieFile } from "./types";

const DATA = path.join(process.cwd(), "public", "data");
const KDIR = path.join(DATA, "knowledge");
const SILVER = path.join(process.cwd(), "..", "engine", "data", "silver");

const readJson = <T,>(rel: string): T => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf-8")) as T;
const corpus = readJson<Corpus>("knowledge/corpus.json");
const loader = async (tail: string) => readJson<SortieFile>(`knowledge/sorties/${tail}.json`);
type ByType = Record<string, { aircraft: number; fleet_fh_12mo: number; serviceability_pct: number; open_recs_by_priority: Record<string, number> }>;
const fleet = readJson<{
  kpis: { serviceability_pct: number; due_30_days_count: number; open_recs_by_priority: Record<string, number>; by_type: ByType };
  aircraft: { tail: string; type: string; fi: number; airframe_fh: number }[];
  due_90_days: { tail: string; item: string; date: string | null; days_to_due: number | null }[];
}>("fleet.json");
const recs = readJson<{ open: { id: string; tail: string | null; ata: string | null; priority: string; title: string; action: string; task_card?: string }[]; history: unknown[] }>("recommendations.json");
const reliability = readJson<{
  lot_comparison: { lot: string; rate_per_1000fh: number; rest_of_fleet_rate_per_1000fh: number; p_value_bonferroni: number; flagged: boolean }[];
  mtbf_mtbur: { part_number: string; name: string; mtbf_fh: number | null; nff_rate: number }[];
  environmental_effects: { flagged: boolean }[];
}>("reliability.json");
const pipeline = readJson<{ data_quality: { pass: boolean }[]; ingestion_issues: Record<string, number> }>("pipeline.json");
interface EngineJson { position: string; serial: string; efh: number; operating_hours: number; trend_info: { current_margin_c: number; projected_efh_to_limit: number | null; slope_c_per_efh: number; flagged: boolean; metric: string } | null }
const aircraft = (tail: string) =>
  readJson<{
    type_name: string;
    engine_serial: string;
    engine_trend_info: { current_margin_c: number; projected_efh_to_limit: number; slope_c_per_efh: number };
    engines: EngineJson[];
    apu_hours: number | null;
    operating_hours: { flight_hours: number; taxi_hours: number; ground_runs: number; ground_run_hours: number };
    fatigue: { projected_fi100_date: string };
    components: { component: string; position: string; remaining: number | null; governing_limit: string | null }[];
    history: { date: string; type: string }[];
    snags: { ata: number | null }[];
  }>(`aircraft/${tail}.json`);

// Minimal CSV reader (the pipeline's CSVs have no quoted commas in the
// columns used here; quoted fields are handled for safety).
function readCsv(file: string): Record<string, string>[] {
  const [header, ...lines] = fs.readFileSync(file, "utf-8").trim().split(/\r?\n/);
  const split = (l: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const h = split(header);
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [h[i], v])));
}

// Silver sorties: the conformed table the pipeline produced (gitignored, so
// fall back to the knowledge sortie rows if absent).
interface Row { id: string; tail: string; date: string; mission: string; fh: number; landings: number; apu: number }
function loadSorties(): Row[] {
  const file = path.join(SILVER, "silver_sorties.csv");
  if (fs.existsSync(file)) {
    return readCsv(file).map((r) => ({ id: r.sortie_id, tail: r.tail, date: r.date.slice(0, 10), mission: r.mission_type, fh: Number(r.duration_h), landings: Number(r.landings), apu: Number(r.apu_h ?? 0) }));
  }
  return corpus.tails.flatMap((t) => {
    const f = readJson<SortieFile>(`knowledge/sorties/${t}.json`);
    const apu = f.columns.indexOf("apu_h");
    return f.rows.map((r) => ({ id: r[0] as string, tail: t, date: r[1] as string, mission: f.missions[r[2] as number], fh: r[3] as number, landings: r[4] as number, apu: apu >= 0 ? (r[apu] as number) : 0 }));
  });
}
const sorties = loadSorties();
const groundRunsFile = fs.existsSync(path.join(SILVER, "silver_ground_runs.csv")) ? path.join(SILVER, "silver_ground_runs.csv") : path.join(DATA, "bronze", "ground_runs.csv");
const groundRuns = readCsv(groundRunsFile).map((r) => ({ tail: r.tail, date: r.date.slice(0, 10), apu: Number(r.apu_h), hours: Number(r.duration_h) }));
const snagsSilver = fs.existsSync(path.join(SILVER, "silver_snags.csv")) ? readCsv(path.join(SILVER, "silver_snags.csv")) : [];
const taskCards = readCsv(path.join(DATA, "bronze", "maintenance_procedures.csv"));

const n = (x: number, d = 0) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fdate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const all = (a: Answer) => [a.text, ...(a.bullets ?? []), ...(a.table ? [a.table.columns.join(" "), ...a.table.rows.map((r) => r.join(" | "))] : [])].join("\n");
const kb0 = new KnowledgeBase(corpus, loader);
const hasPlan = kb0.docs("plan_task").length > 0;
const tailsOf = (type: string) => fleet.aircraft.filter((a) => a.type === type).map((a) => a.tail);
const inLast12 = (d: string) => d > "2025-11-15" && d <= "2026-11-15";

let assistant: Assistant;
const ask = (q: string) => assistant.ask(q);

beforeAll(() => {
  assistant = new Assistant(corpus, loader);
});

describe("aircraft and plan questions", () => {
  it("What should we do next on FX-307?", async () => {
    const a = await ask("What should we do next on FX-307?");
    expect(a.intent).toBe("next_action");
    if (hasPlan) {
      const tasks = kb0.docs("plan_task").filter((d) => d.keys.tail === "FX-307");
      expect(a.table?.rows.length).toBe(tasks.length);
    } else {
      const expected = recs.open.filter((r) => r.tail === "FX-307").map((r) => r.id);
      for (const id of expected) expect(all(a)).toContain(id);
    }
  });

  it("Tell me about FX-310, then a pronoun follow-up about its engine", async () => {
    const a = await ask("Tell me about FX-310");
    expect(a.intent).toBe("aircraft");
    const fx = fleet.aircraft.find((x) => x.tail === "FX-310")!;
    expect(a.text).toContain(`${n(fx.airframe_fh, 1)} FH`);
    const b = await ask("and its engine?");
    expect(b.intent).toBe("engine");
    expect(b.text).toContain("Taking FX-310");
    expect(b.text).toContain(aircraft("FX-310").engine_serial);
  });

  it("Compare FX-304 and FX-309", async () => {
    const a = await ask("Compare FX-304 and FX-309");
    expect(a.intent).toBe("compare");
    for (const t of ["FX-304", "FX-309"]) {
      expect(all(a)).toContain(n(fleet.aircraft.find((x) => x.tail === t)!.airframe_fh, 1));
    }
  });

  it("What should we do next? (fleet)", async () => {
    const a = await ask("What should we do next?");
    expect(a.intent).toBe("next_action");
    if (hasPlan) {
      const plan = readJson<{ summary: { tasks_total: number } }>("plan.json");
      expect(a.text).toContain(`Fleet action plan: ${plan.summary.tasks_total} tasks`);
    } else {
      const total = Object.values(fleet.kpis.open_recs_by_priority).reduce((x, y) => x + y, 0);
      expect(a.text).toContain(`${total} open recommendations`);
    }
  });
});

describe("hard time and risk", () => {
  it("Which aircraft are due for hard-time items in the next 30 days?", async () => {
    const a = await ask("Which aircraft are due for hard-time items in the next 30 days?");
    expect(a.intent).toBe("due");
    expect(a.table?.rows.length).toBe(fleet.kpis.due_30_days_count);
    const tails = new Set(fleet.due_90_days.filter((d) => d.days_to_due !== null && d.days_to_due <= 30).map((d) => d.tail));
    for (const t of tails) expect(a.text).toContain(t);
  });

  it("When is the CAD/PAD on FX-305 due?", async () => {
    const a = await ask("When is the CAD/PAD on FX-305 due?");
    const item = fleet.due_90_days.find((d) => d.tail === "FX-305" && d.item.includes("CAD/PAD"))!;
    expect(a.intent).toBe("due");
    expect(a.text).toContain(fdate(item.date!));
    expect(a.text).toContain("CAD/PAD");
  });

  it("Are any hard-time items overdue?", async () => {
    const a = await ask("Are any hard-time items overdue?");
    expect(a.text).toMatch(/^No hard-time item is overdue/);
  });

  it("What is the remaining life of the main landing gear on FX-301?", async () => {
    const a = await ask("What is the remaining life of the main landing gear on FX-301?");
    const left = aircraft("FX-301").components.find((c) => c.component === "Main landing gear assembly" && c.position === "L")!;
    expect(left.governing_limit).toBe("Landings");
    expect(all(a)).toContain(`${n(left.remaining!)} landings`);
  });

  it("Tell me about HP-0001", async () => {
    const a = await ask("Tell me about HP-0001");
    const c = readJson<{ prob_fail_before_next_phase: number; fh_to_tau: number; current_tail: string; lot: string }>("components/HP-0001.json");
    expect(a.intent).toBe("component");
    expect(a.text).toContain(`${Math.round(c.prob_fail_before_next_phase * 100)}% probability`);
    expect(a.text).toContain(`${n(c.fh_to_tau)} FH until`);
    expect(a.text).toContain(c.current_tail);
    expect(a.text).toContain(c.lot);
  });

  it("Which components have the highest risk? (tyres and brakes of every type left out)", async () => {
    const a = await ask("Which components have the highest risk?");
    expect(a.intent).toBe("risk");
    expect(all(a)).not.toMatch(/wheel tyre|wheel brake/i);
    const probs = a.table!.rows.map((r) => Number(String(r[3]).replace("%", "")));
    expect([...probs].sort((x, y) => y - x)).toEqual(probs);
  });
});

describe("planted patterns", () => {
  it("Why is lot L-2207 flagged?", async () => {
    const a = await ask("Why is lot L-2207 flagged?");
    const l = reliability.lot_comparison.find((x) => x.lot === "L-2207")!;
    expect(a.intent).toBe("reliability");
    expect(a.text).toContain(`${n(l.rate_per_1000fh, 2)} failures per 1,000 FH`);
    expect(a.text).toContain(n(l.rest_of_fleet_rate_per_1000fh, 2));
    expect(a.text).toContain(`p=${n(l.p_value_bonferroni, 4)}`);
    expect(a.text).toContain(l.flagged ? "flagged as a significant excess" : "not flagged");
  });

  it("Show the EGT trend for FX-311", async () => {
    const a = await ask("Show the EGT trend for FX-311");
    const t = aircraft("FX-311").engine_trend_info;
    expect(a.intent).toBe("engine");
    expect(a.text).toContain(`EGT margin ${n(t.current_margin_c, 1)} °C`);
    expect(a.text).toContain(`${n(t.projected_efh_to_limit, 1)} EFH`);
    expect(a.text).toContain("Flagged");
  });

  it("What is the fatigue projection for FX-309?", async () => {
    const a = await ask("What is the fatigue projection for FX-309?");
    expect(a.intent).toBe("fatigue");
    expect(a.text).toContain(fdate(aircraft("FX-309").fatigue.projected_fi100_date));
    expect(a.text).toContain("before the planned withdrawal year");
  });

  it("Is there a chip detector issue on FX-302?", async () => {
    const a = await ask("Is there a chip detector issue on FX-302?");
    const oilRec = recs.open.find((r) => r.tail === "FX-302" && r.ata === "79")!;
    expect(all(a)).toContain(oilRec.id);
    expect(all(a)).toContain("SOAP");
    expect(all(a)).toMatch(/Active oil system precursor on FX-302/);
  });

  it("Show repeat snags on FX-307", async () => {
    const a = await ask("Show repeat snags on FX-307");
    const ata34 = aircraft("FX-307").snags.filter((s) => s.ata === 34).length;
    expect(a.intent).toBe("snags");
    expect(all(a)).toContain(`Repeat snag on FX-307, ATA 34: ${ata34} snags`);
    expect(all(a)).toMatch(/Repeat NFF removals on FX-307/);
    expect(all(a)).toMatch(/Troubleshoot/);
  });

  it("Show NFF removals on FX-307", async () => {
    const a = await ask("Show NFF removals on FX-307");
    expect(a.intent).toBe("removals");
    expect(a.text).toMatch(/^2 NFF removals on FX-307/);
    expect(a.table!.rows.every((r) => r.includes("Radar altimeter"))).toBe(true);
  });

  it("What did the models find?", async () => {
    const a = await ask("What did the models find?");
    expect(a.intent).toBe("patterns");
    for (const s of ["L-2207", "FX-307", "FX-302", "FX-311", "FX-309", "TX-404", "CX-502"]) expect(all(a)).toContain(s);
  });

  it("Is there a hot-climate effect on any component?", async () => {
    const a = await ask("Is there a hot-climate effect on any component?");
    const flagged = reliability.environmental_effects.filter((x) => x.flagged).length;
    expect(a.table!.rows.length).toBe(reliability.environmental_effects.length);
    if (flagged === 0) expect(a.text).toContain("none is significant");
    else expect(a.text).toContain(`${flagged} effect`);
  });
});

describe("sorties, exact counts from every flight", () => {
  it("How many sorties did FX-304 fly last month?", async () => {
    const a = await ask("How many sorties did FX-304 fly last month?");
    const s = sorties.filter((x) => x.tail === "FX-304" && x.date >= "2026-10-01" && x.date <= "2026-10-31");
    expect(a.intent).toBe("sorties");
    expect(a.text).toContain(`FX-304 flew ${s.length} sorties in October 2026`);
    expect(a.text).toContain(`${n(s.reduce((x, y) => x + y.fh, 0), 1)} FH`);
  });

  it("How many ACM sorties did FX-304 fly in March 2026?", async () => {
    const a = await ask("How many ACM sorties did FX-304 fly in March 2026?");
    const s = sorties.filter((x) => x.tail === "FX-304" && x.mission === "Air combat manoeuvring" && x.date.startsWith("2026-03"));
    expect(a.text).toContain(`FX-304 flew ${s.length} air combat manoeuvring sorties in March 2026`);
  });

  it("How many landings did 312 make in 2025?", async () => {
    const a = await ask("How many landings did 312 make in 2025?");
    const s = sorties.filter((x) => x.tail === "FX-312" && x.date.startsWith("2025"));
    expect(a.text).toContain(`FX-312 made ${n(s.reduce((x, y) => x + y.landings, 0))} landings in 2025`);
    expect(a.text).toContain(`${s.length} sorties`);
  });

  it("What was the last sortie of FX-307?", async () => {
    const a = await ask("What was the last sortie of FX-307?");
    const s = sorties.filter((x) => x.tail === "FX-307").sort((x, y) => y.date.localeCompare(x.date) || y.id.localeCompare(x.id))[0];
    expect(a.text).toContain(s.id);
    expect(a.text).toContain(fdate(s.date));
  });

  it("Which aircraft flew the most hours in the last 12 months?", async () => {
    const a = await ask("Which aircraft flew the most hours in the last 12 months?");
    const by = new Map<string, number>();
    for (const s of sorties) if (inLast12(s.date)) by.set(s.tail, (by.get(s.tail) ?? 0) + s.fh);
    const [tail, fh] = [...by.entries()].sort((x, y) => y[1] - x[1])[0];
    expect(a.text).toContain(`Most: ${tail} with ${n(fh, 1)} FH`);
  });

  it("How many sorties did the fleet fly per month this year?", async () => {
    const a = await ask("How many sorties did the fleet fly per month this year?");
    const s = sorties.filter((x) => x.date.startsWith("2026"));
    expect(a.text).toContain(`The fleet flew ${n(s.length)} sorties in 2026 to date`);
    expect(a.table!.columns[0]).toBe("Month");
    expect(a.table!.rows.length).toBe(11);
  });

  it("Tell me about sortie <id>", async () => {
    const s = sorties[123];
    const a = await ask(`Tell me about sortie ${s.id}`);
    expect(a.text).toContain(s.tail);
    expect(a.text).toContain(fdate(s.date));
  });
});

describe("fleet, reliability, records", () => {
  it("Show critical recommendations", async () => {
    const a = await ask("Show critical recommendations");
    expect(a.table!.rows.length).toBe(fleet.kpis.open_recs_by_priority.Critical);
  });

  it("Tell me about a recommendation by id", async () => {
    const r = recs.open[0];
    const a = await ask(`Tell me about ${r.id}`);
    expect(a.intent).toBe("recommendations");
    expect(a.text).toContain(r.title);
    if (r.task_card) expect(a.text).toContain(`Task card ${r.task_card}`);
  });

  it("Did the data quality checks pass?", async () => {
    const a = await ask("Did the data quality checks pass?");
    const passing = pipeline.data_quality.filter((c) => c.pass).length;
    if (passing === pipeline.data_quality.length) expect(a.text).toContain(`All ${passing} data quality checks pass`);
    for (const v of Object.values(pipeline.ingestion_issues)) expect(a.text).toContain(String(v));
  });

  it("How is the fleet doing?", async () => {
    const a = await ask("How is the fleet doing?");
    expect(a.intent).toBe("kpi");
    expect(a.text).toContain(`Serviceability ${n(fleet.kpis.serviceability_pct, 1)}%`);
    expect(a.text).toContain(`airlifters ${fleet.kpis.by_type.airlifter.aircraft} aircraft`);
  });

  it("Which aircraft has the highest fatigue index?", async () => {
    const a = await ask("Which aircraft has the highest fatigue index?");
    const top = [...fleet.aircraft].sort((x, y) => y.fi - x.fi)[0];
    expect(a.text).toMatch(new RegExp(`^Highest fatigue index: ${top.tail}`));
  });

  it("Which part has the highest NFF rate?", async () => {
    const a = await ask("Which part has the highest NFF rate?");
    const top = [...reliability.mtbf_mtbur].sort((x, y) => y.nff_rate - x.nff_rate || x.part_number.localeCompare(y.part_number))[0];
    expect(a.text).toContain(`${top.name} (${top.part_number}`);
    expect(a.text).toContain(`at ${n(top.nff_rate * 100, 1)}%`);
  });

  it("What is the MTBF of the radar altimeter? (one part number per type)", async () => {
    const a = await ask("What is the MTBF of the radar altimeter?");
    const parts = reliability.mtbf_mtbur.filter((x) => /altimeter/i.test(x.name));
    expect(parts.length).toBe(3);
    expect(a.table!.rows.length).toBe(3);
    for (const p of parts) {
      expect(all(a)).toContain(p.part_number);
      if (p.mtbf_fh) expect(all(a)).toContain(n(p.mtbf_fh));
    }
  });

  it("What is the MTBF of the radio altimeter on the transports?", async () => {
    const a = await ask("What is the MTBF of the radio altimeter on the transports?");
    const p = reliability.mtbf_mtbur.find((x) => x.part_number === "34-4420-11")!;
    expect(a.intent).toBe("reliability");
    expect(a.text).toContain("34-4420-11");
    expect(a.text).toContain(p.mtbf_fh ? `MTBF ${n(p.mtbf_fh)} FH` : "MTBF not defined");
    expect(a.text).not.toContain("34-4410-02");
  });

  it("When was the last phase inspection on FX-301?", async () => {
    const a = await ask("When was the last phase inspection on FX-301?");
    const last = aircraft("FX-301").history.find((h) => h.type === "Phase inspection")!;
    expect(a.text).toContain(fdate(last.date));
  });

  it("What is NFF?", async () => {
    const a = await ask("What is NFF?");
    expect(a.intent).toBe("glossary");
    expect(a.text).toContain("No fault found");
  });

  it("What is ITT margin?", async () => {
    const a = await ask("What is ITT margin?");
    expect(a.intent).toBe("glossary");
    expect(a.text).toContain("Inter-turbine temperature");
  });
});

describe("mixed fleet: transports and airlifters", () => {
  it("What is wrong with TX-404? (P8 pressurisation repeat snag)", async () => {
    const a = await ask("What is wrong with TX-404?");
    const ata21 = snagsSilver.filter((s) => s.tail === "TX-404" && Number(s.ata) === 21).length;
    const trouble = recs.open.find((r) => r.tail === "TX-404" && r.action === "Troubleshoot")!;
    expect(a.intent).toBe("snags");
    if (snagsSilver.length) expect(all(a)).toContain(`Repeat snag on TX-404, ATA 21: ${ata21} snags`);
    expect(all(a)).toContain(trouble.id);
    expect(all(a)).toMatch(/Repeat NFF removals on TX-404/);
  });

  it("Show pressurisation snags on TX-404", async () => {
    const a = await ask("Show pressurisation snags on TX-404");
    const ata21 = snagsSilver.filter((s) => s.tail === "TX-404" && Number(s.ata) === 21);
    expect(a.intent).toBe("snags");
    if (snagsSilver.length) expect(a.text).toMatch(new RegExp(`^${ata21.length} snags on TX-404 in ATA 21`));
  });

  it("Show the ITT trend for CX-502 engine 3 (P9)", async () => {
    const a = await ask("Show the ITT trend for CX-502 engine 3");
    const en = aircraft("CX-502").engines.find((x) => x.position === "3")!;
    expect(a.intent).toBe("engine");
    expect(a.text).toContain(`CX-502 engine 3 (${en.serial})`);
    expect(a.text).toContain(`ITT margin ${n(en.trend_info!.current_margin_c, 1)} °C`);
    expect(a.text).toContain(`${n(en.trend_info!.projected_efh_to_limit!, 1)} EFH`);
    expect(a.text).toContain("Flagged");
  });

  it("Show the engines on CX-502", async () => {
    const a = await ask("Show the engines on CX-502");
    const engines = aircraft("CX-502").engines;
    expect(a.intent).toBe("engine");
    expect(a.table!.rows.length).toBe(engines.length);
    for (const en of engines) expect(all(a)).toContain(en.serial);
    const flagged = engines.filter((x) => x.trend_info?.flagged).map((x) => `engine ${x.position}`);
    for (const f of flagged) expect(a.text).toContain(f);
  });

  it("Which turboprop engine has the fastest ITT deterioration?", async () => {
    const a = await ask("Which turboprop engine has the fastest ITT deterioration?");
    const rows: { tail: string; pos: string; slope: number }[] = [];
    for (const t of [...tailsOf("transport"), ...tailsOf("airlifter")]) {
      for (const en of aircraft(t).engines) if (en.trend_info) rows.push({ tail: t, pos: en.position, slope: en.trend_info.slope_c_per_efh });
    }
    const lead = rows.sort((x, y) => x.slope - y.slope)[0];
    expect(a.intent).toBe("engine");
    expect(a.text).toContain(`Fastest deterioration: ${lead.tail} engine ${lead.pos}`);
    expect(a.table!.rows.every((r) => r[3] === "ITT margin")).toBe(true);
    expect(a.table!.rows.length).toBe(rows.length);
  });

  it("How many air drop sorties did the airlifters fly in October 2026?", async () => {
    const a = await ask("How many air drop sorties did the airlifters fly in October 2026?");
    const s = sorties.filter((x) => x.tail.startsWith("CX-") && x.mission === "Air drop" && x.date.startsWith("2026-10"));
    expect(a.intent).toBe("sorties");
    expect(a.text).toContain(`The airlifters flew ${s.length} air drop sorties in October 2026`);
    expect(a.text).toContain(`${n(s.reduce((x, y) => x + y.fh, 0), 1)} FH`);
  });

  it("How many passenger transport sorties did TX-402 fly last month?", async () => {
    const a = await ask("How many passenger transport sorties did TX-402 fly last month?");
    const s = sorties.filter((x) => x.tail === "TX-402" && x.mission === "Passenger transport" && x.date.startsWith("2026-10"));
    expect(a.text).toContain(`TX-402 flew ${s.length} passenger transport sorties in October 2026`);
  });

  it("Which transport flew the most hours in the last 12 months?", async () => {
    const a = await ask("Which transport flew the most hours in the last 12 months?");
    const by = new Map<string, number>();
    for (const s of sorties) if (s.tail.startsWith("TX-") && inLast12(s.date)) by.set(s.tail, (by.get(s.tail) ?? 0) + s.fh);
    const [tail, fh] = [...by.entries()].sort((x, y) => y[1] - x[1])[0];
    expect(a.text).toContain(`Most: ${tail} with ${n(fh, 1)} FH`);
    expect(a.table!.rows.length).toBe(tailsOf("transport").length);
  });

  it("Compare utilisation by aircraft type", async () => {
    const a = await ask("Compare utilisation by aircraft type");
    expect(a.intent).toBe("fleet_type");
    const fhRow = a.table!.rows.find((r) => r[0] === "FH, last 12 months")!;
    for (const [i, type] of ["fighter", "transport", "airlifter"].entries()) {
      const tails = tailsOf(type);
      const fh = sorties.filter((s) => tails.includes(s.tail) && inLast12(s.date)).reduce((x, y) => x + y.fh, 0);
      expect(fhRow[i + 1]).toBe(n(fh, 1));
    }
  });

  it("How are the airlifters doing?", async () => {
    const a = await ask("How are the airlifters doing?");
    const k = fleet.kpis.by_type.airlifter;
    const open = recs.open.filter((r) => r.tail && r.tail.startsWith("CX-")).length;
    expect(a.intent).toBe("fleet_type");
    expect(a.text).toContain(`serviceability ${n(k.serviceability_pct, 1)}%`);
    expect(a.text).toContain(`${open} open recommendation`);
    expect(a.table!.rows.length).toBe(tailsOf("airlifter").length);
  });

  it("Show open recommendations for the airlifters", async () => {
    const a = await ask("Show open recommendations for the airlifters");
    const open = recs.open.filter((r) => r.tail && r.tail.startsWith("CX-"));
    expect(a.intent).toBe("recommendations");
    expect(a.text).toMatch(new RegExp(`^${open.length} open recommendations for the airlifters`));
  });

  it("How many APU hours did CX-503 log last month?", async () => {
    const a = await ask("How many APU hours did CX-503 log last month?");
    const inOct = (d: string) => d >= "2026-10-01" && d <= "2026-10-31";
    const apu = sorties.filter((s) => s.tail === "CX-503" && inOct(s.date)).reduce((x, y) => x + y.apu, 0) +
      groundRuns.filter((r) => r.tail === "CX-503" && inOct(r.date)).reduce((x, y) => x + y.apu, 0);
    expect(a.intent).toBe("operating");
    expect(a.text).toContain(`APU: ${n(apu, 1)} APU hours`);
  });

  it("Engine operating hours versus flight hours on TX-404", async () => {
    const a = await ask("Engine operating hours versus flight hours on TX-404");
    const ac = aircraft("TX-404");
    expect(a.intent).toBe("operating");
    expect(a.text).toContain(`${n(ac.operating_hours.flight_hours, 1)} FH flown`);
    expect(a.text).toContain(`${n(ac.operating_hours.taxi_hours, 1)} taxi hours`);
    for (const en of ac.engines) expect(all(a)).toContain(`${n(en.operating_hours, 1)}`);
    expect(a.text).toContain(`APU ${n(ac.apu_hours!, 1)} APU hours`);
  });

  it("How many ground runs did TX-404 have?", async () => {
    const a = await ask("How many ground runs did TX-404 have?");
    const runs = groundRuns.filter((r) => r.tail === "TX-404");
    expect(a.intent).toBe("operating");
    expect(a.text).toContain(`${runs.length} engine ground runs`);
    expect(a.table!.rows.length).toBe(Math.min(20, runs.length));
  });

  it("Fighters have no APU", async () => {
    const a = await ask("How many APU hours did the fighters log last month?");
    expect(a.intent).toBe("operating");
    expect(a.text).toContain("No APU is fitted");
  });

  it("What task card covers the cabin outflow valve on the transports?", async () => {
    const a = await ask("What task card covers the cabin outflow valve on the transports?");
    const cards = taskCards.filter((c) => c.part_number === "21-3120-11").map((c) => c.task_card).sort();
    expect(a.intent).toBe("task_card");
    expect(a.table!.rows.map((r) => r[0])).toEqual(cards);
  });

  it("How long does it take to replace the APU on a transport?", async () => {
    const a = await ask("How long does it take to replace the APU on a transport?");
    const c = taskCards.find((x) => x.part_number === "49-1110-11" && x.task_type === "Replace")!;
    expect(a.intent).toBe("task_card");
    expect(a.text).toContain(c.task_card);
    expect(a.text).toContain(`standard ${n(Number(c.standard_man_hours), 1)} man-hours`);
  });

  it("Tell me about a task card by id", async () => {
    const c = taskCards.find((x) => x.task_type === "Troubleshoot")!;
    const a = await ask(`Tell me about ${c.task_card}`);
    expect(a.intent).toBe("task_card");
    expect(a.text).toContain(c.title);
    expect(a.text).toContain(c.manual_reference);
  });

  it("Tell me about TX-404", async () => {
    const a = await ask("Tell me about TX-404");
    const ac = aircraft("TX-404");
    expect(a.intent).toBe("aircraft");
    expect(a.text).toContain("twin-engine transport");
    expect(all(a)).toContain(`APU: ${n(ac.apu_hours!, 1)} APU hours`);
    for (const en of ac.engines) expect(all(a)).toContain(en.serial);
  });

  it("Which airlifter has the highest fatigue index?", async () => {
    const a = await ask("Which airlifter has the highest fatigue index?");
    const top = fleet.aircraft.filter((x) => x.type === "airlifter").sort((x, y) => y.fi - x.fi)[0];
    expect(a.intent).toBe("fatigue");
    expect(a.text).toContain(`: ${top.tail}, FI ${n(top.fi, 1)}`);
    expect(a.table!.rows.length).toBe(tailsOf("airlifter").length);
  });

  it("Show snags on the transports", async () => {
    const a = await ask("Show snags on the transports");
    const count = snagsSilver.filter((s) => s.tail.startsWith("TX-")).length;
    expect(a.intent).toBe("snags");
    if (snagsSilver.length) expect(a.text).toMatch(new RegExp(`^${n(count)} snags for the transports`));
  });

  it("A four-engine question about an engine that does not exist", async () => {
    const a = await ask("Show the ITT trend for TX-401 engine 4");
    expect(a.text).toContain("there is no engine 4");
  });
});

describe("action plan (when plan.json is exported)", () => {
  const planPath = path.join(DATA, "plan.json");
  const plan = fs.existsSync(planPath)
    ? (JSON.parse(fs.readFileSync(planPath, "utf-8")) as {
        tasks?: { id: string; tail: string; planned_date: string }[];
        spares?: { units_required: number }[];
        aircraft?: { tail: string; next_phase?: { date?: string } }[];
      })
    : {};
  const run = plan.tasks?.length && hasPlan ? it : it.skip;

  run("Which spares do we need?", async () => {
    const a = await ask("Which spares do we need?");
    expect(a.intent).toBe("plan");
    expect(a.table!.rows.length).toBe(plan.spares!.length);
    expect(a.text).toContain(`${plan.spares!.reduce((x, y) => x + y.units_required, 0)} units`);
  });

  run("Tell me about the first plan task", async () => {
    const t = plan.tasks![0];
    const a = await ask(`Tell me about ${t.id}`);
    expect(a.text).toContain(t.tail);
    expect(a.text).toContain(fdate(t.planned_date));
  });

  run("When is the next phase inspection on FX-301?", async () => {
    const ac = plan.aircraft!.find((x) => x.tail === "FX-301")!;
    const a = await ask("When is the next phase inspection on FX-301?");
    expect(a.text).toMatch(new RegExp(`^Next phase inspection on FX-301 projected ${fdate(ac.next_phase!.date!)}`));
  });

  run("What should we do next on the airlifters?", async () => {
    const tasks = (plan.tasks ?? []).filter((t) => t.tail && t.tail.startsWith("CX-"));
    const a = await ask("What should we do next on the airlifters?");
    expect(a.intent).toBe("next_action");
    expect(a.text).toContain(`Action plan for the airlifters: ${tasks.length} task`);
  });
});

describe("honesty on unanswerable questions", () => {
  it("What is the weather at Base A tomorrow?", async () => {
    const a = await ask("What is the weather at Base A tomorrow?");
    expect(a.text).toMatch(/I could not find "tomorrow"/);
    expect(a.text).not.toMatch(/forecast|°C tomorrow/);
  });

  it("Who is the pilot of FX-301?", async () => {
    const a = await ask("Who was the pilot on FX-301?");
    expect(a.text).toMatch(/I could not find "pilot"/);
  });

  it("What is the cargo payload of CX-501?", async () => {
    const a = await ask("What is the cargo payload of CX-501?");
    expect(a.text).toMatch(/"payload"/);
  });

  it("An unknown serial is reported as not found", async () => {
    const a = await ask("Tell me about REC-2099-9999");
    expect(a.text).toMatch(/could not find|did not recognise/i);
  });

  it("An unknown tail of a known type is reported as not found", async () => {
    const a = await ask("Tell me about TX-499");
    expect(a.text).toMatch(/could not find TX-499/);
  });
});

describe("entity extraction against the fixed as-of date", () => {
  const kb = new KnowledgeBase(corpus, loader);
  it("resolves relative windows from 15 Nov 2026, not the clock", () => {
    expect(extractEntities("sorties last month", kb).window).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(extractEntities("sorties in the last 3 months", kb).window).toMatchObject({ from: "2026-08-16", to: "2026-11-15" });
    expect(extractEntities("snags in March", kb).window).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(extractEntities("snags in December", kb).window).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(extractEntities("due in the next 30 days", kb).horizonDays).toBe(30);
  });
  it("recognises identifiers and synonyms", () => {
    const e = extractEntities("radalt and hyd pump on fx307, serial hp-0001, part 29-1140-03, lot L2207", kb);
    expect(e.tails).toEqual(["FX-307"]);
    expect(e.serials).toEqual(["HP-0001"]);
    expect(e.partNumbers).toEqual(["29-1140-03"]);
    expect(e.lots).toEqual(["L-2207"]);
    expect(e.componentKeys).toEqual(expect.arrayContaining(["RADALT", "HYD-PUMP", "TR-HYD-PUMP", "AL-HYD-PUMP"]));
    expect(extractEntities("next 310 FH", kb).tails).toEqual([]);
  });
  it("recognises mixed fleet tails, types, engine positions and task cards", () => {
    expect(extractEntities("what about 404 and cx502", kb).tails).toEqual(["CX-502", "TX-404"]);
    expect(extractEntities("no. 3 engine on CX-502", kb).enginePositions).toEqual(["3"]);
    expect(extractEntities("the third engine", kb).enginePositions).toEqual(["3"]);
    expect(extractEntities("engine 2", kb).enginePositions).toEqual(["2"]);
    const t = extractEntities("twin-engine transports and four-engine airlifters", kb);
    expect(t.types).toEqual(["transport", "airlifter"]);
    expect(t.componentKeys).toEqual([]);
    expect(extractEntities("cargo airlift sorties", kb)).toMatchObject({ missions: ["Cargo airlift"], types: [] });
    expect(extractEntities("air drops by the freighters", kb)).toMatchObject({ missions: ["Air drop"], types: ["airlifter"] });
    expect(extractEntities("tc-21-04-01", kb).taskCards).toEqual(["TC-21-04-01"]);
    expect(extractEntities("ITT trend", kb).metric).toBe("ITT margin");
    expect(extractEntities("elt battery and main battery", kb).componentKeys).toEqual(expect.arrayContaining(["TR-ELT", "AL-ELT", "BATT-MAIN"]));
  });
});

describe("copy rules", () => {
  it("no em or en dashes in the corpus", () => {
    const raw = fs.readFileSync(path.join(KDIR, "corpus.json"), "utf-8");
    expect(raw).not.toMatch(/[\u2013\u2014]/);
  });
});
