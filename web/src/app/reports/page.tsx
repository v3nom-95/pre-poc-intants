import { AppShell } from "@/components/shell/app-shell";
import { ReportsView } from "./reports-view";
import { getFleet, getReliability, getTypes } from "@/lib/data";

export default function ReportsPage() {
  const fleet = getFleet();
  const reliability = getReliability();
  const types = getTypes();
  return (
    <AppShell>
      <ReportsView fleet={fleet} reliability={reliability} types={types} />
    </AppShell>
  );
}
