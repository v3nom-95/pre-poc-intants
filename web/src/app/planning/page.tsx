import { AppShell } from "@/components/shell/app-shell";
import { PlanningView } from "./planning-view";
import { getWhatifInputs } from "@/lib/whatif-data";

export default function PlanningPage() {
  const { inputs, defaultScenario } = getWhatifInputs();
  return (
    <AppShell>
      <PlanningView inputs={inputs} defaultScenario={defaultScenario} />
    </AppShell>
  );
}
