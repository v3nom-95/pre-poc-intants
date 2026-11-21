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
  { label: "Reliability", href: "/reliability" },
  { label: "Planning", href: "/planning" },
  { label: "Models and validation", href: "/models" },
  { label: "Data and integration", href: "/data" },
  { label: "Reports", href: "/reports" },
];

interface SearchEntry {
  type: "Aircraft" | "Component" | "Recommendation";
  id: string;
  label: string;
  href: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
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
    }
  }, [open, index]);

  const byType = (t: SearchEntry["type"]) => (index ?? []).filter((e) => e.type === t);

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
        <CommandInput placeholder="Search tails, serials, part numbers, recommendation IDs" />
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
              {byType("Aircraft").map((e) => (
                <CommandItem key={e.href} value={`${e.id} ${e.label}`} onSelect={() => { setOpen(false); router.push(e.href); }}>
                  {e.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {index && byType("Recommendation").length > 0 && (
            <CommandGroup heading="Recommendations">
              {byType("Recommendation").map((e) => (
                <CommandItem key={e.id} value={`${e.id} ${e.label}`} onSelect={() => { setOpen(false); router.push(e.href); }}>
                  {e.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {index && byType("Component").length > 0 && (
            <CommandGroup heading="Components">
              {byType("Component").map((e) => (
                <CommandItem key={e.href} value={`${e.id} ${e.label}`} onSelect={() => { setOpen(false); router.push(e.href); }}>
                  {e.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
