import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { fixture, PRICING_VERSION } from "../../src/domain/contracts";
import { openSession } from "../../src/worker/service";
import { due, plain, setup } from "../helpers";

it("T01 T02 unpaid call offers approval URL without execution or reservation", async () => {
  const t = await setup(500, false);
  expect(
    await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()),
  ).toMatchObject({
    code: "PAYMENT_REQUIRED",
    status: 402,
    approvalUrl: expect.stringContaining("sandbox.paypal.com"),
  });
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    usedCents: 0,
    reservedCents: 0,
    ledger: [],
  });
  expect(t.payment.authorizeCount).toBe(0);
});
it("T04 T05 same key replays, changed input or quote conflicts", async () => {
  const t = await setup();
  const m = t.meta();
  let executions = 0;
  await runInDurableObject(t.stub, (instance) => {
    instance.executeFixture = async (name, args) => {
      executions++;
      return fixture(name, args);
    };
  });
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m);
  expect(await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m)).toMatchObject({
    replayed: true,
    additionalAccruedCents: 0,
  });
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "outdoor" }, m))(),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(
        t.owner,
        "market_lookup",
        { category: "coffee" },
        { ...m, maxPriceCents: 49 },
      ))(),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(executions).toBe(1);
  expect((await t.stub.status(t.owner, t.session.sessionId)).ledger).toHaveLength(1);
});
it("T06 T07 ten concurrent calls compete for 50 cents without overspend", async () => {
  const t = await setup(50);
  let executions = 0;
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async (n, a) => {
      executions++;
      return fixture(n, a);
    };
  });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()),
    ),
  );
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
  expect(executions).toBe(2);
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    usedCents: 40,
    reservedCents: 0,
    availableCents: 10,
  });
});
it("concurrent duplicate while execution is held has one reservation and one execution", async () => {
  const t = await setup(),
    m = t.meta();
  const gate = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  let startedDone = false;
  let executions = 0;
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async (n, a) => {
      executions++;
      startedDone = true;
      started.resolve();
      await gate.promise;
      return fixture(n, a);
    };
  });
  const first = plain(t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m));
  await vi.waitFor(() => expect(startedDone).toBe(true));
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m))(),
  ).rejects.toThrow("CALL_IN_PROGRESS");
  expect((await t.stub.status(t.owner, t.session.sessionId)).reservedCents).toBe(20);
  gate.resolve();
  await first;
  expect(executions).toBe(1);
});
it("T08 known execution failure releases once and failed key cannot retry", async () => {
  const t = await setup(),
    m = t.meta();
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async () => {
      throw new Error("private upstream data");
    };
  });
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m))(),
  ).rejects.toThrow("TOOL_FAILED");
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m))(),
  ).rejects.toThrow("PREVIOUS_CALL_FAILED");
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    usedCents: 0,
    reservedCents: 0,
    ledger: [],
  });
});
it("T09 unknown unsafe crash reservation blocks settlement", async () => {
  const t = await setup();
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec(
      "INSERT INTO calls VALUES('unsafe','external','{}','hash',20,'UNKNOWN',1,1,0,NULL,NULL,NULL)",
    );
    s.storage.sql.exec("UPDATE session SET reserved_cents=20");
  });
  await t.stub.close(t.owner, t.session.sessionId);
  await t.stub.recover();
  expect(t.payment.captureCount + t.payment.voidCount).toBe(0);
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    reservedCents: 20,
    state: "MANUAL_REVIEW",
  });
});
it("T10 owner enforced before cached result, read and close", async () => {
  const t = await setup(),
    m = t.meta();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m);
  for (const f of [
    () => t.stub.status("foreign", m.sessionId),
    () => t.stub.close("foreign", m.sessionId),
    () => t.stub.call("foreign", "market_lookup", { category: "coffee" }, m),
  ])
    await expect(plain(f())).rejects.toThrow("NOT_FOUND");
});
it("T18 T21 concurrent close freezes one exact final capture, no post-capture void", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await Promise.all(Array.from({ length: 5 }, () => t.stub.close(t.owner, t.session.sessionId)));
  expect(t.payment.captureCount).toBe(1);
  expect(t.payment.voidCount).toBe(0);
  expect(t.payment.payloads.at(-1)).toMatchObject({
    amount: { currency_code: "USD", value: "0.20" },
    final_capture: true,
  });
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    state: "CAPTURED",
    capturedCents: 20,
    settlement: { releaseEvidence: "FINAL_CAPTURE" },
  });
});
it("closing while execution is deferred waits for its durable usage", async () => {
  const t = await setup(),
    gate = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  let startedDone = false;
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async (n, a) => {
      startedDone = true;
      started.resolve();
      await gate.promise;
      return fixture(n, a);
    };
  });
  const pending = plain(t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()));
  await vi.waitFor(() => expect(startedDone).toBe(true));
  expect(await t.stub.close(t.owner, t.session.sessionId)).toMatchObject({
    state: "CLOSING",
    reservedCents: 20,
  });
  expect(t.payment.captureCount).toBe(0);
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()))(),
  ).rejects.toThrow("SESSION_CLOSING");
  gate.resolve();
  await pending;
  expect(t.payment.captureCount).toBe(1);
  expect(t.payment.captureAmount).toBe(20);
});
it("T19 P08 zero use void confirms provider 204 and invents no void ID", async () => {
  const t = await setup();
  expect(await t.stub.close(t.owner, t.session.sessionId)).toMatchObject({
    state: "VOIDED",
    capturedCents: 0,
    settlement: { kind: "VOID", captureId: null, releaseEvidence: "VOIDED" },
  });
  expect(t.payment.voidCount).toBe(1);
  expect(t.payment.captureCount).toBe(0);
});
it("T20 lost void response reconciles with GET and no second POST", async () => {
  const t = await setup();
  t.payment.lostVoid = true;
  expect(await t.stub.close(t.owner, t.session.sessionId)).toMatchObject({ state: "RECONCILING" });
  await due(t.stub);
  await t.stub.recover();
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("VOIDED");
  expect(t.payment.voidCount).toBe(1);
  expect(t.payment.captureCount).toBe(0);
});
it("T22 wrong final flag never produces a paid receipt", async () => {
  const t = await setup();
  t.payment.final = false;
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  expect(await t.stub.close(t.owner, t.session.sessionId)).toMatchObject({
    state: "MANUAL_REVIEW",
    capturedCents: 0,
    settlement: { releaseEvidence: "UNCONFIRMED" },
  });
});
it("T23 PENDING freezes spending, keeps ledger readable, then GET completes", async () => {
  const t = await setup();
  t.payment.captureStatus = "PENDING";
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  expect(await t.stub.close(t.owner, t.session.sessionId)).toMatchObject({
    state: "RECONCILING",
    capturedCents: 0,
    ledger: [{ amountCents: 20 }],
  });
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()))(),
  ).rejects.toThrow("SESSION_CLOSING");
  t.payment.captureStatus = "COMPLETED";
  await due(t.stub);
  await t.stub.recover();
  expect((await t.stub.status(t.owner, t.session.sessionId)).capturedCents).toBe(20);
  expect(t.payment.captureCount).toBe(1);
});
it("T24 mismatched provider amount enters review", async () => {
  const t = await setup();
  t.payment.captureAmount = 21;
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  expect(await t.stub.close(t.owner, t.session.sessionId)).toMatchObject({
    state: "MANUAL_REVIEW",
    capturedCents: 0,
  });
});
it("T26 expiry refuses new calls and alarm settles without request-driven close", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("UPDATE session SET idle_deadline=0");
  });
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()))(),
  ).rejects.toThrow("SESSION_EXPIRED");
  expect(await runDurableObjectAlarm(t.stub)).toBe(true);
  expect(t.payment.captureCount).toBe(1);
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("CAPTURED");
});
it("T27 exhausted budget closes after reservations resolve", async () => {
  const t = await setup(55);
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.call(t.owner, "landed_cost", { itemUsd: 45, destination: "KR" }, t.meta());
  await runDurableObjectAlarm(t.stub);
  expect(t.payment.captureCount).toBe(1);
  expect(t.payment.captureAmount).toBe(55);
});
it("T28 T41 eviction reconstructs storage and returns same cached result", async () => {
  const t = await setup(),
    m = t.meta();
  const first = await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m);
  await evictDurableObject(t.stub);
  const replay = await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m);
  expect(replay).toMatchObject({
    ...(first as Record<string, unknown>),
    replayed: true,
    additionalAccruedCents: 0,
  });
  expect((await t.stub.status(t.owner, m.sessionId)).ledger).toHaveLength(1);
});
it("T29 closed session allows only completed replay", async () => {
  const t = await setup(),
    m = t.meta();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m);
  await t.stub.close(t.owner, m.sessionId);
  expect(await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m)).toMatchObject({
    replayed: true,
  });
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()))(),
  ).rejects.toThrow("SESSION_CLOSING");
});
it("T30 unexpected prepaid capture cannot activate", async () => {
  const t = await setup(500, false);
  t.payment.authorized = true;
  t.payment.captureCount = 1;
  t.payment.captureAmount = 500;
  expect(await t.stub.activate(t.owner, t.session.sessionId)).toMatchObject({
    state: "MANUAL_REVIEW",
    usedCents: 0,
  });
});
it("T39 abandoned existing authorization is discovered and zero-use voided", async () => {
  const t = await setup(500, false);
  t.payment.authorized = true;
  await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql.exec("UPDATE session SET approval_deadline=0").toArray(),
  );
  await runDurableObjectAlarm(t.stub);
  expect(t.payment.authorizeCount).toBe(0);
  expect(t.payment.voidCount).toBe(1);
});
it.each([false, true])(
  "T40 approved=%s expired order without hold is abandoned without new authorization",
  async (approved) => {
    const t = await setup(500, false);
    t.payment.approved = approved;
    await runInDurableObject(t.stub, (_i, s) =>
      s.storage.sql.exec("UPDATE session SET approval_deadline=0").toArray(),
    );
    await runDurableObjectAlarm(t.stub);
    expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("EXPIRED");
    expect(t.payment.authorizeCount + t.payment.captureCount + t.payment.voidCount).toBe(0);
  },
);
it("P02 P03 P04 lost successful capture recovers by GET under original identity", async () => {
  const t = await setup();
  t.payment.lostCapture = true;
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  await evictDurableObject(t.stub);
  await due(t.stub);
  await t.stub.recover();
  await t.stub.close(t.owner, t.session.sessionId);
  expect(t.payment.captureCount).toBe(1);
  expect(t.payment.keys[0]).toMatch(/^[a-f0-9-]{36}$/);
  expect((await t.stub.status(t.owner, t.session.sessionId)).capturedCents).toBe(20);
});
it("P05 activation before approval never sends authorize", async () => {
  const t = await setup(500, false);
  await expect(
    (async (): Promise<unknown> => await t.stub.activate(t.owner, t.session.sessionId))(),
  ).rejects.toThrow("AWAITING_BUYER_APPROVAL");
  expect(t.payment.authorizeCount).toBe(0);
});
it("P06 stable admission key creates exactly one AUTHORIZE wallet order", async () => {
  const t = await setup(500, false);
  const r = await env.DB.prepare("SELECT creation_key FROM session_index WHERE session_id=?")
    .bind(t.session.sessionId)
    .first<{ creation_key: string }>();
  expect(r).toBeTruthy();
  const again = await openSession(env, t.owner, { budgetCents: 500, creationKey: r?.creation_key });
  expect(again.sessionId).toBe(t.session.sessionId);
  expect(t.payment.createCount).toBe(1);
  expect(t.payment.payloads[0]).toMatchObject({
    intent: "AUTHORIZE",
    purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }],
    payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING" } } },
  });
});
it("durable projection replay cannot double or regress totals", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  const fresh = await env.DB.prepare("SELECT * FROM session_projection WHERE session_id=?")
    .bind(t.session.sessionId)
    .first();
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("UPDATE outbox SET delivered_at=NULL");
  });
  await t.stub.flush();
  expect(
    await env.DB.prepare("SELECT * FROM session_projection WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toEqual(fresh);
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("UPDATE outbox SET delivered_at=NULL WHERE session_version=1");
  });
  await t.stub.flush();
  expect(
    await env.DB.prepare("SELECT * FROM session_projection WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toEqual(fresh);
});
it("four reserved calls limit is persisted while work awaits", async () => {
  const t = await setup(),
    gate = Promise.withResolvers<void>();
  let entered = 0;
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async (n, a) => {
      entered++;
      await gate.promise;
      return fixture(n, a);
    };
  });
  const pending = Array.from({ length: 4 }, () =>
    plain(t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta())),
  );
  await vi.waitFor(() => expect(entered).toBe(4));
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()))(),
  ).rejects.toThrow("CALL_LIMIT");
  gate.resolve();
  await Promise.all(pending);
  expect((await t.stub.status(t.owner, t.session.sessionId)).usedCents).toBe(80);
});
it("late completion with stale fence cannot commit twice", async () => {
  const t = await setup(),
    gate = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>(),
    m = t.meta();
  let startedDone = false;
  let executions = 0;
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async (n, a) => {
      if (++executions === 1) {
        startedDone = true;
        started.resolve();
        await gate.promise;
      }
      return fixture(n, a);
    };
  });
  const first = plain(t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m));
  await vi.waitFor(() => expect(startedDone).toBe(true));
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("UPDATE calls SET lease_until=0");
  });
  await t.stub.recover();
  gate.resolve();
  await first;
  expect(executions).toBe(2);
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    usedCents: 20,
    reservedCents: 0,
    ledger: [{ amountCents: 20 }],
  });
});
it("wrong pricing version is rejected before execution", async () => {
  const t = await setup();
  await expect(
    (async (): Promise<unknown> =>
      await t.stub.call(
        t.owner,
        "market_lookup",
        { category: "coffee" },
        { ...t.meta(), pricingVersion: `${PRICING_VERSION}-changed` as typeof PRICING_VERSION },
      ))(),
  ).rejects.toThrow();
  expect((await t.stub.status(t.owner, t.session.sessionId)).ledger).toHaveLength(0);
});
