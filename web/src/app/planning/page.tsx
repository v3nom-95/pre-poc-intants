import { AppShell } from "@/components/shell/app-shell";
import { PlanningView } from "./planning-view";
import { getFleet, getAircraft, getAllAircraftTails } from "@/lib/data";

export default function PlanningPage() {
  const fleet = getFleet();
  const fatigue = getAllAircraftTails()
    .map((tail) => getAircraft(tail).fatigue)
    .filter((f): f is NonNullable<typeof f> => !!f)
    .map((f) => ({
      tail: f.tail as string,
      fi_now: f.fi_now as number,
      fh_trailing_12mo: f.fh_trailing_12mo as number,
      fi_per_fh: f.fi_per_fh as number,
      acm_share_trailing: f.acm_share_trailing as number,
      planned_withdrawal_year: f.planned_withdrawal_year as number,
    }));

  return (
    <AppShell>
      <PlanningView fleet={fleet} fatigue={fatigue} />
    </AppShell>
  );
}
