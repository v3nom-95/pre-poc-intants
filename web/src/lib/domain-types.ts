export type Status = "Serviceable" | "Monitor" | "Action due" | "Critical";
export type Priority = "Critical" | "High" | "Medium" | "Low";
export type RecAction =
  | "Inspect"
  | "Service"
  | "Replace"
  | "Remove for overhaul"
  | "Troubleshoot"
  | "Monitor"
  | "Review allocation";
export type RecBasis = "Rule" | "Model" | "Hybrid";
export type RecStatus = "Open" | "Approved" | "Rejected" | "Deferred";
export type Concept = "HT" | "OC" | "CM";

export const STATUS_VAR: Record<Status, string> = {
  Serviceable: "var(--status-serviceable)",
  Monitor: "var(--status-monitor)",
  "Action due": "var(--status-action-due)",
  Critical: "var(--status-critical)",
};

export const PRIORITY_VAR: Record<Priority, string> = {
  Critical: "var(--status-critical)",
  High: "var(--status-action-due)",
  Medium: "var(--status-monitor)",
  Low: "var(--status-serviceable)",
};

export const CHART_CATEGORICAL = [
  "var(--chart-cat-1)",
  "var(--chart-cat-2)",
  "var(--chart-cat-3)",
  "var(--chart-cat-4)",
  "var(--chart-cat-5)",
  "var(--chart-cat-6)",
] as const;

export const CHART_SEQUENTIAL = [
  "var(--chart-seq-1)",
  "var(--chart-seq-2)",
  "var(--chart-seq-3)",
  "var(--chart-seq-4)",
  "var(--chart-seq-5)",
  "var(--chart-seq-6)",
  "var(--chart-seq-7)",
] as const;

export const GLOSSARY: { term: string; meaning: string }[] = [
  { term: "FH", meaning: "Flight hours (airframe)." },
  { term: "EFH", meaning: "Engine flight hours." },
  { term: "LCF cycles", meaning: "Low cycle fatigue cycles on the engine (full throttle excursions). Drives life of engine rotating parts." },
  { term: "Sortie", meaning: "One flight: take-off to final landing. One sortie can have several landings (touch-and-go circuits)." },
  { term: "TSN / TSO", meaning: "Time since new / time since overhaul (FH, EFH or cycles depending on component)." },
  { term: "TBO", meaning: "Time between overhauls." },
  { term: "TTL", meaning: "Total technical life (airframe)." },
  { term: "Fatigue index (FI)", meaning: "Airframe structural fatigue consumed, 0 to 100, where 100 equals design fatigue life. Fighters accumulate it from g-loading per sortie; transports and airlifters from pressurisation cycles, landings and gust exposure." },
  { term: "Hard time (HT)", meaning: "Component removed at a fixed limit (FH, cycles, landings or calendar), whichever comes first." },
  { term: "On-condition (OC)", meaning: "Component inspected or checked periodically and replaced when condition requires." },
  { term: "Condition monitoring (CM)", meaning: "No scheduled task; failures are monitored and analysed statistically." },
  { term: "Life-limited part (LLP)", meaning: "Part with a mandatory hard life (for example engine turbine disc)." },
  { term: "Snag", meaning: "A defect reported against an aircraft, recorded in the snag register." },
  { term: "Repeat snag", meaning: "Same defect recurring on the same aircraft within a defined window." },
  { term: "Unscheduled removal", meaning: "Component removed due to a failure or suspected failure." },
  { term: "NFF", meaning: "No fault found: removed unit tests serviceable in the shop." },
  { term: "MTBF / MTBUR", meaning: "Mean time between failures (confirmed) and mean time between unscheduled removals (includes NFF)." },
  { term: "Phase inspection", meaning: "Scheduled major inspection every 150 FH. Minor periodic servicing every 50 FH." },
  { term: "EGT margin", meaning: "Exhaust gas temperature margin below the limit (degrees C). Decreases with engine deterioration." },
  { term: "ITT margin", meaning: "Inter-turbine temperature margin below the limit (degrees C), monitored on turboprop engines in place of EGT margin. Decreases with engine deterioration." },
  { term: "Borescope inspection", meaning: "Internal visual inspection of engine hot section through access ports." },
  { term: "SOAP", meaning: "Spectrometric oil analysis programme." },
  { term: "Cannibalisation", meaning: "Moving a serviceable part from one aircraft to another." },
  { term: "Serviceability", meaning: "Share of aircraft serviceable (available to fly) over a period." },
  { term: "CAD/PAD", meaning: "Cartridge and propellant actuated devices (ejection seat pyrotechnics), calendar-life items." },
  { term: "Multirole fighter", meaning: "Single-seat, single-engine combat type in this fictional fleet (tails FX)." },
  { term: "Twin-engine transport", meaning: "Pressurised twin-turboprop type for passenger and utility tasks in this fictional fleet (tails TX)." },
  { term: "Four-engine airlifter", meaning: "Pressurised four-turboprop cargo type with a rear ramp in this fictional fleet (tails CX)." },
  { term: "Engine operating hours", meaning: "Engine running time: flight hours plus taxi and ground running. Always at least the engine flight hours (EFH)." },
  { term: "Ground run", meaning: "Engine run on the ground, typically after maintenance or an engine change, logged per engine position." },
  { term: "APU", meaning: "Auxiliary power unit: a small gas turbine giving electrical power and bleed air on the ground. Tracked in APU hours." },
  { term: "Task card", meaning: "Approved maintenance procedure with task type, standard man-hours and manual reference. Every recommendation cites one." },
  { term: "Pressurisation cycle", meaning: "One cabin pressurise and depressurise cycle, usually one per flight; a fatigue driver for pressurised fuselages." },
  { term: "Air drop", meaning: "Airlifter mission delivering loads or personnel by parachute through the rear ramp; weighs more in the fatigue model." },
  { term: "Engine position", meaning: "Engines are numbered 1 to 4 from left outboard to right outboard." },
];
