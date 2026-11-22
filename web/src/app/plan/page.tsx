import { AppShell } from "@/components/shell/app-shell";
import { PlanView } from "@/components/plan/plan-view";
import { getPlan } from "@/lib/plan-data";
import { getTypes } from "@/lib/data";
import { formatDate } from "@/lib/format";

export default function ActionPlanPage() {
  const plan = getPlan();
  const types = getTypes().map((t) => ({ key: t.key, name: t.name }));
  return (
    <AppShell asOfLabel={formatDate(plan.as_of)}>
      <PlanView plan={plan} types={types} />
    </AppShell>
  );
}
