"use client";

// Conversation state shared by the /assistant page and the top-bar sheet.
// The corpus is fetched from the app's own static files the first time a
// question is asked (never on initial page load). Nothing leaves the browser.
import { create } from "zustand";
import { Assistant } from "@/lib/assistant/engine";
import type { Answer, Corpus, SortieFile } from "@/lib/assistant/types";

export type ChatMessage =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; answer: Answer }
  | { id: number; role: "error"; text: string };

interface AssistantState {
  messages: ChatMessage[];
  busy: boolean;
  ask: (question: string) => Promise<void>;
  clear: () => void;
}

let assistantPromise: Promise<Assistant> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return (await res.json()) as T;
}

export function loadAssistant(): Promise<Assistant> {
  if (!assistantPromise) {
    assistantPromise = fetchJson<Corpus>("/data/knowledge/corpus.json")
      .then((corpus) => new Assistant(corpus, (tail) => fetchJson<SortieFile>(`/data/knowledge/sorties/${tail}.json`)))
      .catch((err) => {
        assistantPromise = null;
        throw err;
      });
  }
  return assistantPromise;
}

let seq = 0;

export const useAssistantStore = create<AssistantState>()((set, get) => ({
  messages: [],
  busy: false,
  ask: async (question) => {
    const q = question.trim();
    if (!q || get().busy) return;
    set((s) => ({ busy: true, messages: [...s.messages, { id: ++seq, role: "user", text: q }] }));
    try {
      const assistant = await loadAssistant();
      const answer = await assistant.ask(q);
      set((s) => ({ messages: [...s.messages, { id: ++seq, role: "assistant", answer }] }));
    } catch (err) {
      const text = err instanceof Error ? err.message : "The records could not be loaded.";
      set((s) => ({ messages: [...s.messages, { id: ++seq, role: "error", text }] }));
    } finally {
      set({ busy: false });
    }
  },
  clear: () => {
    set({ messages: [] });
    assistantPromise?.then((a) => a.reset()).catch(() => undefined);
  },
}));
