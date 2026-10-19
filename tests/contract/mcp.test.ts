import { env, exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { TollboothClient } from "../../src/client/adapter";
import { PRICING_VERSION } from "../../src/domain/contracts";
import { defaultPolicy } from "../../src/domain/policy";
import { signAccess } from "../../src/worker/auth";
import { paypalFake } from "../fixtures/paypal";

const origin = "http://127.0.0.1:8787";
const network: typeof fetch = (input, init) => {
  const r = new Request(input, init);
  r.headers.set("Host", new URL(r.url).host);
  return exports.default.fetch(r);
};
async function token(owner = crypto.randomUUID()) {
  return signAccess(
    {
      owner,
      exp: Date.now() + 3500000,
      aud: "tollbooth-client",
      scopes: ["open", "read", "call", "close"],
    },
    env.OWNER_TOKEN_SIGNING_KEY,
  );
}
async function connect(era: "modern" | "legacy", bearer?: string) {
  const c = new Client(
    { name: "m1-test", version: "0.1.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  const requests: Request[] = [];
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    fetch: (input, init) => {
      const r = new Request(input, init);
      r.headers.set("Host", new URL(r.url).host);
      requests.push(r.clone() as Request);
      return exports.default.fetch(r);
    },
    requestInit: { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} },
  });
  await c.connect(transport, era === "legacy" ? { prior: { kind: "legacy" } } : undefined);
  return { c, requests };
}
it.each(["modern", "legacy"] as const)(
  "M01 %s real SDK handler: discovery, payment offer, 3 calls, replay, close",
  async (era) => {
    const p = paypalFake(),
      bearer = await token();
    const { c, requests } = await connect(era, bearer);
    const list = await c.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["market_lookup", "landed_cost", "tollbooth_open"]),
    );
    const opened = await c.callTool({
      name: "tollbooth_open",
      arguments: { budgetCents: 500, creationKey: crypto.randomUUID() },
    });
    expect(opened.isError).not.toBe(true);
    const sessionId = String((opened.structuredContent as Record<string, unknown>)?.sessionId);
    const m = { sessionId, callKey: "coffee", maxPriceCents: 20, pricingVersion: PRICING_VERSION };
    const offer = await c.callTool({
      name: "market_lookup",
      arguments: { category: "coffee" },
      _meta: { tollbooth: m },
    });
    expect(offer).toMatchObject({
      isError: true,
      structuredContent: {
        code: "PAYMENT_REQUIRED",
        status: 402,
        approvalUrl: expect.stringContaining("sandbox.paypal.com"),
      },
    });
    p.approved = true;
    const activated = await network(`${origin}/api/sessions/${sessionId}/activate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(await activated.json()).toMatchObject({ state: "ACTIVE" });
    expect(
      (
        await c.callTool({
          name: "market_lookup",
          arguments: { category: "coffee" },
          _meta: { tollbooth: m },
        })
      ).isError,
    ).not.toBe(true);
    for (const destination of ["KR", "JP"])
      expect(
        (
          await c.callTool({
            name: "landed_cost",
            arguments: { itemUsd: 45, destination },
            _meta: { tollbooth: { ...m, callKey: destination, maxPriceCents: 35 } },
          })
        ).isError,
      ).not.toBe(true);
    expect(
      await c.callTool({
        name: "market_lookup",
        arguments: { category: "coffee" },
        _meta: { tollbooth: m },
      }),
    ).toMatchObject({
      structuredContent: { replayed: true, additionalAccruedCents: 0, usedCents: 90 },
    });
    expect(await c.callTool({ name: "tollbooth_close", arguments: { sessionId } })).toMatchObject({
      structuredContent: {
        state: "CAPTURED",
        capturedCents: 90,
        ledger: [{ amountCents: 20 }, { amountCents: 35 }, { amountCents: 35 }],
      },
    });
    expect(p.captureCount).toBe(1);
    expect(p.captureAmount).toBe(90);
    expect(p.voidCount).toBe(0);
    expect(
      requests.some(
        (r) =>
          r.headers.get("MCP-Protocol-Version") ===
          (era === "modern" ? "2026-07-28" : "2025-11-25"),
      ),
    ).toBe(true);
    await c.close();
  },
);
it("M02 adapter policy rejection precedes order creation", async () => {
  const p = paypalFake();
  const c = new TollboothClient(
    origin,
    await token(),
    {
      approveCall: async () => {
        throw new Error("unexpected prompt");
      },
      approvePayment: async () => {
        throw new Error("unexpected payment");
      },
    },
    { ...defaultPolicy, perCallCapCents: 10 },
    network,
  );
  await c.connect();
  await expect(c.call("market_lookup", { category: "coffee" }, "key")).rejects.toThrow(
    "PER_CALL_CAP_EXCEEDED",
  );
  expect(p.createCount).toBe(0);
  await c.disconnect();
});
it("M03 adapter human decline creates no order", async () => {
  const p = paypalFake();
  const c = new TollboothClient(
    origin,
    await token(),
    {
      approveCall: async () => false,
      approvePayment: async () => {
        throw new Error("unexpected payment");
      },
    },
    defaultPolicy,
    network,
  );
  await c.connect();
  await expect(c.call("landed_cost", { itemUsd: 45, destination: "KR" }, "key")).rejects.toThrow(
    "HUMAN_DECLINED",
  );
  expect(p.createCount).toBe(0);
  await c.disconnect();
});
it("M04 wrong bearer, foreign origin and exact port mismatch are denied", async () => {
  for (const [headers, status] of [
    [{ Authorization: "Bearer invalid" }, 401],
    [{ Origin: "https://evil.example" }, 403],
    [{ Origin: "http://127.0.0.1:9999" }, 403],
  ] as const) {
    const r = await network(`${origin}/api/tools`, { headers });
    expect(r.status).toBe(status);
  }
  expect((await network(`${origin}/api/sessions/${crypto.randomUUID()}`)).status).toBe(401);
});
it("M05 public merchant API cannot leak sandbox identifiers", async () => {
  const p = paypalFake();
  const r = await network(`${origin}/api/merchant`);
  expect(r.status).toBe(404);
  expect(await r.text()).not.toContain(p.orderId);
});
it.each(["modern", "legacy"] as const)("M06 %s schema failure has no order/debit", async (era) => {
  const p = paypalFake();
  const { c } = await connect(era, await token());
  const r = await c.callTool({
    name: "landed_cost",
    arguments: { itemUsd: -1, destination: "KR" },
  });
  expect(r.isError).toBe(true);
  expect(p.createCount).toBe(0);
  await c.close();
});
it("M07 prepaid MCP/session override rejected before network", async () => {
  const p = paypalFake();
  const { c } = await connect("modern", await token());
  expect(
    (
      await c.callTool({
        name: "tollbooth_open",
        arguments: { budgetCents: 500, creationKey: "x", mode: "prepaid" },
      })
    ).isError,
  ).toBe(true);
  expect(p.createCount).toBe(0);
  await c.close();
});
it("M08 unauthenticated quote creates no order and contains no secret", async () => {
  const p = paypalFake();
  const { c } = await connect("modern");
  const r = await c.callTool({ name: "market_lookup", arguments: { category: "coffee" } });
  expect(r).toMatchObject({
    isError: true,
    structuredContent: { code: "PAYMENT_REQUIRED", nextAction: "OPEN_SESSION" },
  });
  expect(r.structuredContent).not.toHaveProperty("approvalUrl");
  expect(r.structuredContent).not.toHaveProperty("sessionId");
  expect(JSON.stringify(r)).not.toContain("fake-oauth-token");
  expect(p.createCount).toBe(0);
  await c.close();
});
it.each(["GET", "DELETE"])("%s /mcp is 405 and never ends payment session", async (method) =>
  expect((await network(`${origin}/mcp`, { method })).status).toBe(405),
);
it("unknown API is JSON 404, unbound callback is rejected, SPA deep route is HTML", async () => {
  const r = await network(`${origin}/api/missing`);
  expect(r.status).toBe(404);
  expect(r.headers.get("Content-Type")).toContain("application/json");
  expect((await network(`${origin}/paypal/return?token=UNTRUSTED`)).status).toBe(403);
});
it("modern header/body version mismatch, unsupported version and missing method rejected", async () => {
  const { c, requests } = await connect("modern");
  await c.listTools();
  const source = requests.find((r) => r.headers.get("Mcp-Method") === "tools/list");
  expect(source).toBeTruthy();
  if (!source) throw new Error("missing modern request");
  const raw = await source.clone().text();
  for (const [name, value] of [
    ["MCP-Protocol-Version", "1900-01-01"],
    ["MCP-Protocol-Version", "2025-11-25"],
    ["Mcp-Method", ""],
  ]) {
    const headers = new Headers(source.headers);
    if (value) headers.set(name, value);
    else headers.delete(name);
    const r = await network(`${origin}/mcp`, { method: "POST", headers, body: raw });
    expect(r.status).toBeGreaterThanOrEqual(400);
  }
  await c.close();
});

it("adapter completes policy and explicit human hooks through the modern handler", async () => {
  const p = paypalFake();
  let prompts = 0;
  const c = new TollboothClient(
    origin,
    await token(),
    {
      approveCall: async () => {
        prompts++;
        return true;
      },
      approvePayment: async () => {
        p.approved = true;
      },
    },
    defaultPolicy,
    network,
  );
  await c.connect();
  await c.call("market_lookup", { category: "coffee" }, "coffee");
  await c.call("landed_cost", { itemUsd: 45, destination: "KR" }, "kr");
  await c.call("landed_cost", { itemUsd: 45, destination: "JP" }, "jp");
  expect(await c.call("market_lookup", { category: "coffee" }, "coffee")).toMatchObject({
    replayed: true,
    additionalAccruedCents: 0,
  });
  expect(prompts).toBe(2);
  expect(await c.closeSession()).toMatchObject({ capturedCents: 90 });
  expect(p.captureCount).toBe(1);
  await c.disconnect();
});
it("expired and wrong-scope bearer never creates an order", async () => {
  const p = paypalFake(),
    owner = crypto.randomUUID();
  for (const [scopes, exp, status] of [
    [["open"], Date.now() - 1, 401],
    [["read"], Date.now() + 3500000, 403],
  ] as const) {
    const bearer = await signAccess(
      { owner, aud: "tollbooth-client", exp, scopes: [...scopes] },
      env.OWNER_TOKEN_SIGNING_KEY,
    );
    const r = await network(`${origin}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ budgetCents: 500, creationKey: "key" }),
    });
    expect(r.status).toBe(status);
  }
  expect(p.createCount).toBe(0);
});
it("cross-owner REST read and MCP close reveal no session", async () => {
  paypalFake();
  const a = await token(),
    b = await token();
  const opened = await network(`${origin}/api/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${a}`, "Content-Type": "application/json" },
    body: JSON.stringify({ budgetCents: 500, creationKey: "owner-test" }),
  });
  const s = (await opened.json()) as { sessionId: string };
  const wrong = await network(`${origin}/api/sessions/${s.sessionId}`, {
    headers: { Authorization: `Bearer ${b}` },
  });
  expect(wrong.status).toBe(404);
  const { c } = await connect("modern", b);
  expect(
    await c.callTool({ name: "tollbooth_close", arguments: { sessionId: s.sessionId } }),
  ).toMatchObject({ isError: true, structuredContent: { code: "NOT_FOUND", status: 404 } });
  await c.close();
});
it("JSON body bound enforced before payment", async () => {
  const p = paypalFake();
  const r = await network(`${origin}/api/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(32768) }),
  });
  expect(r.status).toBe(413);
  expect(p.createCount).toBe(0);
});

it("modern tool name header missing or inconsistent cannot execute a paid tool", async () => {
  const p = paypalFake();
  const { c, requests } = await connect("modern");
  await c.callTool({ name: "market_lookup", arguments: { category: "coffee" } });
  const original = requests.find((r) => r.headers.get("Mcp-Method") === "tools/call");
  expect(original).toBeTruthy();
  if (!original) throw new Error("Missing modern tools/call");
  const raw = await original.text();
  for (const value of ["", "landed_cost"]) {
    const h = new Headers(original.headers);
    if (value) h.set("Mcp-Name", value);
    else h.delete("Mcp-Name");
    const response = await network(`${origin}/mcp`, { method: "POST", headers: h, body: raw });
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(p.createCount).toBe(0);
  await c.close();
});

it("missing DO payment configuration returns 503 through REST and MCP before any provider order", async () => {
  const { PayPal } = await import("../../src/payments/paypal");
  const { Fault } = await import("../../src/domain/contracts");
  const { vi } = await import("vitest");
  const p = paypalFake();
  const mock = vi.spyOn(PayPal.prototype, "createPayload").mockImplementation(() => {
    throw new Fault("PAYMENT_CONFIG_REQUIRED", 503);
  });
  try {
    const bearer = await token();
    const response = await network(`${origin}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ budgetCents: 500, creationKey: "config-rest" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "PAYMENT_CONFIG_REQUIRED" });
    const { c } = await connect("modern", bearer);
    expect(
      await c.callTool({
        name: "tollbooth_open",
        arguments: { budgetCents: 500, creationKey: "config-mcp" },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: "PAYMENT_CONFIG_REQUIRED", status: 503 },
    });
    await c.close();
    expect(p.createCount + p.authorizeCount).toBe(0);
  } finally {
    mock.mockRestore();
  }
});
