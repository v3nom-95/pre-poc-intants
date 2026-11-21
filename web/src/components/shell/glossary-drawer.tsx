"use client";

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GLOSSARY } from "@/lib/domain-types";

export function GlossaryDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open glossary"
        className="size-8 text-(--ink-2) hover:text-(--ink)"
        onClick={() => setOpen(true)}
      >
        <HelpCircle className="size-[17px]" strokeWidth={1.75} />
      </Button>
      <SheetContent side="right" className="w-full sm:max-w-md bg-(--sheet) border-(--rule)">
        <SheetHeader>
          <SheetTitle className="text-(--ink)">Glossary</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100%-4rem)] px-4">
          <dl className="divide-y divide-(--rule)">
            {GLOSSARY.map(({ term, meaning }) => (
              <div key={term} className="py-3">
                <dt className="text-[13px] font-semibold text-(--ink)">{term}</dt>
                <dd className="mt-1 text-[13px] leading-[1.5] text-(--ink-2)">{meaning}</dd>
              </div>
            ))}
          </dl>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
