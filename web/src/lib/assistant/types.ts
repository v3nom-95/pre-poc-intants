// Shapes of the knowledge corpus written by engine/src/pre_engine/knowledge.py
// and of the answers the offline assistant returns.

export type DocType =
  | "aircraft"
  | "component"
  | "part"
  | "snag"
  | "event"
  | "maintenance"
  | "utilisation"
  | "recommendation"
  | "pattern"
  | "kpi"
  | "data_quality"
  | "model"
  | "schedule"
  | "glossary"
  | "plan"
  | "plan_task"
  | "plan_aircraft"
  | "fleet_type"
  | "task_card"
  | "ground_runs";

export type TypeKey = "fighter" | "transport" | "airlifter";

export interface DocKeys {
  tail?: string;
  serial?: string;
  part_number?: string;
  ata?: string;
  rec_id?: string;
  task_id?: string;
  task_card?: string;
}

/** A document after hydration in the browser (knowledge.ts). */
export interface KDoc<F = unknown> {
  id: string;
  type: DocType;
  title: string;
  text: string;
  href: string;
  keys: DocKeys;
  date?: string;
  facts?: F;
}

/** A document as stored in corpus.json: type is implied by the id prefix,
 * and title and link are derived for template-titled record types. */
export interface RawDoc {
  id: string;
  type?: DocType;
  title?: string;
  text: string;
  href?: string;
  keys: DocKeys;
  date?: string;
  facts?: Record<string, unknown>;
}

export interface ComponentInfo {
  key: string;
  name: string;
  part_number: string;
  ata: string;
  concept: "HT" | "OC" | "CM";
  criticality: string;
  positions: string[];
  type?: TypeKey;
}

export interface TypeInfo {
  name: string;
  role: string;
  tails: string[];
  engines: number;
  metric: string;
  metric_limit_c?: number | null;
  missions: string[];
  apu?: boolean;
}

export interface Corpus {
  as_of: string;
  tails: string[];
  bases: string[];
  missions: string[];
  mission_codes: Record<string, string>;
  components: ComponentInfo[];
  types?: Record<string, TypeInfo>;
  thresholds: {
    egt_margin_limit_c: number;
    itt_margin_limit_c?: number;
    phase_interval_fh: number;
    periodic_interval_fh: number;
    ttl_fh: number;
    ttl_fh_by_type?: Record<string, number>;
  };
  type_by_prefix?: Record<string, DocType>;
  docs: RawDoc[];
}

export interface SortieFile {
  tail: string;
  type?: string;
  as_of: string;
  missions: string[];
  type_missions?: string[];
  bases: string[];
  columns: string[];
  rows: (string | number)[][];
}

export interface Sortie {
  id: string;
  tail: string;
  date: string;
  mission: string;
  duration: number;
  landings: number;
  lcf: number;
  peakG: number;
  base: string;
  tempC: number;
  takeoff: string;
  landing: string;
  fiConsumed: number;
  fiCumulative: number;
  /** Taxi hours (engine running on the ground for this sortie). */
  taxi: number;
  /** APU hours logged for this sortie (0 where no APU is fitted). */
  apu: number;
}

// ---------------------------------------------------------------------------
// Facts per document type
// ---------------------------------------------------------------------------
export interface EngineTrendFacts {
  engine_serial: string;
  engine_position?: string;
  metric?: string;
  current_efh: number | null;
  current_margin_c: number | null;
  slope_c_per_efh: number | null;
  slope_ci_lo: number | null;
  slope_ci_hi: number | null;
  projected_efh_to_limit: number | null;
  flag_fleet_outlier: boolean;
  flag_near_term: boolean;
  flagged: boolean;
  limit_c: number;
}

export interface EngineFacts {
  position: string;
  serial: string;
  efh: number | null;
  operating_hours: number | null;
  ground_run_hours: number | null;
  metric: string;
  threshold_c: number | null;
  trend: EngineTrendFacts | null;
}

export interface OperatingHoursFacts {
  window_start: string;
  flight_hours: number | null;
  taxi_hours: number | null;
  ground_run_hours: number | null;
  ground_runs: number | null;
  apu_hours: number | null;
}

export interface FatigueFacts {
  fi_now: number | null;
  fh_trailing_12mo: number | null;
  fi_per_fh: number | null;
  acm_share_trailing: number | null;
  projected_fi100_date: string | null;
  flagged_before_withdrawal: boolean;
  life_gain_days_if_acm_shifted: number | null;
  heavy_mission?: string | null;
  relief_mission?: string | null;
  heavy_mission_share_trailing?: number | null;
  fatigue_model?: string | null;
  life_gain_days_if_shifted?: number | null;
}

