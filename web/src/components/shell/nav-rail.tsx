"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  ClipboardList,
  Activity,
  SlidersHorizontal,
  FlaskConical,
  Database,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Fleet overview", Icon: LayoutGrid },
  { href: "/recommendations", label: "Recommendations", Icon: ClipboardList },
  { href: "/reliability", label: "Reliability", Icon: Activity },
  { href: "/planning", label: "Planning", Icon: SlidersHorizontal },
  { href: "/models", label: "Models", Icon: FlaskConical },
  { href: "/data", label: "Data", Icon: Database },
  { href: "/reports", label: "Reports", Icon: FileText },
] as const;

export function NavRail() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="hidden h-full w-[88px] flex-none flex-col items-stretch gap-1 border-r border-(--rule) bg-(--sheet) py-3 md:flex"
    >
      {ITEMS.map(({ href, label, Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname?.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-col items-center gap-1 rounded-md mx-1.5 px-1 py-2.5 text-[10.5px] leading-tight text-center break-words transition-colors",
              active
                ? "bg-(--accent)/10 text-(--accent)"
                : "text-(--ink-2) hover:bg-(--paper) hover:text-(--ink)"
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="w-full min-w-0 break-words">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
