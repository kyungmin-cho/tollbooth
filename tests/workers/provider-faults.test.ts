import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { BASE } from "../../src/payments/paypal";
import { due, plain, setup } from "../helpers";

it("a stale failed authorize response cannot regress an already recovered authorization", async () => {
  const t = await setup(500, false);
  t.payment.approved = true;
  t.payment.lostAuthorize = true;
  const upstream = fetch;
  const gate = Promise.withResolvers<void>();
  let held = false;
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream(u, init);
    if (String(u).endsWith("/authorize")) {
      held = true;
      await gate.promise;
    }
    return response;
  });
  const first = plain(t.stub.activate(t.owner, t.session.sessionId));
  await vi.waitFor(() => expect(held).toBe(true));
  expect((await t.stub.activate(t.owner, t.session.sessionId)).state).toBe("ACTIVE");
  gate.resolve();
  await first;
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("ACTIVE");
  expect(t.payment.authorizeCount).toBe(1);
});
it("multiple provider captures require review instead of a paid receipt", async () => {
  const t = await setup();
  t.payment.extraCapture = true;
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    state: "MANUAL_REVIEW",
    capturedCents: 0,
  });
  expect(t.payment.captureCount).toBe(1);
});
it.each([0, 20])(
  "expired authorization with %s used cents never sends another capture or void",
  async (used) => {
    const t = await setup();
    if (used) await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
    t.payment.authorizationStatus = "EXPIRED";
    const s = await t.stub.close(t.owner, t.session.sessionId);
    expect(s.state).toBe(used ? "MANUAL_REVIEW" : "EXPIRED");
    expect(t.payment.captureCount + t.payment.voidCount).toBe(0);
    expect(s.usedCents).toBe(used);
  },
);
it("invalid authorization expiry cannot activate or create NaN deadlines", async () => {
  const t = await setup(500, false);
  t.payment.approved = true;
  t.payment.authorizationExpiry = "not-a-time";
  expect((await t.stub.activate(t.owner, t.session.sessionId)).state).toBe("MANUAL_REVIEW");
});
it("revoked credentials freeze provider work with no financial retry or raw errors", async () => {
  const t = await setup(500, false);
  t.payment.approved = true;
  const upstream = fetch;
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) =>
    String(u) === BASE + "/v1/oauth2/token"
      ? Response.json({ message: "credential-secret-fixture" }, { status: 401 })
      : Response.json({}, { status: 401 }),
  );
  const s = await t.stub.activate(t.owner, t.session.sessionId);
  expect(s.state).toBe("RECONCILING");
  expect(JSON.stringify(s)).not.toContain("credential-secret-fixture");
  expect(t.payment.authorizeCount).toBe(0);
  vi.stubGlobal("fetch", upstream);
});
it("late pending read cannot overwrite a completed capture", async () => {
  const t = await setup();
  t.payment.captureStatus = "PENDING";
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  await due(t.stub);
  const upstream = fetch;
  const gate = Promise.withResolvers<void>();
  let held = false;
  let hold = true;
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
    const r = await upstream(u, init);
    if (hold && String(u).endsWith("/" + t.payment.authId)) {
      hold = false;
      held = true;
      await gate.promise;
    }
    return r;
  });
  const pending = plain(t.stub.reconcile(t.owner, t.session.sessionId));
  await vi.waitFor(() => expect(held).toBe(true));
  t.payment.captureStatus = "COMPLETED";
  await t.stub.reconcile(t.owner, t.session.sessionId);
  gate.resolve();
  await pending;
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("CAPTURED");
  expect(t.payment.captureCount).toBe(1);
});

it.each([false, true])(
  "resume first-run regression: authoritative DO terminal before provider read convergence, zero=%s",
  async (zero) => {
    const { awaitEvidence, requireProviderVisibility } = await import(
      "../../scripts/e2e-sandbox/support"
    );
    const t = await setup();
    if (!zero) await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
    const s = await t.stub.close(t.owner, t.session.sessionId);
    expect(s.state).toBe(zero ? "VOIDED" : "CAPTURED");
    const upstream = fetch;
    let reads = 0;
    vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
      const r = await upstream(u, init);
      if (String(u).endsWith("/" + t.payment.orderId) && ++reads === 1) {
        const o = (await r.json()) as {
          status: string;
          purchase_units: { payments: { captures: unknown[] } }[];
        };
        o.status = "APPROVED";
        o.purchase_units[0].payments.captures = [];
        return Response.json(o);
      }
      return r;
    });
    await awaitEvidence(
      async () => {
        const r = await fetch(BASE + "/v2/checkout/orders/" + t.payment.orderId);
        const o = (await r.json()) as {
          status: string;
          purchase_units: { payments: { captures: unknown[] } }[];
        };
        const a = (await (
          await fetch(BASE + "/v2/payments/authorizations/" + t.payment.authId)
        ).json()) as { status: string };
        requireProviderVisibility(
          o.status,
          a.status,
          o.purchase_units[0].payments.captures.length,
          zero,
        );
      },
      { sleep: async () => {} },
    );
    expect(reads).toBe(2);
    expect(t.payment.captureCount).toBe(zero ? 0 : 1);
    expect(t.payment.voidCount).toBe(zero ? 1 : 0);
    expect(await t.stub.status(t.owner, t.session.sessionId)).toEqual(s);
  },
);

it("provider Retry-After persists across eviction and suppresses early automatic reads", async () => {
  const { evictDurableObject, runInDurableObject } = await import("cloudflare:test");
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  const upstream = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u).endsWith("/capture")
        ? Response.json({}, { status: 429, headers: { "Retry-After": "120" } })
        : upstream(u, init),
    ),
  );
  await t.stub.close(t.owner, t.session.sessionId);
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("RECONCILING");
  await evictDurableObject(t.stub);
  await due(t.stub);
  const count = vi.mocked(fetch).mock.calls.length;
  await t.stub.recover();
  expect(vi.mocked(fetch).mock.calls.length).toBe(count);
  expect(
    await runInDurableObject(
      t.stub,
      (_i, s) => s.storage.sql.exec("SELECT until_at FROM provider_cooldown").one().until_at,
    ),
  ).toBeGreaterThan(Date.now() + 100000);
  expect(t.payment.captureCount).toBe(0);
});

it("completed capture with a lagging authorization stays recoverable until both views converge", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  const upstream = fetch;
  let stale = true;
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
    const r = await upstream(u, init);
    if (stale && t.payment.captureCount === 1 && String(u).endsWith("/" + t.payment.authId)) {
      const a = (await r.json()) as Record<string, unknown>;
      return Response.json({ ...a, status: "CREATED" });
    }
    return r;
  });
  expect((await t.stub.close(t.owner, t.session.sessionId)).state).toBe("RECONCILING");
  stale = false;
  await due(t.stub);
  await t.stub.recover();
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    state: "CAPTURED",
    authorizationStatus: "CAPTURED",
    capturedCents: 20,
  });
  expect(t.payment.captureCount).toBe(1);
});
