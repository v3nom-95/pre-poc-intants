// Shapes of web/public/data/plan.json (mirrors engine/src/pre_engine/action_plan.py).
import type { Priority, Status } from "./domain-types";

export type PlanSlot =
  | "Before next flight"
  | "Next periodic servicing"
  | "Next phase inspection"
  | "Dedicated input"
  | "Fleet tasking review";

export const PLAN_SLOTS: PlanSlot[] = [
  "Before next flight",
  "Next periodic servicing",
  "Next phase inspection",
  "Dedicated input",
  "Fleet tasking review",
];

export type PlanInputKind =
  | "Phase inspection"
  | "Periodic servicing"
  | "Dedicated input"
  | "Before next flight input";

export interface PlanTask {
  id: string;
  rec_id: string | null;
  /** Aircraft type key (fighter, transport, airlifter); null for fleet items. */
  type?: string | null;
  /** Approved task card the recommendation cites (SPEC 14.3). */
  task_card?: string | null;
  tail: string | null;
  serial: string | null;
  part_number: string | null;
  component: string | null;
  position: string | null;
  ata: string | null;
  action: string;
  priority: Priority;
  title: string;
  basis: string;
  deadline: { date: string | null; fh_remaining: number | null; governing: string; date_basis: string };
  planned_date: string;
  slot: PlanSlot;
  input_id: string | null;
  man_hours: number;
  downtime_days: number;
  fh_before_slot: number | null;
  risk_if_deferred: { probability: number; to: string; fh: number } | null;
  risk_until_planned: number | null;
  within_horizon: boolean;
  rationale: string;
  sequence: number;
}

export interface PlanInput {
  id: string;
  kind: PlanInputKind;
  start: string;
  end: string;
  task_ids: string[];
  man_hours: number;
  in_progress: boolean;
}

export interface PlanAircraft {
  tail: string;
  type?: string;
  base: string;
  status: Status;
  fh_per_day: number;
  next_periodic: { date: string; fh_to_go: number; in_progress: boolean } | null;
  next_phase: { date: string; fh_to_go: number; in_progress: boolean } | null;
  inputs: PlanInput[];
  task_ids: string[];
  man_hours: number;
  outlook: string;
}

export interface PlanWeek {
  week_start: string;
  scheduled_man_hours: number;
  recommended_man_hours: number;
  aircraft_in_maintenance: number;
  availability_pct: number;
}

export interface PlanSpare {
  part_number: string;
  component: string;
  units_required: number;
  task_ids: string[];
  first_needed: string;
}

export interface PlanData {
  as_of: string;
  horizon_days: number;
  method: string[];
  standards: {
    task_man_hours: Record<string, number>;
    daily_capacity_man_hours: number;
    safety_margin_days: number;
    safety_margin_fh: number;
    phase_days: number;
    periodic_days: number;
    phase_man_hours: number;
    periodic_man_hours: number;
  };
  summary: {
    tasks_total: number;
    aircraft_with_tasks: number;
    man_hours_total: number;
    tasks_by_priority: Record<Priority, number>;
    tasks_this_week: number;
    tasks_beyond_horizon: number;
    peak_week: { week_start: string; man_hours: number };
    min_availability_pct: number;
    min_availability_week: string;
    slots: Record<PlanSlot, number>;
  };
  next_actions: string[];
  tasks: PlanTask[];
  aircraft: PlanAircraft[];
  weekly: PlanWeek[];
  spares: PlanSpare[];
}
