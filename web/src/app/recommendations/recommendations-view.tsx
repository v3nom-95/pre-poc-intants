"use client";

import { useMemo, useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PriorityTag } from "@/components/domain/status-tag";
import { TailNumber } from "@/components/domain/tail-number";
import { formatDate, formatFH } from "@/lib/format";
import { useUiStore } from "@/lib/ui-store";
import { useReviewStore } from "@/lib/review-store";
import type { Recommendation } from "@/lib/data";
import type { Priority, RecStatus } from "@/lib/domain-types";

const PRIORITY_ORDER: Priority[] = ["Critical", "High", "Medium", "Low"];

function effectiveStatus(rec: Recommendation, override?: { status: RecStatus }): RecStatus {
  return override?.status ?? rec.status;
}

export function RecommendationsView({ open, history }: { open: Recommendation[]; history: Recommendation[] }) {
  const all = useMemo(() => [...open, ...history], [open, history]);
  const decisions = useReviewStore((s) => s.decisions);
  const resetDemo = useReviewStore((s) => s.reset);

  const [priority, setPriority] = useState("All");
  const [action, setAction] = useState("All");
  const [basis, setBasis] = useState("All");
  const [tail, setTail] = useState("All");
  const [ata, setAta] = useState("All");
  const [status, setStatus] = useState("Open");
  const [selected, setSelected] = useState<Recommendation | null>(null);
  type SortKey = "id" | "priority" | "tail" | "title" | "due" | "basis" | "status";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  function toggleSort(key: SortKey) {
    setSort((s) => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
  }

  const actions = useMemo(() => Array.from(new Set(all.map((r) => r.action))).sort(), [all]);
  const bases = useMemo(() => Array.from(new Set(all.map((r) => r.basis))).sort(), [all]);
  const tails = useMemo(() => Array.from(new Set(all.map((r) => r.tail).filter(Boolean))).sort() as string[], [all]);
  const atas = useMemo(() => Array.from(new Set(all.map((r) => r.ata).filter(Boolean))).sort(), [all]);

  const filtered = useMemo(() => {
    return all
      .filter((r) => priority === "All" || r.priority === priority)
      .filter((r) => action === "All" || r.action === action)
      .filter((r) => basis === "All" || r.basis === basis)
      .filter((r) => tail === "All" || r.tail === tail)
      .filter((r) => ata === "All" || r.ata === ata)
      .filter((r) => status === "All" || effectiveStatus(r, decisions[r.id]) === status)
      .sort((a, b) => {
        if (sort) {
          const dueTime = (r: Recommendation) => (r.due.date ? new Date(r.due.date).getTime() : Infinity);
          const val = (r: Recommendation): string | number => {
            switch (sort.key) {
              case "id": return r.id;
              case "priority": return PRIORITY_ORDER.indexOf(r.priority);
              case "tail": return r.tail ?? "";
              case "title": return r.title;
              case "due": return dueTime(r);
              case "basis": return r.basis;
              case "status": return effectiveStatus(r, decisions[r.id]);
            }
          };
          const av = val(a);
          const bv = val(b);
          if (av < bv) return -1 * sort.dir;
          if (av > bv) return 1 * sort.dir;
          return 0;
        }
        const pd = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
        if (pd !== 0) return pd;
        const ad = a.due.date ? new Date(a.due.date).getTime() : Infinity;
        const bd = b.due.date ? new Date(b.due.date).getTime() : Infinity;
        return ad - bd;
      });
  }, [all, priority, action, basis, tail, ata, status, decisions, sort]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold text-(--ink) page-title">Recommendations</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (confirm("Reset all approve/reject/defer decisions made in this demo session?")) resetDemo();
          }}
        >
          Reset demo state
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 rounded-[8px] border border-(--rule) bg-(--sheet) p-3">
        <FilterSelect label="Priority" value={priority} onChange={setPriority} options={PRIORITY_ORDER} />
        <FilterSelect label="Action" value={action} onChange={setAction} options={actions} />
        <FilterSelect label="Basis" value={basis} onChange={setBasis} options={bases} />
        <FilterSelect label="Aircraft" value={tail} onChange={setTail} options={tails} />
        <FilterSelect label="ATA" value={ata} onChange={setAta} options={atas as string[]} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={["Open", "Approved", "Rejected", "Deferred"]} />
      </div>

      <div className="rounded-[8px] border border-(--rule) bg-(--sheet)">
        <div className="max-h-[65vh] overflow-auto rounded-[8px]">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-(--sheet)">
              <tr className="border-b border-(--rule) text-left text-(--ink-2)">
                <SortHeader label="ID" sortKey="id" sort={sort} onSort={toggleSort} />
                <SortHeader label="Priority" sortKey="priority" sort={sort} onSort={toggleSort} />
                <SortHeader label="Aircraft" sortKey="tail" sort={sort} onSort={toggleSort} />
                <SortHeader label="Title" sortKey="title" sort={sort} onSort={toggleSort} />
                <SortHeader label="Due" sortKey="due" sort={sort} onSort={toggleSort} />
                <SortHeader label="Basis" sortKey="basis" sort={sort} onSort={toggleSort} />
                <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
              </tr>
            </thead>
          <tbody>
            {filtered.map((r) => {
              const st = effectiveStatus(r, decisions[r.id]);
              return (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer border-b border-(--rule) last:border-0 transition-colors hover:bg-(--paper)"
                >
                  <td className="px-3 py-2.5 tabular text-(--ink-2)">{r.id}</td>
                  <td className="px-3 py-2.5">
                    <PriorityTag priority={r.priority} />
                  </td>
                  <td className="px-3 py-2.5">{r.tail ? <TailNumber tail={r.tail} className="text-[12px]" /> : "Fleet"}</td>
                  <td className="max-w-[420px] truncate px-3 py-2.5 text-(--ink)">{r.title}</td>
                  <td className="px-3 py-2.5 tabular text-(--ink-2)">
                    {r.due.date ? formatDate(r.due.date) : r.due.fh_remaining ? `${formatFH(r.due.fh_remaining)} remaining` : "No due"}
                  </td>
                  <td className="px-3 py-2.5 text-(--ink-2)">{r.basis}</td>
                  <td className="px-3 py-2.5 text-(--ink-2)">{st}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-(--ink-2)">
                  No recommendations match these filters.
                </td>
              </tr>
            )}
          </tbody>
          </table>
        </div>
      </div>

      <RecommendationDrawer rec={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: K;
  sort: { key: K; dir: 1 | -1 } | null;
  onSort: (key: K) => void;
}) {
  const active = sort?.key === sortKey;
  const Icon = active ? (sort!.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th className="px-3 py-2.5 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-1 ${active ? "text-(--ink)" : "text-(--ink-2)"} hover:text-(--ink)`}
      >
        {label}
        <Icon className="size-3" strokeWidth={2} />
      </button>
    </th>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "All")}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue placeholder={label}>{value === "All" ? label : value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="All">All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RecommendationDrawer({ rec, onClose }: { rec: Recommendation | null; onClose: () => void }) {
  const role = useUiStore((s) => s.role);
  const decision = useReviewStore((s) => (rec ? s.decisions[rec.id] : undefined));
  const approve = useReviewStore((s) => s.approve);
  const reject = useReviewStore((s) => s.reject);
  const defer = useReviewStore((s) => s.defer);
  const addRemark = useReviewStore((s) => s.addRemark);

  const [reason, setReason] = useState("");
  const [deferDate, setDeferDate] = useState("");
  const [remark, setRemark] = useState("");
  const [mode, setMode] = useState<"none" | "reject" | "defer">("none");

  if (!rec) return null;
  const status = decision?.status ?? rec.status;
  const workOrder = decision?.workOrder ?? rec.work_order;
  const audit = [...rec.audit, ...(decision?.auditAdditions ?? [])];
  const canDecide = role === "Approver" && status === "Open";
  const canRemark = role !== "Viewer";

  function submitReject() {
    if (!reason.trim() || !rec) return;
    reject(rec.id, "You (demo session)", reason.trim());
    setReason("");
    setMode("none");
  }

  function submitDefer() {
    if (!reason.trim() || !deferDate || !rec) return;
    defer(rec.id, "You (demo session)", reason.trim(), deferDate);
    setReason("");
    setDeferDate("");
    setMode("none");
  }

  return (
    <Sheet open={!!rec} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-(--sheet) sm:max-w-md">
        <SheetHeader>
          <div className="mb-1 flex items-center gap-2">
            <PriorityTag priority={rec.priority} />
            <span className="text-[12px] tabular text-(--ink-2)">{rec.id}</span>
          </div>
          <SheetTitle className="text-[15px] leading-snug">{rec.title}</SheetTitle>
          <p className="text-[12px] text-(--ink-2)">
            {rec.action}
            {rec.due.date ? `, due ${formatDate(rec.due.date)}` : ""}
            {rec.due.fh_remaining ? `, ${formatFH(rec.due.fh_remaining)} remaining` : ""}, governing {rec.due.governing}
          </p>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-4">
          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold text-(--ink-2)">Evidence</h3>
            <ul className="flex flex-col gap-2">
              {rec.evidence.map((e, i) => (
                <li key={i} className="rounded-[6px] border border-(--rule) p-2.5">
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-(--ink-3)">
                    {e.type.replace("_", " ")}
                  </span>
                  <p className="text-[12px] text-(--ink)">{e.text}</p>
                </li>
              ))}
              {rec.confidence && (
                <li className="rounded-[6px] border border-(--rule) p-2.5 text-[12px] text-(--ink)">
                  Confidence: {(rec.confidence.probability * 100).toFixed(0)}% (80% interval {rec.confidence.interval[0]} to{" "}
                  {rec.confidence.interval[1]} FH)
                </li>
              )}
            </ul>
          </section>

          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold text-(--ink-2)">Status</h3>
            <p className="text-[13px] text-(--ink)">
              {status}
              {workOrder ? `, work order ${workOrder}` : ""}
            </p>
          </section>

          {canDecide && mode === "none" && (
            <section className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  approve(rec.id, "You (demo session)");
                }}
              >
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
                Reject
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMode("defer")}>
                Defer
              </Button>
            </section>
          )}

          {mode === "reject" && (
            <section className="flex flex-col gap-2 rounded-[6px] border border-(--rule) p-2.5">
              <label className="text-[12px] font-medium text-(--ink)">Reason for rejection (required)</label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={!reason.trim()} onClick={submitReject}>
                  Confirm reject
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
                  Cancel
                </Button>
              </div>
            </section>
          )}

          {mode === "defer" && (
            <section className="flex flex-col gap-2 rounded-[6px] border border-(--rule) p-2.5">
              <label className="text-[12px] font-medium text-(--ink)">Reason for deferral (required)</label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              <label className="text-[12px] font-medium text-(--ink)">Re-review date, within 30 days (required)</label>
              <Input type="date" value={deferDate} onChange={(e) => setDeferDate(e.target.value)} />
              <div className="flex gap-2">
                <Button size="sm" disabled={!reason.trim() || !deferDate} onClick={submitDefer}>
                  Confirm defer
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
                  Cancel
                </Button>
              </div>
            </section>
          )}

          {canRemark && (
            <section className="flex flex-col gap-2 rounded-[6px] border border-(--rule) p-2.5">
              <label className="text-[12px] font-medium text-(--ink)">Add remark</label>
              <div className="flex gap-2">
                <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Add a note for the next reviewer" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!remark.trim()}
                  onClick={() => {
                    addRemark(rec.id, "You (demo session)", remark.trim());
                    setRemark("");
                  }}
                >
                  Add
                </Button>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold text-(--ink-2)">Audit trail</h3>
            <ul className="flex flex-col gap-1.5">
              {audit.map((a, i) => (
                <li key={i} className="text-[12px] text-(--ink-2)">
                  <span className="tabular text-(--ink-3)">{formatDate(a.at)}</span> · {a.by} ({a.role}): {a.action}
                  {a.remarks ? `, ${a.remarks}` : ""}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <SheetFooter />
      </SheetContent>
    </Sheet>
  );
}
