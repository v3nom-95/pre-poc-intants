"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/lib/ui-store";

export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      onClick={toggleTheme}
      className="size-8 text-(--ink-2) hover:text-(--ink)"
    >
      {theme === "light" ? (
        <Moon className="size-[17px]" strokeWidth={1.75} />
      ) : (
        <Sun className="size-[17px]" strokeWidth={1.75} />
      )}
    </Button>
  );
}