export interface AircraftFacts {
  tail: string;
  type: TypeKey;
  type_name: string;
  role: string;
  base: string;
  status: string;
  induction_date: string;
  planned_withdrawal_year: number;
  airframe_fh: number;
  ttl_fh: number;
  landings: number;
  fi: number;
  fh_12mo: number;
  sorties_12mo: number;
  mission_fh_12mo: Record<string, number>;
  open_recs: number;
  open_recs_by_priority: Record<string, number>;
  open_snags: number;
  engine_serial: string | null;
  engine_serials: string[];
  engines: EngineFacts[];
  apu_hours: number | null;
  operating_hours: OperatingHoursFacts | null;
  last_sortie_date: string | null;
  /** The headline engine trend: a flagged engine first, else the fastest deterioration. */
  engine_trend: EngineTrendFacts | null;
  fatigue: FatigueFacts | null;
}

export interface FleetTypeFacts {
  type: TypeKey;
  name: string;
  role: string;
  engines: number;
  metric: string;
  metric_threshold_c: number | null;
  tails: string[];
  missions: string[];
  components: number;
  ttl_fh: number | null;
  planned_withdrawal_year: number | null;
  fatigue_model: string | null;
  apu: boolean | null;
  fh_12mo: number;
  sorties_12mo: number;
  mission_fh_12mo: Record<string, number>;
  open_recs: number;
  open_recs_by_priority: Record<string, number>;
  kpis: {
    aircraft: number;
    fleet_fh_12mo: number;
    serviceability_pct: number;
    due_30_days_count: number;
    unscheduled_removal_rate_per_1000fh: number;
    unscheduled_removal_rate_delta: number;
  } | null;
}

export interface TaskCardFacts {
  task_card: string;
  title: string;
  types: TypeKey[];
  task_type: string;
  part_number?: string;
  ata: string;
  key?: string;
  man_hours: number | null;
  elapsed_hours: number | null;
  interval: string;
  reference: string;
}

export interface GroundRunFacts {
  tail: string;
  columns: string[];
  /** [run_id, date, engine_position, duration_h, apu_h, reason] */
  rows: [string, string, string, number, number, string][];
}

export interface ComponentFacts {
  serial: string;
  part_number: string;
  component: string;
  key: string;
  ata: string;
  tail: string;
  position: string;
  lot: string | null;
  concept: "HT" | "OC" | "CM";
  criticality: string;
  install_date: string;
  installs: number;
  type?: TypeKey;
  zone?: string;
  task_card?: string;
  exposure_unit?: string;
  ht?: {
    governing: string;
    remaining: number | null;
    remaining_unit: string;
    days_to_due: number | null;
    due_date: string;
    all_limits: { governing: string; remaining: number | null; days_to_due: number | null }[];
  };
  risk?: {
    fh_exposure: number | null;
    tau: number | null;
    prob_fail_before_next_phase: number | null;
    fh_to_tau: number | null;
    fh_to_tau_p10: number | null;
    fh_to_tau_p90: number | null;
    explanation: string | null;
  };
}

export interface LotFacts {
  lot: string;
  n_units: number;
  events: number;
  exposure_fh: number;
  rate_per_1000fh: number;
  rest_rate: number;
  p_value: number;
  flagged: boolean;
}

export interface PartFacts {
  part_number: string;
  component: string;
  key: string;
  ata: string;
  concept: string;
  criticality: string;
  positions: string[];
  confirmed_failures: number | null;
  fh_exposure: number | null;
  rate_per_1000fh: number | null;
  mtbf_fh: number | null;
  mtbur_fh: number | null;
  nff_rate: number | null;
  removals_by_reason: Record<string, number>;
  ht_limits: string[];
  lots: LotFacts[];
  env: { time_ratio: number; p_value: number; flagged: boolean } | null;
  model_events: number | null;
  model_units: number | null;
  type?: TypeKey;
}

export interface SnagFacts {
  snag_id: string;
  tail: string;
  date: string;
  ata: string | null;
  key: string | null;
  component: string | null;
  description: string;
  rectification: string;
  status: string;
  repeat_flag: boolean;
}

export interface EventFacts {
  event_id: string;
  tail: string;
  position: string;
  part_number: string;
  component: string;
  key: string | null;
  serial: string;
  lot: string | null;
  event_type: "Install" | "Removal";
  date: string;
  reason: string | null;
  hours_at_event: number | null;
}

