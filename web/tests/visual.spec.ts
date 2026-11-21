import { test, expect } from "@playwright/test";

const VIEWPORTS = [
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const ROUTES = ["/dev/chart-kit", "/", "/recommendations"];

for (const route of ROUTES) {
  for (const theme of ["light", "dark"] as const) {
    for (const vp of VIEWPORTS) {
      test(`${route} ${theme} ${vp.name}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(String(err)));

        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (theme === "dark") {
          await page.addInitScript(() => {
            localStorage.setItem(
              "pre-ui-state",
              JSON.stringify({ state: { theme: "dark", role: "Engineer" }, version: 0 })
            );
          });
        }
        await page.goto(route);
        await page.waitForTimeout(1100);

        const safeName = route.replace(/\//g, "_") || "root";
        await page.screenshot({
          path: `tests/screenshots/${safeName}__${theme}__${vp.name}.png`,
          fullPage: true,
        });

        expect(errors, `console errors on ${route} ${theme} ${vp.name}: ${errors.join("; ")}`).toEqual([]);
      });
    }
  }
}
