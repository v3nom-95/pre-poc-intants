"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";

const ROUTES = [
  { label: "Fleet overview", href: "/" },
  { label: "Recommendations", href: "/recommendations" },
  { label: "Action plan", href: "/plan" },
  { label: "Reliability", href: "/reliability" },
  { label: "Planning", href: "/planning" },
  { label: "Models and validation", href: "/models" },
  { label: "Data and integration", href: "/data" },
  { label: "Reports", href: "/reports" },
  { label: "Ask PRE (query assistant)", href: "/assistant" },
];

interface SearchEntry {
  type: "Aircraft" | "Component" | "Recommendation";
  id: string;
  label: string;
  href: string;
}

interface TypeEntry {
  key: string;
  name: string;
  tails: string[];
}

const TAIL_RE = /\b([A-Z]{2}-\d{3})\b/;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
  const [tailType, setTailType] = useState<Record<string, string>>({});
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open && index === null) {
      fetch("/data/search-index.json")
        .then((r) => r.json())
        .then(setIndex)
        .catch(() => setIndex([]));
      fetch("/data/types.json")
        .then((r) => r.json())
        .then((types: TypeEntry[]) => {
          const map: Record<string, string> = {};
          for (const t of types) for (const tail of t.tails) map[tail] = t.name;
          setTailType(map);
        })
        .catch(() => setTailType({}));
    }
  }, [open, index]);

  const byType = (t: SearchEntry["type"]) => (index ?? []).filter((e) => e.type === t);
  /** Aircraft type of an entry, from the tail it names (aircraft id or a tail in its label). */
  const typeOf = (e: SearchEntry) => {
    const tail = e.type === "Aircraft" ? e.id : TAIL_RE.exec(e.label)?.[1];
    return tail ? tailType[tail] : undefined;
  };
  const item = (e: SearchEntry, key: string) => {
    const typeName = typeOf(e);
    // The aircraft label already names its type; do not repeat it.
    const showType = typeName && e.type !== "Aircraft";
    return (
      <CommandItem
        key={key}
        value={`${e.id} ${e.label} ${typeName ?? ""}`}
        onSelect={() => {
          setOpen(false);
          router.push(e.href);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{e.label}</span>
        {showType && <span className="shrink-0 text-[11px] text-(--ink-2)">{typeName}</span>}
      </CommandItem>
    );
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-8 w-[220px] justify-between border-(--rule) bg-(--sheet) px-2.5 text-[12px] font-normal text-(--ink-2) hover:text-(--ink)"
      >
        <span className="flex items-center gap-2">
          <Search className="size-[14px]" strokeWidth={1.75} />
          Search tails, serials, recs
        </span>
        <kbd className="rounded border border-(--rule) px-1 text-[10px] text-(--ink-3)">
          &#8984;K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search tails, types, serials, part numbers, recommendation IDs" />
        <CommandList>
          <CommandEmpty>{index === null ? "Loading…" : "No results."}</CommandEmpty>
          <CommandGroup heading="Go to">
            {ROUTES.map((r) => (
              <CommandItem
                key={r.href}
                value={r.label}
                onSelect={() => {
                  setOpen(false);
                  router.push(r.href);
                }}
              >
                {r.label}
              </CommandItem>
            ))}
          </CommandGroup>
          {index && byType("Aircraft").length > 0 && (
            <CommandGroup heading="Aircraft">
              {byType("Aircraft").map((e) => item(e, e.href))}
            </CommandGroup>
          )}
          {index && byType("Recommendation").length > 0 && (
            <CommandGroup heading="Recommendations">
              {byType("Recommendation").map((e) => item(e, e.id))}
            </CommandGroup>
          )}
          {index && byType("Component").length > 0 && (
            <CommandGroup heading="Components">
              {byType("Component").map((e) => item(e, e.href))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
