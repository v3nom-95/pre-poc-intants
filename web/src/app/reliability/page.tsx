import { AppShell } from "@/components/shell/app-shell";
import { ReliabilityView } from "./reliability-view";
import { getReliability } from "@/lib/data";

export default function ReliabilityPage() {
  const data = getReliability();
  return (
    <AppShell>
      <ReliabilityView data={data} />
    </AppShell>
  );
}
