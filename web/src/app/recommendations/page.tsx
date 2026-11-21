import { AppShell } from "@/components/shell/app-shell";
import { RecommendationsView } from "./recommendations-view";
import { getRecommendations } from "@/lib/data";

export default function RecommendationsPage() {
  const { open, history } = getRecommendations();

  return (
    <AppShell>
      <RecommendationsView open={open} history={history} />
    </AppShell>
  );
}
