const { chromium } = require("playwright");

async function shot(url, outPath, opts = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: opts.viewport || { width: 1440, height: 900 } });
  if (opts.dark) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      localStorage.setItem("pre-ui-state", JSON.stringify({ state: { theme: "dark", role: "Engineer" }, version: 0 }));
    });
  }
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: outPath, fullPage: !!opts.fullPage });
  await browser.close();
}

(async () => {
  const base = "http://localhost:4173";
  const pages = process.argv.slice(2);
  for (const spec of pages) {
    const [route, outName, flags] = spec.split("|");
    await shot(`${base}${route}`, `/tmp/shots/${outName}`, {
      fullPage: flags?.includes("full"),
      dark: flags?.includes("dark"),
    });
    console.log(`shot: ${route} -> ${outName}`);
  }
})();
