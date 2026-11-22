"use client";

import Link from "next/link";
import type { Answer } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

function RecordLink({ href, children, onNavigate, className }: { href: string; children: React.ReactNode; onNavigate?: () => void; className?: string }) {
  if (!href.startsWith("/")) return <span className={className}>{children}</span>;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn("text-(--accent) underline-offset-2 hover:underline focus-visible:rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)", className)}
    >
      {children}
    </Link>
  );
}

export function AnswerView({
  answer,
  onAsk,
  onNavigate,
  compact = false,
}: {
  answer: Answer;
  onAsk: (q: string) => void;
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const { table } = answer;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-[13px] leading-[1.5] text-(--ink)">
      <p className="text-[14px] leading-[1.55]">{answer.text}</p>

      {answer.bullets && answer.bullets.length > 0 && (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-(--ink-2)">
          {answer.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}

      {table && table.rows.length > 0 && (
        <div className="max-w-full overflow-x-auto rounded-[6px] border border-(--rule)">
          <table className="w-full border-collapse text-[12px] tabular-nums">
            <thead>
              <tr className="border-b border-(--rule) bg-(--paper)">
                {table.columns.map((c) => (
                  <th key={c} scope="col" className="px-2.5 py-1.5 text-left font-semibold whitespace-nowrap text-(--ink-2)">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-(--rule) last:border-b-0">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        "px-2.5 py-1.5 align-top text-(--ink)",
                        ci === 0 || typeof cell !== "string" || cell.length <= 16 ? "whitespace-nowrap" : "",
                        compact ? "min-w-[64px]" : "min-w-[72px]",
                        typeof cell === "string" && cell.length > 60 ? "min-w-[220px]" : ""
                      )}
                    >
                      {ci === 0 && table.links?.[ri] ? (
                        <RecordLink href={table.links[ri]!} onNavigate={onNavigate}>
                          {cell}
                        </RecordLink>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {answer.passages && answer.passages.length > 0 && (
        <details className="group rounded-[6px] border border-(--rule) bg-(--paper) px-3 py-2">
          <summary className="cursor-pointer text-[12px] font-semibold text-(--ink-2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">
            Related records ({answer.passages.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {answer.passages.map((p) => (
              <li key={`${p.href}|${p.title}`} className="text-[12px] text-(--ink-2)">
                <RecordLink href={p.href} onNavigate={onNavigate} className="font-medium">
                  {p.title}
                </RecordLink>
                <p className="mt-0.5">{p.text}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {answer.sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-(--ink-2)">Sources</span>
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {answer.sources.map((s) => (
              <li key={`${s.href}|${s.title}`} className="min-w-0 truncate">
                <RecordLink href={s.href} onNavigate={onNavigate} className={s.href.startsWith("/") ? "" : "text-(--ink-2)"}>
                  {s.title}
                </RecordLink>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.followups.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested follow-up questions">
          {answer.followups.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onAsk(f)}
              className="rounded-[6px] border border-(--rule) bg-(--sheet) px-2 py-1 text-left text-[12px] text-(--ink-2) transition-colors hover:border-(--accent) hover:text-(--ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
