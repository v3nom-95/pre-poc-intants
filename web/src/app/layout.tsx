import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeSync } from "@/components/shell/theme-sync";
import { THEME_INIT_SCRIPT } from "@/lib/ui-store";
import "./globals.css";

export const metadata: Metadata = {
  title: "PRE (Predictive Recommendation Engine)",
  description: "Proof of concept. All aircraft, data and figures are fictional.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ThemeSync />
        <TooltipProvider delay={200}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
