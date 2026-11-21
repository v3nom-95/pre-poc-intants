import { NavRail } from "@/components/shell/nav-rail";
import { TopBar } from "@/components/shell/top-bar";

export function AppShell({
  children,
  asOfLabel = "15 Nov 2026",
}: {
  children: React.ReactNode;
  asOfLabel?: string;
}) {
  return (
    <div className="flex min-h-screen w-full flex-col">
      <div className="sticky top-0 z-20">
        <TopBar asOfLabel={asOfLabel} />
      </div>
      <div className="flex flex-1">
        <div className="sticky top-14 h-[calc(100vh-56px)] flex-none">
          <NavRail />
        </div>
        <div className="flex flex-1 flex-col">
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
          <footer className="border-t border-(--rule) px-6 py-3 text-center text-[11px] text-(--ink-3)">
            Proof of concept. All aircraft, data and figures are fictional.
          </footer>
        </div>
      </div>
    </div>
  );
}
