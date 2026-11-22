// Shapes of the validation payload in models.json (written by
// engine/src/pre_engine/validate.py and backtest.py). Kept apart from
// lib/data.ts so the validation workstream owns its own types.

export interface Distribution {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export interface BacktestFailure {
  tail: string;
  type: string | null;
  part_number: string;
  name: string;
  serial: string;
  failure_date: string;
  alerted: boolean;
  covered: boolean;
  lead_fh: number | null;
  lead_days: number | null;
  alert_basis: string | null;
}

export interface Backtest {
  cutoff: string;
  test_start: string;
  test_end: string;
  training: {
    n_legs: number;
    n_events: number;
    max_install_date: string | null;
    max_removal_date: string | null;
    parts_fitted: number;
  };
  concordance: {
    summary: {
      pooled: number | null;
      event_weighted_mean_of_parts: number | null;
      parts_evaluated: number;
      parts_total: number;
      min_test_events: number;
      n_units: number;
      n_test_events: number;
    };
    per_part: {
      part_number: string;
      name: string;
      n_units: number;
      n_test_events: number;
      concordance: number | null;
    }[];
  };
  calibration: {
    summary: {
      expected_total: number;
      observed_total: number;
      observed_to_expected: number | null;
      top_decile_share_of_failures: number | null;
      brier_score: number | null;
    };
    deciles: {
      decile: number;
      n_units: number;
      mean_predicted_prob: number;
      expected_failures: number;
      observed_failures: number;
    }[];
    by_type: { type: string; n_units: number; expected: number; observed: number }[];
  };
  recall: {
    as_of_points: string[];
    failures_in_test_window: number;
    covered: number;
    recall: number | null;
    alerted_any_lead: number;
    lead_min_fh: number;
    lead_time_fh: Distribution | null;
    lead_time_days: Distribution | null;
    lead_time_histogram: { label: string; lo: number; hi: number | null; count: number }[];
    alerts_raised: number;
    test_window_fh: number;
    alert_rate_per_1000fh: number | null;
    open_alerts_by_month: { as_of: string; open_alerts: number }[];
    by_type: { type: string; failures: number; covered: number; recall: number | null }[];
    failures: BacktestFailure[];
  };
  simplifications: string[];
}

export interface PatternRecoveryRow {
  id: string;
  title: string;
  detector: string;
  statistic: string;
  detected: boolean;
  planted?: boolean;
}

export interface ValidationPayload {
  note: string;
  backtest?: Backtest;
  pattern_recovery: PatternRecoveryRow[];
  patterns_detected: string;
  model_fit_summary: {
    part_number: string;
    name: string;
    n_events: number;
    n_units: number;
    in_sample_concordance: number | null;
  }[];
}
