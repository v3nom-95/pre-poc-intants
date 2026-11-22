const { chromium } = require("playwright");

const routes = ["/", "/aircraft/FX-307", "/aircraft/FX-309", "/aircraft/TX-404", "/aircraft/CX-502", "/aircraft/CX-502/report", "/components/HP-0001", "/recommendations", "/plan", "/reliability", "/planning", "/models", "/data", "/reports", "/assistant"];

(async () => {
  const browser = await chromium.launch();
  let anyError = false;
  for (const route of routes) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto(`http://localhost:4173${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    if (errors.length) {
      anyError = true;
      console.log(`[${route}] ${errors.length} error(s):`);
      errors.forEach((e) => console.log("  " + e));
    } else {
      console.log(`[${route}] OK`);
    }
    await page.close();
  }
  await browser.close();
  process.exit(anyError ? 1 : 0);
})();
