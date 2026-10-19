import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const evidence = resolve("../paypal-ai-hackathon/_runs/2026-10-19-harden/screenshots");
test("AI binding fixture to real MCP adapter: consent rejection, resume, replay, receipt and 390px", async ({
  page,
  request,
}) => {
  await request.post("/__test__/reset");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open session and review PayPal approval" }).click();
  await expect(page).toHaveURL(/\/run\//);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const panel = page.getByRole("region", { name: "AI tool planner" });
  await panel.getByRole("button", { name: "Ask AI to choose tools" }).click();
  await expect(panel.getByText(/Real AI plan saved/)).toBeVisible();
  await page.reload();
  await expect(panel.getByText(/Real AI plan saved/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run AI plan through MCP" })).toBeDisabled();
  await request.post(`/__test__/session/${id}/approve`);
  await page.getByRole("button", { name: "I've approved: check status" }).click();
  await expect(panel.getByRole("button", { name: "Run AI plan through MCP" })).toBeEnabled();
  await panel.getByRole("button", { name: "Run AI plan through MCP" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Decline AI call" }).click();
  await expect(panel.getByRole("alert")).toContainText("Call declined");
  await expect(page.getByRole("button", { name: "Finish and settle USD 0.20" })).toBeVisible();
  await panel.getByRole("button", { name: "Run AI plan through MCP" }).click();
  await page.getByRole("button", { name: "Approve this AI call" }).click();
  await page.getByRole("button", { name: "Approve this AI call" }).click();
  await expect(page.getByRole("button", { name: "Finish and settle USD 0.90" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run AI plan through MCP" })).toBeEnabled();
  await panel.getByRole("button", { name: "Run AI plan through MCP" }).click();
  await expect(panel.getByRole("button", { name: "Run AI plan through MCP" })).toBeEnabled();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "LOCAL TEST · AI and PayPal provider fixtures · real MCP/DO/D1";
    document.body.insertBefore(p, document.body.firstChild);
  });
  await page.screenshot({ path: resolve(evidence, "m5-ai-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Finish and settle USD 0.90" }).click();
  await page.getByRole("button", { name: "Confirm finish", exact: true }).click();
  await expect(page.getByText("Settled · payment confirmed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Settled · payment confirmed", { exact: true })).toBeVisible();
});
test("public judge onboarding distinguishes real AI, personal sandbox account and credential-free rehearsal", async ({
  page,
}) => {
  await page.goto("/judge");
  await expect(page.getByRole("heading", { name: "Judge guide" })).toBeVisible();
  await expect(page.getByText("Personal sandbox buyer", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Open the simulated rehearsal" }).click();
  await expect(page.getByText("Simulated · no AI or payment")).toBeVisible();
});

test("exhausted AI allocation shows explicit scripted fallback without executing calls", async ({
  page,
  request,
}) => {
  await request.post("/__test__/reset");
  let paidCalls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/call") || r.url().endsWith("/mcp")) paidCalls++;
  });
  await page.route("**/api/sessions/*/ai", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "FALLBACK",
        model: "@cf/zai-org/glm-4.7-flash",
        calls: [],
        reason: "AI_FREE_ALLOCATION_EXHAUSTED",
      }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open session and review PayPal approval" }).click();
  const panel = page.getByRole("region", { name: "AI tool planner" });
  await expect(panel.getByRole("status")).toContainText("Scripted fallback available");
  await expect(panel.getByRole("link", { name: "simulated rehearsal" })).toHaveAttribute(
    "href",
    "/run/rehearsal",
  );
  expect(paidCalls).toBe(0);
  await page.screenshot({ path: resolve(evidence, "ai-fallback-mobile.png"), fullPage: true });
});
