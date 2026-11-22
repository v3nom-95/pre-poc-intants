import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

export type Role = "Viewer" | "Engineer" | "Approver";

const DATA_DIR = path.join(process.cwd(), "public", "data");

/** Start the page with a simulated role (and theme) already chosen. */
export async function useRole(page: Page, role: Role, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ([r, t]) => {
      localStorage.setItem("pre-ui-state", JSON.stringify({ state: { theme: t, role: r }, version: 0 }));
    },
    [role, theme] as const
  );
}

/** Tails in the exported fleet, so tests never hardcode the fleet size. */
export function fleetTails(): string[] {
  const fleet = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "fleet.json"), "utf-8")) as { aircraft: { tail: string }[] };
  return fleet.aircraft.map((a) => a.tail);
}

/** First tail of each tail prefix (FX, TX, CX ...) present in the export. */
export function oneTailPerType(): string[] {
  const seen = new Map<string, string>();
  for (const t of fleetTails()) {
    const prefix = t.split("-")[0];
    if (!seen.has(prefix)) seen.set(prefix, t);
  }
  return [...seen.values()];
}

export function firstComponentSerial(): string {
  const files = fs.readdirSync(path.join(DATA_DIR, "components")).filter((f) => f.endsWith(".json")).sort();
  return files[0].replace(".json", "");
}

/** Main routes covered by the accessibility and offline checks. */
export function mainRoutes(): string[] {
  const tails = oneTailPerType();
  return [
    "/",
    "/recommendations",
    "/plan",
    "/reliability",
    "/planning",
    "/models",
    "/data",
    "/reports",
    "/assistant",
    ...tails.map((t) => `/aircraft/${t}`),
    `/aircraft/${tails[0]}/report`,
    `/components/${firstComponentSerial()}`,
  ];
}

/** Open recommendation rows in the queue table (rows are keyboard focusable). */
export function queueRows(page: Page) {
  return page.locator('tbody tr[tabindex="0"]');
}
