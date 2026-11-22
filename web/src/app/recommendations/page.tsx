import { AppShell } from "@/components/shell/app-shell";
import { RecommendationsView } from "./recommendations-view";
import { getRecommendations, getTypes } from "@/lib/data";
import { getTaskCards, type TaskCard } from "./task-cards";

export default function RecommendationsPage() {
  const { open, history } = getRecommendations();
  const types = getTypes().map((t) => ({ key: t.key, name: t.name, tails: t.tails }));
  const allCards = getTaskCards();
  // Only ship the task cards the queue actually cites.
  const taskCards: Record<string, TaskCard> = {};
  for (const r of [...open, ...history]) {
    if (r.task_card && allCards[r.task_card]) taskCards[r.task_card] = allCards[r.task_card];
  }

  return (
    <AppShell>
      <RecommendationsView open={open} history={history} types={types} taskCards={taskCards} />
    </AppShell>
  );
}
