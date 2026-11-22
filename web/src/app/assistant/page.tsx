import { AppShell } from "@/components/shell/app-shell";
import { AssistantChat } from "@/components/assistant/assistant-chat";

export default function AssistantPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="page-title text-[28px] font-semibold text-(--ink)">Ask PRE</h1>
          <p className="max-w-3xl text-[13px] text-(--ink-2)">
            A query assistant that runs fully offline. It retrieves the pipeline&apos;s own records for all 30
            aircraft (fighters, transports and airlifters): every sortie, components, snags, removals, maintenance
            records, ground runs and APU hours, engine trends per engine, task cards, recommendations, pattern
            detections and the action plan. It computes the answer from them and cites its sources. It does not use a
            language model, so it never invents a figure: if a record is not there, it says so.
          </p>
        </div>
        <section
          aria-label="Ask PRE conversation"
          className="flex h-[calc(100vh-15.5rem)] min-h-[420px] flex-col overflow-hidden rounded-[8px] border border-(--rule) bg-(--sheet)"
        >
          <AssistantChat variant="page" />
        </section>
      </div>
    </AppShell>
  );
}
