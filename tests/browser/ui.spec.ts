import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidence = resolve("../paypal-ai-hackathon/_runs/2026-10-19-harden/screenshots");
const admin = "browser-fixture-admin-000000000000000000000000";
async function shot(page: Page, name: string) {
  await page.evaluate(() => {
    const label = document.createElement("div");
    label.id = "test-evidence-label";
    label.textContent = "LOCAL WORKER TEST · Synthetic PayPal responses";
    label.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;background:#15263f;color:white;font:10px system-ui;text-align:center;padding:2px;pointer-events:none";
    document.body.appendChild(label);
  });
  await page.screenshot({
    path: resolve(evidence, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => document.getElementById("test-evidence-label")?.remove());
}
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open session and review PayPal approval" }).click();
  await expect(page).toHaveURL(/\/run\//);
  await expect(page.getByText("Awaiting wallet approval", { exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}
async function approve(page: Page, id: string) {
  await page.request.post(`/__test__/session/${id}/approve`);
  await page.getByRole("button", { name: "I've approved: check status" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
}
async function coffee(page: Page) {
  await page.getByRole("button", { name: /Look up coffee demand/ }).click();
  await expect(page.getByRole("cell", { name: "1. market_lookup" })).toBeVisible();
}
async function close(page: Page) {
  await page.getByRole("button", { name: /Finish and settle|Close without usage/ }).click();
  await page.getByRole("button", { name: "Confirm finish", exact: true }).click();
}
async function login(page: Page) {
  await page.goto("/merchant/login");
  await page.getByLabel("Admin access secret").fill(admin);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Merchant overview" })).toBeVisible();
}
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ request, page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on("pageerror", (e) => list.push(e.name));
  page.on("console", (m) => {
    if (/AG Grid.*(?:Enterprise|license|error)/i.test(m.text())) list.push("grid-warning");
  });
  await request.post("/__test__/reset");
});
test("buyer three calls, real consent, replay, finish and private receipt reload", async ({
  page,
}) => {
  await page.goto("/");
  await shot(page, "01-landing-desktop");
  const id = await open(page);
  await shot(page, "02-approval");
  await approve(page, id);
  await coffee(page);
  await page.getByRole("button", { name: /Estimate parcel to Korea/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "03-call-consent");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByText("Call declined · no usage added")).toBeVisible();
  for (const country of ["Korea", "Japan"]) {
    await page.getByRole("button", { name: new RegExp("Estimate parcel to " + country) }).click();
    await page.getByRole("button", { name: "Allow this call" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "Finish and settle USD 0.90" })).toBeVisible();
  await page.getByRole("button", { name: /Replay coffee/ }).click();
  await expect(page.getByText("Replay returned the stored result · +USD 0.00")).toBeVisible();
  await shot(page, "04-workspace-three-calls");
  await close(page);
  await expect(page.getByText("Settled · payment confirmed", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /View session receipt/ }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Captured once" })).toBeVisible();
  await shot(page, "05-receipt-captured");
  const context = await page.context().browser()!.newContext();
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByRole("heading", { name: "Session access needed" })).toBeVisible();
  await shot(other, "06-receipt-unauthorized");
  await context.close();
});
test("zero-use receipt has request reference and no invented void ID", async ({ page }) => {
  const id = await open(page);
  await approve(page, id);
  await close(page);
  await expect(page.getByText("Authorization voided", { exact: true })).toBeVisible();
  await page.goto(`/receipts/${id}`);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Authorization voided; captured USD 0.00" }),
  ).toBeVisible();
  await expect(page.getByText("Void request reference")).toBeVisible();
  await expect(page.getByText("Void transaction ID")).toHaveCount(0);
  await shot(page, "07-receipt-zero");
});
test("unknown capture survives reload and later provider reconciliation confirms same session", async ({
  page,
}) => {
  const id = await open(page);
  await approve(page, id);
  await coffee(page);
  await page.request.post(`/__test__/session/${id}/unknown`);
  await close(page);
  await page.goto(`/receipts/${id}`);
  await page.reload();
  await expect(
    page.getByText("Settlement pending · checking payment", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Captured once" })).toHaveCount(0);
  await expect(
    page.getByText(
      "Settlement is still being checked. No release or final amount is confirmed yet.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Unused amount was not charged. Payment-method hold updates may take time."),
  ).toHaveCount(0);
  await shot(page, "08-receipt-unknown");
  await page.request.post(`/__test__/session/${id}/complete`);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Captured once" })).toBeVisible();
});
test("merchant grids, scoped login, stale projection and current DO detail", async ({ page }) => {
  const id = await open(page);
  await approve(page, id);
  await coffee(page);
  await page.request.post(`/__test__/session/${id}/stale`);
  await login(page);
  await expect(page.getByRole("grid")).toBeVisible();
  await shot(page, "09-merchant-overview");
  await page.goto("/merchant/sessions");
  await page.getByLabel("Search session reference").fill(id.slice(0, 8));
  await expect(page.getByRole("link", { name: /Open session/ })).toHaveCount(1);
  await page.getByRole("link", { name: /Open session/ }).click();
  await expect(page.getByText(/Dashboard updating. Projection version 0/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Recheck provider status" })).toBeVisible();
  await shot(page, "10-merchant-stale-detail");
  await page.getByRole("button", { name: "Recheck provider status" }).click();
  await page.goto("/run/" + id);
  await close(page);
  await page.goto("/merchant/charges");
  await expect(page.getByRole("heading", { name: "Charges", exact: true })).toBeVisible();
  await shot(page, "11-merchant-charges");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/merchant\/login/);
  await login(page);
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(page.getByText("Gross captured", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Merchant sign in" })).toBeVisible();
});
test("390px mobile, keyboard consent focus, merchant sheet and 200% layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await open(page);
  await approve(page, id);
  await coffee(page);
  const b = page.getByRole("button", { name: /Estimate parcel to Korea/ });
  await b.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "12-call-consent-mobile");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(b).toBeFocused();
  await shot(page, "12-workspace-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await login(page);
  await expect(page.getByRole("link", { name: "Tollbooth home" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "13-merchant-mobile-menu");
  await page.keyboard.press("Escape");
  await shot(page, "14-merchant-mobile-grid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.body.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "15-merchant-200pct");
});
test("all nonterminal state variants and reserved row render without a paid receipt", async ({
  page,
}) => {
  test.setTimeout(90000);
  const id = await open(page);
  await approve(page, id);
  for (const state of [
    "CREATED",
    "AUTHORIZING",
    "CLOSING",
    "SETTLING",
    "RECONCILING",
    "MANUAL_REVIEW",
    "RESERVED",
    "EXPIRED",
  ]) {
    await page.request.post(`/__test__/session/${id}/state?value=${state}`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
    await expect(page.getByText("Settled · payment confirmed", { exact: true })).toHaveCount(0);
    if (state === "RESERVED")
      await expect(page.getByRole("cell", { name: "Reserved · in progress" })).toBeVisible();
    await shot(page, "state-" + state.toLowerCase());
  }
});
test("offline retains stale values, loading and safe recovery are visible", async ({ page }) => {
  const id = await open(page);
  await approve(page, id);
  await coffee(page);
  await page.route("**/api/sessions/*", (route) => route.abort());
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText(/Connection unavailable/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "1. market_lookup" })).toBeVisible();
  await shot(page, "16-offline-stale");
  await page.unroute("**/api/sessions/*");
  await page.getByRole("button", { name: "Refresh status", exact: true }).first().click();
  await expect(page.getByText(/Connection unavailable/)).toHaveCount(0);
});
test("policy denies before open, connect credential stays hidden, public demo is isolated", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByText("Edit or import policy before opening").click();
  await page.getByLabel("Policy JSON").fill(
    JSON.stringify({
      perCallCapCents: 10,
      sessionCapCents: 500,
      humanApprovalAboveCents: 30,
      allowedMerchants: ["tollbooth.demo"],
    }),
  );
  await page.getByRole("button", { name: "Open session and review PayPal approval" }).click();
  await expect(page.getByText(/Blocked by your per-call cap/)).toBeVisible();
  await shot(page, "17-policy-denied");
  await page.goto("/connect");
  await page.getByRole("button", { name: "Issue access" }).click();
  await expect(page.getByText(/Credential hidden/)).toBeVisible();
  await shot(page, "18-connect-hidden");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: "Test catalog connection" }).click();
  await expect(page.getByText(/2 tools discovered/)).toBeVisible();
  await page.goto("/demo/merchant");
  await expect(page.getByRole("grid")).toBeVisible();
  await shot(page, "19-simulated-merchant");
  await page.goto("/run/rehearsal");
  await expect(page.getByText(/Simulated · no AI or payment/)).toBeVisible();
  await shot(page, "20-simulated-rehearsal");
});

test("loading, login errors, empty results and keyboard grid pagination", async ({ page }) => {
  await page.goto("/merchant/login");
  await shot(page, "21-merchant-login");
  await page.getByLabel("Admin access secret").fill("incorrect-fixture");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await shot(page, "22-login-denied");
  await page.request.post("/__test__/reset");
  await page.request.post("/__test__/pages");
  await login(page);
  await expect(page.getByText("Page 1 · 100 records (up to 100)")).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Page 2 · 3 records (up to 100)")).toBeVisible();
  await page.getByRole("gridcell").first().focus();
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("gridcell");
  await shot(page, "23-grid-pagination-keyboard");
  await page.getByLabel("Search session reference").fill("zzzz");
  await expect(page.getByText(/No matching records/)).toBeVisible();
  await shot(page, "24-grid-empty");
  await page.request.post("/__test__/reset");
  const id = await open(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/sessions/" + id, async (route) => {
    await gate;
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading authoritative state…")).toBeVisible();
  await shot(page, "25-workspace-loading");
  release();
  await expect(page.getByText("Awaiting wallet approval", { exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test("polling pauses in hidden tabs and stops after terminal settlement", async ({ page }) => {
  await page.clock.install();
  const id = await open(page);
  await approve(page, id);
  let reads = 0;
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/api/sessions/" + id) reads++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = reads;
  await page.clock.runFor(60000);
  expect(reads).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => reads).toBeGreaterThan(before);
  await close(page);
  await expect(page.getByText("Authorization voided", { exact: true })).toBeVisible();
  const terminal = reads;
  await page.clock.runFor(60000);
  expect(reads).toBe(terminal);
});
test("registry controls: sidebar collapse, keyboard select, tooltip, dropdown and vector branding", async ({
  page,
}) => {
  await page.goto("/demo/merchant");
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Tollbooth home" }).locator("img")).toBeVisible();
  await expect(page.locator("footer,.eyebrow,.brand-icon")).toHaveCount(0);
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect(page.locator('[data-collapsible="icon"]')).toBeVisible();
  await shot(page, "26-sidebar-collapsed");
  await page.getByLabel("Date range").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Last 30 days" }).click();
  await expect(page.getByLabel("Date range")).toContainText("Last 30 days");
  await page.getByRole("button", { name: /^Grid scope/ }).hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("this page");
  await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
  await page.getByRole("button", { name: "More navigation" }).click();
  await page.getByRole("menuitem", { name: "Judge guide" }).click();
  await expect(page.getByRole("heading", { name: "Judge guide" })).toBeVisible();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await expect(page.getByText("Simulated · no AI or payment", { exact: true })).toBeVisible();
  const favicon = await page.request.get("/favicon.svg");
  expect(favicon.status()).toBe(200);
  expect(await favicon.text()).toContain('fill-rule="evenodd"');
});

test("rate limited session creation shows a concise alert and keeps retry action", async ({
  page,
}) => {
  await page.goto("/");
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      status: 429,
      headers: { "Retry-After": "60" },
      contentType: "application/json",
      body: JSON.stringify({ code: "RATE_LIMITED", status: 429 }),
    }),
  );
  await page.getByRole("button", { name: "Open session and review PayPal approval" }).click();
  await expect(page.getByRole("alert")).toContainText("Too many attempts");
  await expect(
    page.getByRole("button", { name: "Open session and review PayPal approval" }),
  ).toBeEnabled();
  await shot(page, "27-rate-limit");
});
