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

export function getTypes() {
  return readJson<AircraftTypeInfo[]>("types.json");
}

// ---------------------------------------------------------------------------
// Shapes (mirrors engine/src/pre_engine/export.py output)
// ---------------------------------------------------------------------------
export type AircraftTypeKey = "fighter" | "transport" | "airlifter";

/** types.json (SPEC section 14.1). */
export interface AircraftTypeInfo {
  key: AircraftTypeKey;
  name: string;
  role: string;
  engines: number;
  metric: "EGT margin" | "ITT margin";
  metric_threshold_c: number;
  tail_prefix: string;
  tails: string[];
  /** Mission names in chart slot order (slot 1 to 6 within the type). */
  missions: { name: string; code: string; slot: number }[];
  components: {
    key: string;
    name: string;
    ata: string;
    part_number: string;
    concept: "HT" | "OC" | "CM";
    criticality: "flight_safety" | "mission";
    positions: string[];
    /** Planform zone id per installed position. */
    zones: Record<string, string>;
    life_basis: "FH" | "landings" | "apu_hours";
  }[];
  zones: { id: string; label: string }[];
  ttl_fh: number;
  planned_withdrawal_year: number;
  fatigue_model: string;
  apu: boolean;
}

export interface FleetKpis {
  fleet_fh_12mo: number;
  serviceability_pct: number;
  open_recs_by_priority: Record<string, number>;
  due_30_days_count: number;
  unscheduled_removal_rate_per_1000fh: number;
  unscheduled_removal_rate_delta: number;
}

export interface FleetData {
  as_of: string;
  aircraft: {
    tail: string;
    type: AircraftTypeKey;
    type_name: string;
    base: string;
    status: "Serviceable" | "Monitor" | "Action due" | "Critical";
    airframe_fh: number;
    fi: number;
    induction_date: string;
    planned_withdrawal_year: number;
    open_recs_count: number;
  }[];
  kpis: FleetKpis & {
    /** The same figures per aircraft type (plus the number of aircraft). */
    by_type: Record<AircraftTypeKey, FleetKpis & { aircraft: number }>;
  };
  utilisation_monthly: {
    month: string;
    base_a_fh: number;
    base_b_fh: number;
    fighter_fh: number;
    transport_fh: number;
    airlifter_fh: number;
  }[];
  due_90_days: {
    tail: string;
    type: AircraftTypeKey;
    item: string;
    date: string | null;
    days_to_due: number | null;
    fh_to_tau?: number;
  }[];
  top_recommendations: { id: string; title: string; priority: string; tail: string | null; type: AircraftTypeKey | null }[];
}

export interface Evidence {
  type: string;
  text: string;
}

export interface Recommendation {
  id: string;
  created: string;
  tail: string | null;
  /** Aircraft type of the tail (null only for fleet-level items without a tail). */
  type: AircraftTypeKey | null;
  /** Approved task card cited (SPEC section 14.3). */
  task_card: string | null;
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

export interface EngineTrendInfo {
  tail: string;
  type: AircraftTypeKey;
  engine_position: string;
  engine_serial: string;
  metric: "EGT margin" | "ITT margin";
  limit_c: number;
  current_efh: number;
  current_margin_c: number;
  slope_c_per_efh: number;
  slope_ci_lo: number;
  slope_ci_hi: number;
  projected_efh_to_limit: number | null;
  fleet_p5_slope: number;
  fleet_median_slope: number;
  flag_fleet_outlier: boolean;
  flag_near_term: boolean;
  flagged: boolean;
}

export interface InstalledEngine {
  position: string;
  serial: string;
  zone: string;
  efh: number | null;
  /** EFH plus taxi and ground running since new (SPEC section 14.2). */
  operating_hours: number | null;
  ground_run_hours: number | null;
  metric: "EGT margin" | "ITT margin";
  threshold_c: number;
  trend_points: { efh: number; margin: number }[];
  /** Null when there is too little history since installation (under 100 EFH). */
  trend_info: EngineTrendInfo | null;
}

export interface AircraftData {
  tail: string;
  type: AircraftTypeKey;
  type_name: string;
  role: string;
  engines_fitted: number;
  base: string;
  induction_date: string;
  ttl_fh: number;
  planned_withdrawal_year: number;
  airframe_fh: number;
  landings: number;
  fi: number;
  engine_serial: string | null;
  components: {
    key: string;
    ata: string;
    component: string;
    position: string;
    serial: string;
    /** Planform zone id (SPEC section 14.1). */
    zone: string;
    task_card: string | null;
    criticality: "flight_safety" | "mission";
    /** Unit of fh_to_tau for model-scored items: FH, or APU hours for the APU. */
    exposure_unit: "FH" | "APU hours" | null;
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
  /** First engine (position 1), kept for compatibility. */
  engine_trend_points: { efh: number; margin: number }[];
  engine_trend_info: Record<string, unknown> | null;
  engines: InstalledEngine[];
  /** APU hours in the data window (sorties plus ground runs); null when no APU is fitted. */
  apu_hours: number | null;
  operating_hours: {
    window_start: string;
    flight_hours: number;
    taxi_hours: number;
    ground_run_hours: number;
    ground_runs: number;
    apu_hours: number | null;
  };
  ground_runs: {
    run_id: string;
    date: string;
    engine_position: string;
    duration_h: number;
    apu_h: number;
    reason: string;
  }[];
  snags: { snag_id: string; date: string; ata: number | null; description: string; rectification: string; status: string }[];
  history: { date: string; type: string; description: string }[];
  recommendations: Recommendation[];
}

export interface ComponentData {
  serial: string;
  part_number: string;
  name: string;
  ata: string;
  type: AircraftTypeKey;
  type_name: string;
  key: string;
  zone: string;
  task_card: string | null;
  /** Unit of fh_exposure and fh_to_tau: FH, or APU hours for the APU. */
  exposure_unit: "FH" | "APU hours";
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
  survival_curve_method?: string | null;
}

export interface ReliabilityData {
  snags_by_ata: { ata: number; count: number; cumulative_share: number }[];
  snags_by_ata_by_type: Record<AircraftTypeKey, { ata: number; count: number; cumulative_share: number }[]>;
  mtbf_mtbur: { part_number: string; name: string; type: AircraftTypeKey; mtbf_fh: number | null; mtbur_fh: number | null; nff_rate: number }[];
  removal_rate_monthly: { month: string; rate_per_1000fh: number }[];
  removal_rate_per_part: { part_number: string; name: string | null; type: AircraftTypeKey | null; confirmed_failures: number; fh_exposure: number; removal_rate_per_1000fh: number }[];
  lot_comparison: { part_number: string; type: AircraftTypeKey; lot: string; n_units: number; events: number; exposure_fh: number; rate_per_1000fh: number; rest_of_fleet_rate_per_1000fh: number; p_value_bonferroni: number; flagged: boolean }[];
  environmental_effects: { part_number: string; name: string; type: AircraftTypeKey; time_ratio_full_hot_exposure: number; p_value: number; flagged: boolean }[];
  repeat_nff: { tail: string; type: AircraftTypeKey; part_number: string; position: string; count: number; window_days: number }[];
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
