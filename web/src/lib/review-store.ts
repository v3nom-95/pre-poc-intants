import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RecStatus } from "./domain-types";

export interface AuditEntry {
  at: string;
  by: string;
  role: string;
  action: string;
  remarks: string;
}

export interface Decision {
  status: RecStatus;
  workOrder: string | null;
  auditAdditions: AuditEntry[];
}

interface ReviewState {
  decisions: Record<string, Decision>;
  workOrderSeq: number;
  approve: (recId: string, by: string) => string;
  reject: (recId: string, by: string, reason: string) => void;
  defer: (recId: string, by: string, reason: string, reviewDate: string) => void;
  addRemark: (recId: string, by: string, remark: string) => void;
  reset: () => void;
}

function nowIso() {
  return new Date().toISOString().slice(0, 10);
}

export const useReviewStore = create<ReviewState>()(
  persist(
    (set, get) => ({
      decisions: {},
      workOrderSeq: 1,

      approve: (recId, by) => {
        const wo = `WO-2026-${String(get().workOrderSeq).padStart(4, "0")}`;
        set((s) => ({
          workOrderSeq: s.workOrderSeq + 1,
          decisions: {
            ...s.decisions,
            [recId]: {
              status: "Approved",
              workOrder: wo,
              auditAdditions: [
                ...(s.decisions[recId]?.auditAdditions ?? []),
                { at: nowIso(), by, role: "approver", action: "Approved", remarks: `Work order ${wo} raised` },
              ],
            },
          },
        }));
        return wo;
      },

      reject: (recId, by, reason) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            [recId]: {
              status: "Rejected",
              workOrder: s.decisions[recId]?.workOrder ?? null,
              auditAdditions: [
                ...(s.decisions[recId]?.auditAdditions ?? []),
                { at: nowIso(), by, role: "approver", action: "Rejected", remarks: reason },
              ],
            },
          },
        })),

      defer: (recId, by, reason, reviewDate) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            [recId]: {
              status: "Deferred",
              workOrder: s.decisions[recId]?.workOrder ?? null,
              auditAdditions: [
                ...(s.decisions[recId]?.auditAdditions ?? []),
                { at: nowIso(), by, role: "approver", action: "Deferred", remarks: `${reason}. Re-review by ${reviewDate}` },
              ],
            },
          },
        })),

      addRemark: (recId, by, remark) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            [recId]: {
              status: s.decisions[recId]?.status ?? ("Open" as RecStatus),
              workOrder: s.decisions[recId]?.workOrder ?? null,
              auditAdditions: [
                ...(s.decisions[recId]?.auditAdditions ?? []),
                { at: nowIso(), by, role: "engineer", action: "Remark", remarks: remark },
              ],
            },
          },
        })),

      reset: () => set({ decisions: {}, workOrderSeq: 1 }),
    }),
    { name: "pre-review-state" }
  )
);
