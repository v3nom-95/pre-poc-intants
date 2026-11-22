"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw } from "lucide-react";
import { EXAMPLE_QUESTIONS } from "@/lib/assistant/compose";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import { AnswerView } from "./answer-view";
import { useAssistantStore } from "./assistant-store";

export function AssistantChat({ variant, onNavigate }: { variant: "page" | "sheet"; onNavigate?: () => void }) {
  const { messages, busy, ask, clear } = useAssistantStore();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const compact = variant === "sheet";

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ block: "end", behavior: reduced ? "auto" : "smooth" });
  }, [messages.length, busy, reduced]);

  const submit = (q: string) => {
    if (!q.trim() || busy) return;
    setDraft("");
    void ask(q).then(() => inputRef.current?.focus());
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={busy}
        aria-label="Conversation"
        className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "px-4 py-3" : "px-5 py-4")}
      >
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-(--ink-2)">
              Ask about any fighter, transport or airlifter, a whole aircraft type, any sortie, component, snag, removal,
              task card, engine trend, operating hours, recommendation or the action plan. Answers are computed from the
              pipeline records on this device, with links to the source records.
            </p>
            <span className="text-[12px] font-semibold text-(--ink-2)">Try one of these</span>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => submit(q)}
                  className="rounded-[6px] border border-(--rule) bg-(--sheet) px-2.5 py-1.5 text-left text-[13px] text-(--ink) transition-colors hover:border-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((m) => (
              <li key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-[8px] bg-(--accent)/10 px-3 py-2 text-[14px] text-(--ink)">
                    <span className="sr-only">You asked: </span>
                    {m.text}
                  </div>
                ) : m.role === "error" ? (
                  <div className="w-full rounded-[8px] border border-(--rule) border-l-[3px] border-l-(--status-critical) bg-(--sheet) px-3 py-2 text-[13px] text-(--ink)">
                    {m.text}
                  </div>
                ) : (
                  <div className="w-full min-w-0 rounded-[8px] border border-(--rule) bg-(--sheet) px-3.5 py-3">
                    <span className="sr-only">PRE answered: </span>
                    <AnswerView answer={m.answer} onAsk={submit} onNavigate={onNavigate} compact={compact} />
                  </div>
                )}
              </li>
            ))}
            {busy && (
              <li className="text-[13px] text-(--ink-2)" aria-label="Searching the records">
                Searching the records
              </li>
            )}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <form
        className={cn("flex flex-none items-center gap-2 border-t border-(--rule) bg-(--sheet)", compact ? "px-4 py-3" : "px-5 py-3")}
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <label htmlFor={`assistant-input-${variant}`} className="sr-only">
          Ask a question about the fleet
        </label>
        <input
          ref={inputRef}
          id={`assistant-input-${variant}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="For example: what is wrong with TX-404?"
          autoComplete="off"
          className="h-9 min-w-0 flex-1 rounded-[6px] border border-(--rule) bg-(--paper) px-3 text-[14px] text-(--ink) placeholder:text-(--ink-3) focus-visible:border-(--accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          aria-label="Ask"
          className="inline-flex size-9 flex-none items-center justify-center rounded-[6px] bg-(--accent) text-(--sheet) transition-opacity disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowUp className="size-4" strokeWidth={2} aria-hidden />
        </button>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear conversation"
            title="Clear conversation"
            className="inline-flex size-9 flex-none items-center justify-center rounded-[6px] border border-(--rule) text-(--ink-2) hover:text-(--ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
          >
            <RotateCcw className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </form>
    </div>
  );
}
