import type { Status } from "@/lib/domain-types";

const SEVERITY: Record<Status, number> = {
  Serviceable: 0,
  Monitor: 1,
  "Action due": 2,
  Critical: 3,
};

export function worstStatus(statuses: Status[]): Status {
  if (statuses.length === 0) return "Serviceable";
  return statuses.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), statuses[0]);
}
