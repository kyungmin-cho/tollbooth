import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Snapshot } from "../../src/shared/types";
import { cookie, readSigned, signBrowser } from "../../src/worker/browser-auth";
import { paypalFake } from "../fixtures/paypal";

const origin = env.APP_ORIGIN;
const send = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(origin + path, init));
async function browser() {
  const r = await send("/api/visitor", { method: "POST", headers: { Origin: origin } });
  const c = r.headers.get("Set-Cookie")!.split(";")[0];
  const { csrf } = (await r.json()) as { csrf: string };
  return {
    cookie: c,
    csrf,
    headers: {
      Origin: origin,
      Cookie: c,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
  };
}
it("visitor cookie restores its owner and browser mutations require exact Origin plus CSRF", async () => {
  paypalFake();
  expect((await send("/api/visitor", { method: "POST" })).status).toBe(403);
  const b = await browser();
  const r = await send("/api/visitor", { method: "POST", headers: b.headers });
  expect(((await r.json()) as { csrf: string }).csrf).toBe(b.csrf);
  expect(r.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(r.headers.get("Set-Cookie")).toContain("SameSite=Lax");
  expect(cookie("x", "x", 1, { ...env, APP_ORIGIN: "https://example.test" })).toContain("Secure");
  const body = JSON.stringify({ budgetCents: 500, creationKey: "browser" });
  expect(
    (
      await send("/api/sessions", {
        method: "POST",
        headers: { Cookie: b.cookie, Origin: origin },
        body,
      })
    ).status,
  ).toBe(403);
  const opened = await send("/api/sessions", { method: "POST", headers: b.headers, body });
  expect(opened.status).toBe(200);
  const s = (await opened.json()) as Snapshot;
  const other = await browser();
  expect((await send("/api/sessions/" + s.sessionId, { headers: other.headers })).status).toBe(404);
  expect((await send("/api/sessions/" + s.sessionId, { headers: b.headers })).status).toBe(200);
});
it("client issuance requires explicit consent and keeps merchant access separate", async () => {
  const b = await browser();
  expect(
    (
      await send("/api/client-access", {
        method: "POST",
        headers: b.headers,
        body: '{"confirmed":false}',
      })
    ).status,
  ).toBe(400);
  const r = await send("/api/client-access", {
    method: "POST",
    headers: b.headers,
    body: '{"confirmed":true}',
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  const { credential } = (await r.json()) as { credential: string };
  expect(
    (await send("/api/merchant/sessions", { headers: { Authorization: "Bearer " + credential } }))
      .status,
  ).toBe(401);
});
it("callback is owner/order-bound, single-use and confirms provider facts", async () => {
  const p = paypalFake(),
    b = await browser();
  const r = await send("/api/sessions", {
    method: "POST",
    headers: b.headers,
    body: JSON.stringify({ budgetCents: 500, creationKey: "callback" }),
  });
  const s = (await r.json()) as Snapshot;
  const payload = p.payloads[0] as {
    payment_source: { paypal: { experience_context: { return_url: string } } };
  };
  const url = new URL(payload.payment_source.paypal.experience_context.return_url);
  url.searchParams.set("token", p.orderId);
  p.approved = true;
  const foreign = await browser();
  expect((await exports.default.fetch(new Request(url, { headers: foreign.headers }))).status).toBe(
    403,
  );
  const wrong = new URL(url);
  wrong.searchParams.set("token", "FOREIGN");
  expect((await exports.default.fetch(new Request(wrong, { headers: b.headers }))).status).toBe(
    403,
  );
  expect(
    (await exports.default.fetch(new Request(url, { headers: b.headers, redirect: "manual" })))
      .status,
  ).toBe(303);
  expect(
    (await exports.default.fetch(new Request(url, { headers: b.headers, redirect: "manual" })))
      .status,
  ).toBe(403);
  expect(p.authorizeCount).toBe(1);
  expect(
    (
      (await (
        await send("/api/sessions/" + s.sessionId, { headers: b.headers })
      ).json()) as Snapshot
    ).state,
  ).toBe("ACTIVE");
});
it("expired or tampered cookies fail closed", async () => {
  const b = await browser();
  const value = b.cookie.split("=")[1];
  expect(await readSigned(value + "x", env.OWNER_TOKEN_SIGNING_KEY, "visitor")).toBeUndefined();
  expect(await readSigned(value, env.OWNER_TOKEN_SIGNING_KEY, "merchant")).toBeUndefined();
  const expired = await signBrowser(
    { aud: "visitor", owner: crypto.randomUUID(), csrf: crypto.randomUUID(), exp: Date.now() - 1 },
    env.OWNER_TOKEN_SIGNING_KEY,
  );
  expect(await readSigned(expired, env.OWNER_TOKEN_SIGNING_KEY, "visitor")).toBeUndefined();
});
it("public demo contains only fixtures and cannot query sandbox records", async () => {
  const r = await send("/api/demo/merchant?provider=sandbox");
  const data = (await r.json()) as {
    simulated: boolean;
    rows: { sessionId: string; captureId: string | null }[];
  };
  expect(data.simulated).toBe(true);
  expect(data.rows.every((x) => x.sessionId.startsWith("demo-") && x.captureId === null)).toBe(
    true,
  );
  expect((await send("/api/merchant/summary")).status).toBe(401);
});
it("merchant login rate limit and CSRF protect private grids and read-reconcile", async () => {
  const b = await browser();
  const login = () =>
    send("/api/merchant/login", {
      method: "POST",
      headers: b.headers,
      body: JSON.stringify({ secret: env.MERCHANT_ADMIN_TOKEN }),
    });
  const r = await login();
  expect(r.status).toBe(200);
  expect(r.headers.get("Set-Cookie")).toContain("SameSite=Strict");
  const c = r.headers.get("Set-Cookie")!.split(";")[0],
    { csrf } = (await r.json()) as { csrf: string };
  const h = { Cookie: c, Origin: origin, "X-CSRF-Token": csrf };
  const page = await send("/api/merchant/sessions", { headers: h });
  expect(page.status).toBe(200);
  const result = (await page.json()) as { rows: unknown[] };
  expect(result.rows.length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(result)).not.toContain("approvalUrl");
  expect(JSON.stringify(result)).not.toContain("owner_id");
  expect(
    (await send("/api/merchant/logout", { method: "POST", headers: { Cookie: c, Origin: origin } }))
      .status,
  ).toBe(403);
  expect((await send("/api/merchant/logout", { method: "POST", headers: h })).status).toBe(200);
  for (let i = 0; i < 5; i++)
    await send("/api/merchant/login", {
      method: "POST",
      headers: b.headers,
      body: '{"secret":"wrong"}',
    });
  expect((await login()).status).toBe(429);
});
