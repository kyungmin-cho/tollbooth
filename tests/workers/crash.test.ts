import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { canonical, fixture, hash } from "../../src/domain/contracts";
import { retryDelay } from "../../src/durable/retry";
import { recoveryScan, sessionStub } from "../../src/worker/service";
import { paypalFake } from "../fixtures/paypal";
import { due, plain, setup } from "../helpers";

it("crash after admission before initialization uses the same anchor once", async () => {
  const p = paypalFake(),
    id = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session_index(session_id,owner_id,merchant_id,creation_key,creation_hash,budget_cents,pricing_version,created_at,approval_deadline,recovery_due_at) VALUES(?,?,?,?,?,500,?,?,?,0)",
  )
    .bind(id, owner, env.MERCHANT_ID, "crash-anchor", "immutable", "fixture-v1", now, now + 1800000)
    .run();
  const stub = sessionStub(env, id);
  await runInDurableObject(stub, () => {});
  await evictDurableObject(stub);
  await recoveryScan(env);
  await recoveryScan(env);
  expect((await stub.status(owner, id)).state).toBe("APPROVAL_PENDING");
  expect(p.createCount).toBe(1);
});
it("lost create response never sends another order after eviction or alarms", async () => {
  const p = paypalFake();
  p.lostCreate = true;
  const { openSession } = await import("../../src/worker/service");
  const owner = crypto.randomUUID();
  const s = await openSession(env, owner, { budgetCents: 500, creationKey: "lost-create" });
  const stub = sessionStub(env, s.sessionId);
  const op = await runInDurableObject(stub, (_i, state) =>
    state.storage.sql.exec("SELECT request_id,payload_hash FROM payment_operations").one(),
  );
  await evictDurableObject(stub);
  await due(stub);
  await stub.recover();
  await stub.recover();
  expect(p.createCount).toBe(1);
  expect((await stub.status(owner, s.sessionId)).state).toBe("RECONCILING");
  expect(
    await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT request_id,payload_hash FROM payment_operations").one(),
    ),
  ).toEqual(op);
});
it("lost authorize response recovers existing hold after eviction without another POST", async () => {
  const t = await setup(500, false);
  t.payment.approved = true;
  t.payment.lostAuthorize = true;
  expect((await t.stub.activate(t.owner, t.session.sessionId)).state).toBe("RECONCILING");
  await evictDurableObject(t.stub);
  await due(t.stub);
  await t.stub.recover();
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("ACTIVE");
  expect(t.payment.authorizeCount).toBe(1);
});
it("crash after execution before ledger finalize retains reservation and fenced pure recovery", async () => {
  const t = await setup(),
    m = t.meta();
  let executed = 0;
  await runInDurableObject(t.stub, (i, s) => {
    i.executeFixture = async (n, a) => {
      executed++;
      return fixture(n, a);
    };
    s.storage.sql.exec(
      "CREATE TRIGGER fail_finalize BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT,'crash-boundary'); END",
    );
  });
  await expect(
    plain(t.stub.call(t.owner, "market_lookup", { category: "coffee" }, m)),
  ).rejects.toThrow();
  expect(executed).toBe(1);
  expect((await t.stub.status(t.owner, t.session.sessionId)).reservedCents).toBe(20);
  await evictDurableObject(t.stub);
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("DROP TRIGGER fail_finalize");
    s.storage.sql.exec("UPDATE calls SET lease_until=0");
  });
  await t.stub.recover();
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    usedCents: 20,
    reservedCents: 0,
    ledger: [{ amountCents: 20 }],
  });
});
it("two recovery requests cannot reclaim the same live retry fence", async () => {
  const t = await setup(),
    m = t.meta();
  const digest = await hash(
    canonical({
      name: "market_lookup",
      args: { category: "coffee" },
      pricingVersion: "fixture-v1",
      price: 20,
      max: 50,
    }),
  );
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec(
      "INSERT INTO calls VALUES(?,'market_lookup','{\"category\":\"coffee\"}',?,20,'RUNNING',1,1,0,NULL,NULL,NULL)",
      m.callKey,
      digest,
    );
    s.storage.sql.exec("UPDATE session SET reserved_cents=20");
  });
  const gate = Promise.withResolvers<void>();
  let entered = 0;
  await runInDurableObject(t.stub, (i) => {
    i.executeFixture = async (n, a) => {
      entered++;
      await gate.promise;
      return fixture(n, a);
    };
  });
  const first = plain(t.stub.recover());
  await vi.waitFor(() => expect(entered).toBe(1));
  await t.stub.recover();
  expect(entered).toBe(1);
  gate.resolve();
  await first;
  expect((await t.stub.status(t.owner, t.session.sessionId)).ledger).toHaveLength(1);
});
it("frozen settlement with no provider response is read-only after restart", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/capture")) throw Error("connection failed");
    return original(input, init);
  });
  await t.stub.close(t.owner, t.session.sessionId);
  const op = await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql.exec("SELECT request_id,payload_hash,amount_cents FROM settlement").one(),
  );
  await evictDurableObject(t.stub);
  await due(t.stub);
  await t.stub.recover();
  expect(t.payment.captureCount).toBe(0);
  expect(
    await runInDurableObject(t.stub, (_i, s) =>
      s.storage.sql.exec("SELECT request_id,payload_hash,amount_cents FROM settlement").one(),
    ),
  ).toEqual(op);
});
it("throwing alarm retains watchdog; exhausted platform retries can be restored by scan", async () => {
  const t = await setup();
  await runInDurableObject(t.stub, (i) => {
    vi.spyOn(i, "flush").mockRejectedValueOnce(Error("failure"));
  });
  await expect(runDurableObjectAlarm(t.stub)).rejects.toThrow();
  expect(await runInDurableObject(t.stub, (_i, s) => s.storage.getAlarm())).not.toBeNull();
  await evictDurableObject(t.stub);
  await runInDurableObject(t.stub, (_i, s) => s.storage.deleteAlarm());
  await env.DB.prepare("UPDATE session_index SET recovery_due_at=0 WHERE session_id=?")
    .bind(t.session.sessionId)
    .run();
  await recoveryScan(env);
  expect(await runInDurableObject(t.stub, (_i, s) => s.storage.getAlarm())).not.toBeNull();
});
it("job multiplexing always arms the current minimum after duplicate scheduling", async () => {
  const t = await setup();
  await runInDurableObject(t.stub, async (i, s) => {
    const d = i as unknown as { arm(): Promise<void> };
    s.storage.sql.exec(
      "INSERT OR REPLACE INTO jobs VALUES('CALL_RECOVERY',?,0)",
      Date.now() + 1000,
    );
    await Promise.all([d.arm(), d.arm()]);
    expect(await s.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1100);
  });
});
it("backoff caps, jitter, and review budget survive an eviction", async () => {
  expect([0, 1, 2, 3, 4, 5, 6].map((n) => retryDelay("PAYMENT_RECOVERY", n, 0, 0))).toEqual([
    2000, 4000, 8000, 16000, 30000, 60000, 300000,
  ]);
  expect(retryDelay("PROJECTION", 9, 86400000, 0)).toBe(3600000);
  const t = await setup();
  t.payment.lostCapture = true;
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec(
      "INSERT OR REPLACE INTO recovery_state VALUES('PAYMENT_RECOVERY',40,0,24,0)",
    );
    s.storage.sql.exec("UPDATE session SET state='MANUAL_REVIEW'");
    s.storage.sql.exec("DELETE FROM jobs WHERE kind='PAYMENT_RECOVERY'");
  });
  await evictDurableObject(t.stub);
  const before = vi.mocked(fetch).mock.calls.length;
  await t.stub.recover();
  expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("MANUAL_REVIEW");
});
