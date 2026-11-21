"use client";

import { useEffect } from "react";
import { useUiStore } from "@/lib/ui-store";

export function ThemeSync() {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return null;
}
