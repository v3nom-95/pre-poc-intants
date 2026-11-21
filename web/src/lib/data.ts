import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");

function readJson<T>(relPath: string): T {
  const full = path.join(DATA_DIR, relPath);
  return JSON.parse(fs.readFileSync(full, "utf-8")) as T;
}

export function getFleet() {
  return readJson<FleetData>("fleet.json");
}

export function getAircraft(tail: string) {
  return readJson<AircraftData>(`aircraft/${tail}.json`);
}

export function getAllAircraftTails(): string[] {
  const dir = path.join(DATA_DIR, "aircraft");
  return fs.readdirSync(dir).map((f) => f.replace(".json", ""));
}

export function getComponent(serial: string) {
  return readJson<ComponentData>(`components/${serial}.json`);
}

export function getAllComponentSerials(): string[] {
  const dir = path.join(DATA_DIR, "components");
  return fs.readdirSync(dir).map((f) => f.replace(".json", ""));
}

export function getRecommendations() {
  return readJson<RecommendationsData>("recommendations.json");
}

export function getReliability() {
  return readJson<ReliabilityData>("reliability.json");
}

export function getModels() {
  return readJson<ModelsData>("models.json");
}

export function getPipeline() {
  return readJson<PipelineData>("pipeline.json");
}

// ---------------------------------------------------------------------------
// Shapes (mirrors engine/src/pre_engine/export.py output)
// ---------------------------------------------------------------------------
export interface FleetData {
  as_of: string;
  aircraft: {
    tail: string;
    base: string;
    status: "Serviceable" | "Monitor" | "Action due" | "Critical";
    airframe_fh: number;
    fi: number;
    induction_date: string;
    planned_withdrawal_year: number;
    open_recs_count: number;
  }[];
  kpis: {
    fleet_fh_12mo: number;
    serviceability_pct: number;
    open_recs_by_priority: Record<string, number>;
    due_30_days_count: number;
    unscheduled_removal_rate_per_1000fh: number;
    unscheduled_removal_rate_delta: number;
  };
  utilisation_monthly: { month: string; base_a_fh: number; base_b_fh: number }[];
  due_90_days: { tail: string; item: string; date: string | null; days_to_due: number | null; fh_to_tau?: number }[];
  top_recommendations: { id: string; title: string; priority: string; tail: string | null }[];
}

export interface Evidence {
  type: string;
  text: string;
}

export interface Recommendation {
  id: string;
  created: string;
  tail: string | null;
  position: string | null;
  serial: string | null;
  part_number: string | null;
  ata: string | null;
  action: string;
  title: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  due: { fh_remaining: number | null; date: string | null; governing: string };
  basis: string;
  evidence: Evidence[];
  confidence: { probability: number; interval: [number, number] } | null;
  status: "Open" | "Approved" | "Rejected" | "Deferred";
  audit: { at: string; by: string; role: string; action: string; remarks: string }[];
  work_order: string | null;
}

export interface RecommendationsData {
  open: Recommendation[];
  history: Recommendation[];
}

export interface AircraftData {
  tail: string;
  base: string;
  induction_date: string;
  planned_withdrawal_year: number;
  airframe_fh: number;
  landings: number;
  fi: number;
  engine_serial: string | null;
  components: {
    ata: string;
    component: string;
    position: string;
    serial: string;
    part_number: string;
    concept: "HT" | "OC" | "CM";
    hours_at_install: number;
    cycles_at_install: number;
    landings_at_install: number;
    install_date: string;
    governing_limit: string | null;
    remaining: number | null;
    fh_to_tau: number | null;
    prob_fail_before_next_phase: number | null;
    next_action: string;
  }[];
  utilisation_monthly: Record<string, string | number>[];
  fi_series: { date: string; fi: number }[];
  fatigue: Record<string, unknown> | null;
  engine_trend_points: { efh: number; margin: number }[];
  engine_trend_info: Record<string, unknown> | null;
  snags: { snag_id: string; date: string; ata: number | null; description: string; rectification: string; status: string }[];
  history: { date: string; type: string; description: string }[];
  recommendations: Recommendation[];
}

export interface ComponentData {
  serial: string;
  part_number: string;
  name: string;
  ata: string;
  lot: string | null;
  concept: "HT" | "OC" | "CM";
  criticality: string;
  current_tail: string;
  current_position: string;
  governing_limit: string | null;
  remaining: number | null;
  fh_exposure: number | null;
  fh_to_tau: number | null;
  fh_to_tau_p10: number | null;
  fh_to_tau_p90: number | null;
  prob_fail_before_next_phase: number | null;
  explanation: string | null;
  fleet_units: number;
  fleet_confirmed_failures: number;
  install_history: { tail: string; event_type: string; date: string; reason: string | null; serial: string }[];
  survival_curve: { fh: number; survival: number }[];
}

export interface ReliabilityData {
  snags_by_ata: { ata: number; count: number; cumulative_share: number }[];
  mtbf_mtbur: { part_number: string; name: string; mtbf_fh: number | null; mtbur_fh: number | null; nff_rate: number }[];
  removal_rate_monthly: { month: string; rate_per_1000fh: number }[];
  removal_rate_per_part: { part_number: string; confirmed_failures: number; fh_exposure: number; removal_rate_per_1000fh: number }[];
  lot_comparison: { part_number: string; lot: string; n_units: number; events: number; exposure_fh: number; rate_per_1000fh: number; rest_of_fleet_rate_per_1000fh: number; p_value_bonferroni: number; flagged: boolean }[];
  environmental_effects: { part_number: string; name: string; time_ratio_full_hot_exposure: number; p_value: number; flagged: boolean }[];
  repeat_nff: { tail: string; part_number: string; position: string; count: number; window_days: number }[];
}

export interface ModelsData {
  model_cards: { name: string; purpose: string; inputs: string; method: string; outputs: string; limits: string }[];
  validation?: {
    note: string;
    pattern_recovery: { id: string; title: string; detector: string; statistic: string; detected: boolean }[];
    patterns_detected: string;
    model_fit_summary: { part_number: string; name: string; n_events: number; n_units: number; in_sample_concordance: number | null }[];
  };
}

export interface PipelineData {
  data_quality?: { check: string; pass: boolean; detail: string; count: number }[];
  ingestion_issues?: Record<string, number>;
}
