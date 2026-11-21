import { AppShell } from "@/components/shell/app-shell";
import { ReportsView } from "./reports-view";
import { getFleet, getReliability } from "@/lib/data";

export default function ReportsPage() {
  const fleet = getFleet();
  const reliability = getReliability();
  return (
    <AppShell>
      <ReportsView fleet={fleet} reliability={reliability} />
    </AppShell>
  );
}
