export function PlaceholderPage({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-2 rounded-[8px] border border-(--rule) bg-(--sheet) text-center">
      <h1 className="text-[18px] font-semibold text-(--ink)">{title}</h1>
      <p className="max-w-sm text-[13px] text-(--ink-2)">
        {note ?? "This screen is wired up in a later phase, once real exported data is available."}
      </p>
    </div>
  );
}
