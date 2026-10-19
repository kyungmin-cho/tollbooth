// Public deployed UI only. No credentials, provider calls, orders or AI inference.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const dir = resolve(process.argv[2]);
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: join(dir, "raw"), size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
const scenes = [];
const start = Date.now();
await page.route("**/*", (route) => {
  const r = route.request(),
    u = new URL(r.url());
  if (
    u.hostname.endsWith("paypal.com") ||
    (r.method() !== "GET" && !(u.pathname === "/api/visitor" && r.method() === "POST"))
  )
    return route.abort();
  return route.continue();
});
async function scene(title, caption, action, seconds = 7) {
  const at = (Date.now() - start) / 1000;
  await action();
  scenes.push({ at, title, caption });
  await page.screenshot({ path: join(dir, `scene-${scenes.length}.png`) });
  await page.waitForTimeout(seconds * 1000);
}
const origin = "https://tollbooth.arcsolve.workers.dev";
await scene(
  "Tollbooth",
  "Human-approved budgets for paid AI tools. Public simulated demonstration.",
  () => page.goto(origin + "/run/rehearsal"),
  8,
);
await scene(
  "A budget before a tool call",
  "This rehearsal is simulated: no wallet approval, AI inference or money movement.",
  async () => {
    await page.getByRole("button", { name: /Look up coffee demand/ }).scrollIntoViewIfNeeded();
  },
  7,
);
await scene(
  "Meter successful work",
  "Coffee lookup adds USD 0.20 to the usage ledger.",
  () => page.getByRole("button", { name: /Look up coffee demand/ }).click(),
  7,
);
await scene(
  "The human decides",
  "A USD 0.35 call crosses the consent threshold. Policy caps still apply.",
  async () => {
    await page
      .getByRole("button", { name: /Estimate.*Korea|Korea.*estimate|KR/ })
      .first()
      .click();
  },
  7,
);
await scene(
  "Approve this call",
  "Consent authorizes this tool call, not unlimited agent spending.",
  () => page.getByRole("button", { name: "Allow this call" }).click(),
  7,
);
await scene(
  "A second estimate",
  "The next paid call asks again.",
  async () => {
    await page
      .getByRole("button", { name: /Japan|JP/ })
      .first()
      .click();
  },
  5,
);
await scene(
  "Three successful calls",
  "USD 0.20 + USD 0.35 + USD 0.35 = USD 0.90.",
  () => page.getByRole("button", { name: "Allow this call" }).click(),
  7,
);
await scene(
  "Retry without double charging",
  "Replay keeps the same call identity: additional usage is USD 0.00.",
  () => page.getByRole("button", { name: /Replay coffee lookup/ }).click(),
  7,
);
await scene(
  "Finish once",
  "Closing stops new spending and settles successful usage.",
  () => page.getByRole("button", { name: /Finish and settle/ }).click(),
  6,
);
await scene(
  "A clear receipt",
  "Simulated settlement: USD 0.90. Unused budget is not charged.",
  async () => {
    await page.getByRole("button", { name: "Confirm finish", exact: true }).click();
    await page.goto(origin + "/receipts/rehearsal");
  },
  9,
);
await scene(
  "Merchant visibility",
  "Separate simulated data. Community grids expose sessions and charges.",
  async () => {
    await page.goto(origin + "/demo/merchant");
    await page.getByRole("gridcell").first().waitFor();
  },
  9,
);
await scene(
  "Inspect the business",
  "Filter sample records without requiring merchant credentials.",
  async () => {
    await page.getByLabel("Date range").click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
  },
  7,
);
await scene(
  "Try the real sandbox path",
  "The judge guide explains personal sandbox buyers, real AI, and explicit fallback.",
  () => page.goto(origin + "/judge"),
  9,
);
await context.close();
const video = await page.video().path();
copyFileSync(video, join(dir, "raw", "screencast.webm"));
await browser.close();
writeFileSync(
  join(dir, "recording.json"),
  JSON.stringify(
    { video: "raw/screencast.webm", seconds: (Date.now() - start) / 1000, scenes },
    null,
    2,
  ),
);
console.log("Public screencast saved.");
