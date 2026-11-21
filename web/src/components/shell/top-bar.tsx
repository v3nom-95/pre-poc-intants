import { CommandPalette } from "@/components/shell/command-palette";
import { RoleSwitcher } from "@/components/shell/role-switcher";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { GlossaryDrawer } from "@/components/shell/glossary-drawer";
import { Greeting } from "@/components/shell/greeting";
import { Separator } from "@/components/ui/separator";

export function TopBar({ asOfLabel }: { asOfLabel: string }) {
  return (
    <header className="flex h-14 flex-none items-center gap-4 border-b border-(--rule) bg-(--sheet) px-5">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold text-(--ink)">
          Predictive Recommendation Engine
        </span>
        <span className="text-[12px] font-medium text-(--ink-3)">PRE</span>
      </div>
      <span className="rounded-[3px] border border-(--rule) bg-(--paper) px-2 py-[3px] text-[11px] font-medium text-(--ink-2)">
        Data as of {asOfLabel}
      </span>
      <div className="flex-1" />
      <Greeting />
      <Separator orientation="vertical" className="h-5" />
      <CommandPalette />
      <Separator orientation="vertical" className="h-5" />
      <RoleSwitcher />
      <ThemeToggle />
      <GlossaryDrawer />
    </header>
  );
}