export interface MaintFacts {
  record_id: string;
  tail: string;
  date: string;
  record_type: string;
  description: string;
  man_hours: number | null;
  linked_snag_id: string | null;
}

export interface UtilFacts {
  tail: string;
  month: string;
  sorties: number;
  fh: number;
  landings: number;
  lcf_cycles: number;
  missions: Record<string, { sorties: number; fh: number }>;
}

export interface RecFacts {
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
  evidence: { type: string; text: string }[];
  confidence: { probability: number; interval: [number, number] } | null;
  status: string;
  audit: { at: string; by: string; role: string; action: string; remarks: string }[];
  work_order: string | null;
  is_open: boolean;
  type?: TypeKey;
  task_card?: string | null;
}

export interface PatternFacts {
  kind: "lot" | "environment" | "repeat_snag" | "repeat_nff" | "oil_fleet" | "oil_active" | "egt" | "fatigue";
  [k: string]: unknown;
}

export interface KpiFacts {
  as_of: string;
  fleet_fh_12mo: number;
  serviceability_pct: number;
  open_recs_by_priority: Record<string, number>;
  due_30_days_count: number;
  unscheduled_removal_rate_per_1000fh: number;
  unscheduled_removal_rate_delta: number;
  by_type?: Record<string, {
    aircraft: number;
    fleet_fh_12mo: number;
    serviceability_pct: number;
    open_recs_by_priority: Record<string, number>;
    due_30_days_count: number;
    unscheduled_removal_rate_per_1000fh: number;
    unscheduled_removal_rate_delta: number;
  }>;
}

export interface PlanTaskFacts {
  id: string;
  rec_id?: string | null;
  tail?: string | null;
  serial?: string | null;
  part_number?: string | null;
  component?: string | null;
  position?: string | null;
  ata?: string | null;
  action?: string;
  priority?: string;
  title?: string;
  deadline?: { date?: string | null; fh_remaining?: number | null; governing?: string | null } | null;
  planned_date?: string | null;
  slot?: string | null;
  input_id?: string | null;
  man_hours?: number | null;
  downtime_days?: number | null;
  risk_if_deferred?: { probability?: number | null; to?: string | null; fh?: number | null } | null;
  rationale?: string | null;
  sequence?: number | null;
  type?: TypeKey | null;
  task_card?: string | null;
}

export interface PlanAircraftFacts {
  tail: string;
  base?: string;
  status?: string;
  fh_per_day?: number | null;
  next_periodic?: { date?: string | null; fh_to_go?: number | null } | null;
  next_phase?: { date?: string | null; fh_to_go?: number | null } | null;
  inputs?: { id: string; kind: string; start?: string; end?: string; task_ids?: string[]; man_hours?: number }[];
  task_ids?: string[];
  outlook?: string | null;
}

export interface PlanSummaryFacts {
  summary: {
    tasks_total?: number;
    aircraft_with_tasks?: number;
    man_hours_total?: number;
    tasks_by_priority?: Record<string, number>;
    tasks_this_week?: number;
    peak_week?: { week_start?: string; man_hours?: number } | null;
    min_availability_pct?: number | null;
    min_availability_week?: string | null;
  };
  horizon_days?: number;
  next_actions?: string[];
  spares?: { part_number: string; component: string; units_required: number; task_ids?: string[] }[];
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------
export interface AnswerTable {
  columns: string[];
  rows: (string | number)[][];
  /** Optional link per row (for example the aircraft or component page). */
  links?: (string | null)[];
}

export interface Source {
  title: string;
  href: string;
}

export interface Passage {
  title: string;
  text: string;
  href: string;
}

export type Intent =
  | "help"
  | "glossary"
  | "aircraft"
  | "component"
  | "next_action"
  | "recommendations"
  | "due"
  | "risk"
  | "snags"
  | "removals"
  | "maintenance"
  | "sorties"
  | "engine"
  | "fatigue"
  | "reliability"
  | "rank"
  | "compare"
  | "kpi"
  | "data_quality"
  | "patterns"
  | "models"
  | "plan"
  | "fleet_type"
  | "operating"
  | "task_card"
  | "fallback";

export interface Answer {
  intent: Intent;
  text: string;
  bullets?: string[];
  table?: AnswerTable;
  sources: Source[];
  passages?: Passage[];
  followups: string[];
  /** Entities this answer was about, carried into follow-up questions. */
  context?: { tail?: string; serial?: string; partNumber?: string };
}
