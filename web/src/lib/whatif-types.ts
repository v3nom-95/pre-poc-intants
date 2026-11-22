// Shapes of web/public/data/whatif.json (engine/src/pre_engine/whatif.py).

export interface WhatifProgramme {
  phase_interval_fh: number;
  periodic_interval_fh: number;
  phase_days: number;
  periodic_days: number;
  phase_man_hours: number;
  periodic_man_hours: number;
}

export interface WhatifAircraft {
  tail: string;
  type: string;
  base: string;
  fh_per_day: number;
  cycles_per_day: number;
  landings_per_day: number;
  fh_trailing_12mo: number;
  acm_share: number;
  gen_share: number;
  fi_now: number;
  fi_trailing_12mo: number;
  planned_withdrawal_year: number;
  since_phase: number;
  since_periodic: number;
  busy_days: number;
  busy_kind: string | null;
}

export interface WhatifUnit {
  tail: string;
  type: string;
  part_number: string;
  serial: string;
  position: string;
  component: string;
  criticality: string;
  t: number;
  x: Record<string, number>;
  man_hours: number;
}

export interface WhatifSurvival {
  rho: number;
  intercept: number;
  covariates: string[];
  coefficients: Record<string, number>;
}

export interface WhatifHtItem {
  tail: string;
  type: string;
  serial: string;
  part_number: string;
  position: string;
  component: string;
  // Days to due from the rules engine at the trailing rate; usage limits
  // scale with utilisation, calendar limits do not.
  limits: { governing: string; remaining: number; baseline_days: number; scales_with_use: boolean }[];
  man_hours: number;
}

export interface Scenario {
  utilisation_change_pct: number;
  utilisation_type: string; // "all" or a type key
  acm_share_change_pts: number;
  detachment_size: number;
  horizon_months: number;
}

export interface PbSummary {
  mean: number;
  p10: number;
  p90: number;
}

export interface ScenarioMonth {
  start: string;
  fh: number;
  scheduled_man_hours: number;
  unscheduled_man_hours: number;
  expected_failures: number;
  scheduled_down_days: number;
  unscheduled_down_days: number;
  serviceability_pct: number;
}

export interface ScenarioResult {
  horizon_days: number;
  expected_failures: PbSummary;
  months: ScenarioMonth[];
  by_type: {
    type: string;
    fh: number;
    scheduled_man_hours: number;
    unscheduled_man_hours: number;
    serviceability_pct: number;
    units: number;
    expected_failures: PbSummary;
  }[];
  ht_due: {
    tail: string;
    type: string;
    serial: string;
    component: string;
    part_number: string;
    position: string;
    governing: string | null;
    days_to_due: number;
  }[];
  fi: {
    tail: string;
    type: string;
    fi_now: number;
    baseline_days: number | null;
    scenario_days: number | null;
    planned_withdrawal_year: number;
  }[];
  totals: { fh: number; scheduled_man_hours: number; unscheduled_man_hours: number };
}

export interface WhatifInputs {
  as_of: string;
  bucket_days: number;
  max_horizon_months: number;
  day_month: number[];
  day_year: number[];
  bucket_starts: string[];
  types: { key: string; name: string; aircraft: number }[];
  programme: Record<string, WhatifProgramme>;
  bases: {
    monthly_mean_temp_c: Record<string, number[]>;
    hot: Record<string, boolean[]>;
    hot_threshold_c: number;
  };
  detachment: {
    base: string;
    home_base: string;
    months: number[];
    baseline_size: number;
    max_size: number;
    rotation: Record<string, string[]>;
  };
  fighter_fi: { acm_mission: string; gen_mission: string; fi_per_fh_acm: number; fi_per_fh_gen: number };
  fi_limit: number;
  aog_days_per_unscheduled_removal: number;
  aog_sample_size: number;
  man_hours_source: string;
  aircraft: WhatifAircraft[];
  units: WhatifUnit[];
  units_excluded_no_model: number;
  survival: Record<string, WhatifSurvival>;
  ht_items: WhatifHtItem[];
}

export interface WhatifData extends WhatifInputs {
  default_scenario: Scenario;
  parity_fixtures: { name: string; scenario: Scenario; result: ScenarioResult }[];
}
