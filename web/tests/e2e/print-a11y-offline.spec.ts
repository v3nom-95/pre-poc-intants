import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mainRoutes, oneTailPerType } from "./helpers";

// SPEC 8.9 print view, SPEC 10 axe checks and SPEC 0 rule 4 / 14.5 item 4:
// the built site makes no request to any non-local host.

test.describe("print view", () => {
  test("fleet report prints without the app shell", async ({ page }) => {
    await page.goto("/reports");
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("heading", { name: "Fleet report" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
  });

  for (const tail of oneTailPerType()) {
    test(`aircraft report for ${tail} prints its key sections`, async ({ page }) => {
      await page.goto(`/aircraft/${tail}/report`);
      await page.emulateMedia({ media: "print" });
      const report = page.getByRole("article", { name: `Aircraft report for ${tail}` });
      await expect(report).toBeVisible();
      for (const heading of ["Summary", "Components: life and risk", "Open recommendations", "Action plan", "Recent snags", "Recent maintenance"]) {
        await expect(report.getByRole("heading", { name: heading })).toBeVisible();
      }
      await expect(report.getByRole("heading", { name: /^Utilisation, last/ })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
    });
  }

  test("aircraft page links to its report", async ({ page }) => {
    const tail = oneTailPerType()[0];
    await page.goto(`/aircraft/${tail}`);
    await page.getByRole("link", { name: "Print report" }).click();
    await expect(page).toHaveURL(new RegExp(`/aircraft/${tail}/report/?$`));
  });
});

for (const route of mainRoutes()) {
  test(`axe: no serious or critical violations on ${route}`, async ({ page }) => {
    // A full axe scan of the largest pages (action plan, models) can pass 30 s
    // on a loaded machine; allow more time so the result reflects violations,
    // not machine load.
    test.setTimeout(90_000);
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const blocking = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(" ")}`);
    expect(blocking, blocking.join("\n")).toEqual([]);
  });

  test(`offline: no request leaves localhost on ${route}`, async ({ page }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") external.push(req.url());
    });
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    expect(external).toEqual([]);
  });
}
