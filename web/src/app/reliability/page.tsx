import { AppShell } from "@/components/shell/app-shell";
import { ReliabilityView } from "./reliability-view";
import { getReliability, getTypes } from "@/lib/data";

export default function ReliabilityPage() {
  const data = getReliability();
  const types = getTypes().map((t) => ({ key: t.key, name: t.name, tails: t.tails.length }));
  return (
    <AppShell>
      <ReliabilityView data={data} types={types} />
    </AppShell>
  );
}
