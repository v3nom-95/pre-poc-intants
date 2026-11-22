// Dark theme ("hangar night") gets the same accessibility bar as light (SPEC 7, 10):
// no serious or critical axe violations on every main screen.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ROUTES = ["/", "/recommendations", "/plan", "/reliability", "/planning", "/models", "/data", "/reports", "/assistant",
  "/aircraft/FX-307", "/aircraft/TX-404", "/aircraft/CX-502", "/aircraft/CX-502/report", "/components/HP-0001"];

for (const route of ROUTES) {
  test(`dark axe ${route}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() =>
      localStorage.setItem("pre-ui-state", JSON.stringify({ state: { theme: "dark", role: "Engineer" }, version: 0 }))
    );
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const isDark = await page.evaluate(
      () => document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark"
    );
    expect(isDark, "dark theme applied").toBe(true);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = r.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target.join(" ")} | ${v.nodes[0]?.any?.[0]?.message ?? ""}`);
    expect(bad, bad.join("\n")).toEqual([]);
  });
}
