import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { openSession, recoveryScan, sessionStub } from "../../src/worker/service";
import { paypalFake } from "../fixtures/paypal";
import { setup } from "../helpers";

it("D1 batch failure rolls back session, charge, usage and receipt together", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  const before = await env.DB.prepare("SELECT * FROM session_projection WHERE session_id=?")
    .bind(t.session.sessionId)
    .first();
  await env.DB.exec(
    "CREATE TRIGGER projection_failure BEFORE INSERT ON charge_projection BEGIN SELECT RAISE(ABORT,'batch failure'); END",
  );
  await t.stub.close(t.owner, t.session.sessionId);
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("CAPTURED");
  expect(
    await env.DB.prepare("SELECT * FROM session_projection WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toEqual(before);
  await env.DB.exec("DROP TRIGGER projection_failure");
  await t.stub.flush();
  expect(
    await env.DB.prepare("SELECT amount_cents,status FROM charge_projection WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toMatchObject({ amount_cents: 20, status: "SUCCEEDED" });
});
it("D1 batch commit before DO ACK loss replays complete snapshots without double gross or usage", async () => {
  const t = await setup();
  await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql
      .exec(
        "CREATE TRIGGER ack_failure BEFORE UPDATE OF delivered_at ON outbox BEGIN SELECT RAISE(ABORT,'ack lost'); END",
      )
      .toArray(),
  );
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  const before = await env.DB.prepare("SELECT * FROM charge_projection WHERE session_id=?")
    .bind(t.session.sessionId)
    .first();
  await evictDurableObject(t.stub);
  await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql.exec("DROP TRIGGER ack_failure").toArray(),
  );
  await t.stub.flush();
  await t.stub.flush();
  expect(
    await env.DB.prepare("SELECT * FROM charge_projection WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n,sum(amount_cents) total FROM usage_projection WHERE session_id=?",
    )
      .bind(t.session.sessionId)
      .first(),
  ).toMatchObject({ n: 1, total: 20 });
  expect(
    await runInDurableObject(
      t.stub,
      (_i, s) =>
        s.storage.sql.exec("SELECT count(*) n FROM outbox WHERE delivered_at IS NULL").one().n,
    ),
  ).toBe(0);
});
it("index-driven projection rebuild preserves provider resources and absolute totals", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  for (const table of ["session_projection", "charge_projection", "usage_projection"])
    await env.DB.prepare(`DELETE FROM ${table} WHERE session_id=?`).bind(t.session.sessionId).run();
  await t.stub.rebuildProjection(t.owner, t.session.sessionId);
  expect(
    (
      await env.DB.prepare("SELECT captured_cents FROM session_projection WHERE session_id=?")
        .bind(t.session.sessionId)
        .first()
    )?.captured_cents,
  ).toBe(20);
  expect(
    await env.DB.prepare("SELECT order_id,authorization_id FROM session_index WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toMatchObject({ order_id: t.payment.orderId, authorization_id: t.payment.authId });
  expect(t.payment.captureCount).toBe(1);
});
it("out-of-order replay cannot regress charge or recovery mapping", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  const before = await env.DB.prepare("SELECT * FROM session_index WHERE session_id=?")
    .bind(t.session.sessionId)
    .first();
  const charge = await env.DB.prepare("SELECT * FROM charge_projection WHERE session_id=?")
    .bind(t.session.sessionId)
    .first();
  await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql.exec("UPDATE outbox SET delivered_at=NULL WHERE session_version=1").toArray(),
  );
  await t.stub.flush();
  expect(
    await env.DB.prepare("SELECT * FROM session_index WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare("SELECT * FROM charge_projection WHERE session_id=?")
      .bind(t.session.sessionId)
      .first(),
  ).toEqual(charge);
});
async function anchor(owner: string, created: number, valid = true) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO session_index(session_id,owner_id,merchant_id,creation_key,creation_hash,budget_cents,pricing_version,created_at,approval_deadline,recovery_due_at) VALUES(?,?,?,?,?,500,?,?,?,0)",
  )
    .bind(
      id,
      owner,
      env.MERCHANT_ID,
      id,
      "hash",
      valid ? "fixture-v1" : "bad-version",
      created,
      created + 1800000,
    )
    .run();
  return id;
}
it("an unchanged healthy anchor advances without starving later scans", async () => {
  const t = await setup();
  await env.DB.exec("UPDATE session_index SET recovery_due_at=9007199254740991");
  await env.DB.prepare("UPDATE session_index SET recovery_due_at=0 WHERE session_id=?")
    .bind(t.session.sessionId)
    .run();
  await recoveryScan(env);
  const r = await env.DB.prepare("SELECT recovery_due_at FROM session_index WHERE session_id=?")
    .bind(t.session.sessionId)
    .first<{ recovery_due_at: number }>();
  expect(r?.recovery_due_at).toBeGreaterThan(Date.now());
  expect(
    (await sessionStub(env, t.session.sessionId).status(t.owner, t.session.sessionId)).state,
  ).toBe("ACTIVE");
  expect(t.payment.captureCount).toBe(0);
});
it("concurrent daily admission cap admits only one final slot", async () => {
  const p = paypalFake();
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT count(*) n FROM session_index").first<{
    n: number;
  }>();
  for (let i = existing?.n ?? 0; i < 99; i++) await anchor(crypto.randomUUID(), now);
  const results = await Promise.allSettled([
    openSession(env, crypto.randomUUID(), { budgetCents: 500, creationKey: "last-a" }),
    openSession(env, crypto.randomUUID(), { budgetCents: 500, creationKey: "last-b" }),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(p.createCount).toBe(1);
  expect((await env.DB.prepare("SELECT count(*) n FROM session_index").first())?.n).toBe(100);
});
it("per-owner admission cap and failed initialization still consume slots", async () => {
  const p = paypalFake(),
    owner = crypto.randomUUID();
  for (let i = 0; i < 5; i++) await anchor(owner, Date.now(), false);
  await expect(openSession(env, owner, { budgetCents: 500, creationKey: "sixth" })).rejects.toThrow(
    "ADMISSION_LIMIT",
  );
  expect(p.createCount).toBe(0);
});
it("one bad recovery anchor cannot starve later rows, and a scan is bounded to twenty", async () => {
  paypalFake();
  await env.DB.exec("UPDATE session_index SET recovery_due_at=9007199254740991");
  const bad = await anchor(crypto.randomUUID(), 0, false);
  await env.DB.prepare("UPDATE session_index SET recovery_due_at=-1 WHERE session_id=?")
    .bind(bad)
    .run();
  for (let i = 0; i < 20; i++) await anchor(crypto.randomUUID(), 0);
  await recoveryScan(env);
  const rows = await env.DB.prepare(
    "SELECT count(*) n FROM session_projection WHERE state='EXPIRED'",
  ).first();
  expect(rows?.n).toBe(19);
  await recoveryScan(env);
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM session_projection WHERE state='EXPIRED'",
      ).first()
    )?.n,
  ).toBe(20);
});
