import { AppShell } from "@/components/shell/app-shell";
import { AircraftReport } from "@/components/report/aircraft-report";
import { getAircraft, getAllAircraftTails, getFleet } from "@/lib/data";
import { getPlan } from "@/lib/plan-data";
import type { PlanData } from "@/lib/plan-types";

export function generateStaticParams() {
  return getAllAircraftTails().map((tail) => ({ tail }));
}

function loadPlan(): PlanData | null {
  try {
    return getPlan();
  } catch {
    return null;
  }
}

export default async function AircraftReportPage({ params }: { params: Promise<{ tail: string }> }) {
  const { tail } = await params;
  const aircraft = getAircraft(tail);
  const fleet = getFleet();
  const status = fleet.aircraft.find((a) => a.tail === tail)?.status ?? "Serviceable";

  return (
    <AppShell>
      <AircraftReport aircraft={aircraft} status={status} asOf={fleet.as_of} plan={loadPlan()} />
    </AppShell>
  );
}
