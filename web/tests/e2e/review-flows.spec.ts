import { test, expect } from "@playwright/test";
import { useRole, queueRows } from "./helpers";

// SPEC 6 and 8.4: approve creates a work order, reject needs a reason, defer
// needs a reason and a review date within 30 days, roles restrict actions,
// the audit trail is append-only and "Reset demo state" clears decisions.

const AS_OF = "2026-11-15";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A drawer section located by its exact heading. */
function section(drawer: import("@playwright/test").Locator, heading: string) {
  return drawer.locator("section").filter({ has: drawer.page().getByRole("heading", { name: heading, exact: true }) });
}

async function openFirstRecommendation(page: import("@playwright/test").Page) {
  await page.goto("/recommendations");
  const row = queueRows(page).first();
  await expect(row).toBeVisible();
  const label = (await row.getAttribute("aria-label")) ?? "";
  const recId = label.split(":")[0];
  await row.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(recId);
  return { drawer, recId };
}

test.describe("recommendation review", () => {
  test("approve raises a work order and appends to the audit trail", async ({ page }) => {
    await useRole(page, "Approver");
    const { drawer, recId } = await openFirstRecommendation(page);
    const auditBefore = await section(drawer, "Audit trail").locator("li").count();

    await drawer.getByRole("button", { name: "Approve" }).click();

    await expect(drawer).toContainText(/Approved, work order WO-2026-\d{4}/);
    const audit = section(drawer, "Audit trail").locator("li");
    await expect(audit).toHaveCount(auditBefore + 1);
    await expect(audit.last()).toContainText("Approved");
    // Stamped with the fixed as-of date, never the system clock.
    await expect(audit.last()).toContainText("15 Nov 2026");
    await expect(drawer.getByRole("button", { name: "Approve" })).toHaveCount(0);

    // Decision persists in local storage across a reload.
    await page.reload();
    const stored = await page.evaluate(() => localStorage.getItem("pre-review-state"));
    expect(stored).toContain(recId);
    expect(stored).toContain('"Approved"');
  });

  test("reject requires a reason", async ({ page }) => {
    await useRole(page, "Approver");
    const { drawer } = await openFirstRecommendation(page);

    await drawer.getByRole("button", { name: "Reject" }).click();
    const confirm = drawer.getByRole("button", { name: "Confirm reject" });
    await expect(confirm).toBeDisabled();
    await drawer.getByLabel("Reason for rejection (required)").fill("   ");
    await expect(confirm).toBeDisabled();
    await drawer.getByLabel("Reason for rejection (required)").fill("Inspected at phase, no findings");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(section(drawer, "Status")).toContainText("Rejected");
    await expect(drawer).toContainText("Inspected at phase, no findings");
  });

  test("defer requires a reason and a review date within 30 days", async ({ page }) => {
    await useRole(page, "Approver");
    const { drawer } = await openFirstRecommendation(page);

    await drawer.getByRole("button", { name: "Defer" }).click();
    const confirm = drawer.getByRole("button", { name: "Confirm defer" });
    const date = drawer.getByLabel(/Re-review date/);

    await drawer.getByLabel("Reason for deferral (required)").fill("Awaiting spares");
    await expect(confirm).toBeDisabled();

    await date.fill(addDays(AS_OF, 45));
    await expect(confirm).toBeDisabled();
    await expect(date).toHaveAttribute("aria-invalid", "true");

    await date.fill(AS_OF);
    await expect(confirm).toBeDisabled();

    const valid = addDays(AS_OF, 10);
    await date.fill(valid);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(section(drawer, "Status")).toContainText("Deferred");
    await expect(drawer).toContainText(`Re-review by ${valid}`);
  });
});

test.describe("role restrictions", () => {
  test("viewer can read but not act or remark", async ({ page }) => {
    await useRole(page, "Viewer");
    const { drawer } = await openFirstRecommendation(page);
    await expect(drawer.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Reject" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Defer" })).toHaveCount(0);
    await expect(drawer.getByLabel("Add remark")).toHaveCount(0);
  });

  test("engineer can add remarks but not decide", async ({ page }) => {
    await useRole(page, "Engineer");
    const { drawer } = await openFirstRecommendation(page);
    await expect(drawer.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Reject" })).toHaveCount(0);

    await drawer.getByLabel("Add remark").fill("Spares confirmed in the pool");
    await drawer.getByRole("button", { name: "Add" }).click();
    const audit = section(drawer, "Audit trail").locator("li");
    await expect(audit.last()).toContainText("Remark");
    await expect(audit.last()).toContainText("Spares confirmed in the pool");
  });

  test("switching role in the top bar unlocks approval", async ({ page }) => {
    await useRole(page, "Viewer");
    await page.goto("/recommendations");
    await page.locator("header").getByRole("combobox").click();
    await page.getByRole("option", { name: "Approver" }).click();
    await queueRows(page).first().click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Approve" })).toBeVisible();
  });
});

test("reset demo state clears decisions", async ({ page }) => {
  await useRole(page, "Approver");
  await page.goto("/recommendations");
  const rows = queueRows(page);
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();

  await rows.first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(rows).toHaveCount(before - 1);

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reset demo state" }).click();
  await expect(rows).toHaveCount(before);
  const stored = await page.evaluate(() => localStorage.getItem("pre-review-state"));
  expect(stored).not.toContain('"Approved"');
});

test("queue rows open from the keyboard", async ({ page }) => {
  await useRole(page, "Engineer");
  await page.goto("/recommendations");
  const row = queueRows(page).first();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
});
