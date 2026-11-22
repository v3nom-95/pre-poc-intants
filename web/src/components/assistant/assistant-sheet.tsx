"use client";

import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AssistantChat } from "./assistant-chat";

export function AssistantSheet() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        aria-label="Ask PRE"
        title="Ask PRE"
        onClick={() => setOpen(true)}
        className="h-8 gap-1.5 border-(--rule) bg-(--sheet) px-2 text-[12px] font-normal text-(--ink-2) hover:text-(--ink)"
      >
        <MessagesSquare className="size-[15px]" strokeWidth={1.75} aria-hidden />
        <span className="hidden min-[1440px]:inline">Ask PRE</span>
      </Button>
      <SheetContent side="right" className="w-full gap-0 border-(--rule) bg-(--sheet) p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-(--rule) px-4 py-3">
          <SheetTitle className="text-(--ink)">Ask PRE</SheetTitle>
          <SheetDescription className="text-[12px] text-(--ink-2)">
            Offline query assistant over this fleet&apos;s records. No network, no language model.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">
          <AssistantChat variant="sheet" onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
