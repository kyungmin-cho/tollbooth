import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { signAccess } from "../../src/worker/auth";
import { rateLimit } from "../../src/worker/rate-limit";

it("atomic counters bound concurrent attempts across owners sharing an IP", async () => {
  const action = crypto.randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      rateLimit(env, action, ["ip:shared", `owner:${i}`], 5, 600000),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  const rows = await env.DB.prepare("SELECT MAX(attempts) AS n FROM login_attempts").first<{
    n: number;
  }>();
  expect(rows?.n).toBe(6);
});
it("owner limit persists across IP changes and expires at the window boundary", async () => {
  const action = crypto.randomUUID();
  await rateLimit(env, action, ["ip:a", "owner:same"], 1, 1000, 1001);
  await expect(rateLimit(env, action, ["ip:b", "owner:same"], 1, 1000, 1002)).rejects.toMatchObject(
    { code: "RATE_LIMITED", status: 429, retryAfterMs: 998 },
  );
  await rateLimit(env, action, ["ip:a", "owner:same"], 1, 1000, 2000);
});
it("HTTP admission rejects before provider work and returns Retry-After", async () => {
  const owner = crypto.randomUUID(),
    ip = crypto.randomUUID();
  for (let i = 0; i < 30; i++)
    await rateLimit(env, "open", [`ip:${ip}`, `owner:${owner}`], 30, 3600000);
  const token = await signAccess(
    { owner, exp: Date.now() + 3500000, aud: "tollbooth-client", scopes: ["open"] },
    env.OWNER_TOKEN_SIGNING_KEY,
  );
  const r = await exports.default.fetch(
    new Request("http://127.0.0.1:8787/api/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": ip,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(r.status).toBe(429);
  expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await r.json()).toMatchObject({ code: "RATE_LIMITED" });
});

it("AI POST admission is limited but read-only status remains available", async () => {
  const owner = crypto.randomUUID(),
    ip = crypto.randomUUID(),
    id = crypto.randomUUID();
  for (let i = 0; i < 6; i++)
    await rateLimit(env, "ai", [`ip:${ip}`, `owner:${owner}`], 6, 3600000);
  const token = await signAccess(
    { owner, exp: Date.now() + 3500000, aud: "tollbooth-client", scopes: ["call", "read"] },
    env.OWNER_TOKEN_SIGNING_KEY,
  );
  const headers = { Authorization: `Bearer ${token}`, "CF-Connecting-IP": ip };
  const url = `http://127.0.0.1:8787/api/sessions/${id}/ai`;
  const denied = await exports.default.fetch(new Request(url, { method: "POST", headers }));
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
  const read = await exports.default.fetch(new Request(url, { headers }));
  expect(read.status).toBe(404);
});
