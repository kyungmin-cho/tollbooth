import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { openSession, recoveryScan } from "../../src/worker/service";
import { paypalFake } from "../fixtures/paypal";
import { setup } from "../helpers";

it.each([0, -1, 49, 501, 1.5, NaN, Infinity])(
  "T11-T17 admission budget %s never creates provider order",
  async (budget) => {
    const p = paypalFake();
    await expect(
      openSession(env, crypto.randomUUID(), { budgetCents: budget, creationKey: "invalid" }),
    ).rejects.toThrow();
    expect(p.createCount).toBe(0);
  },
);
it("D1 admission outage fails before order, existing DO spending stays authoritative", async () => {
  const t = await setup();
  await env.DB.exec("ALTER TABLE session_index RENAME TO unavailable_index");
  try {
    await expect(
      openSession(env, crypto.randomUUID(), { budgetCents: 500, creationKey: "new" }),
    ).rejects.toThrow();
    expect(t.payment.createCount).toBe(1);
    expect(
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta()),
    ).toMatchObject({ usedCents: 20 });
    const n = await runInDurableObject(
      t.stub,
      (_i, s) =>
        s.storage.sql.exec("SELECT count(*) AS n FROM outbox WHERE delivered_at IS NULL").one().n,
    );
    expect(n).toBeGreaterThan(0);
  } finally {
    await env.DB.exec("ALTER TABLE unavailable_index RENAME TO session_index");
  }
  await t.stub.flush();
  expect(
    (
      await env.DB.prepare("SELECT used_cents FROM session_projection WHERE session_id=?")
        .bind(t.session.sessionId)
        .first()
    )?.used_cents,
  ).toBe(20);
});
it("recovery index restores missing alarm without browser lifetime", async () => {
  const t = await setup();
  await runInDurableObject(t.stub, async (_i, s) => {
    await s.storage.deleteAlarm();
  });
  await env.DB.prepare("UPDATE session_index SET recovery_due_at=0 WHERE session_id=?")
    .bind(t.session.sessionId)
    .run();
  await recoveryScan(env);
  expect(await runInDurableObject(t.stub, (_i, s) => s.storage.getAlarm())).not.toBeNull();
});
it("durable jobs survive eviction and duplicate alarms do not settle twice", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("UPDATE session SET idle_deadline=0");
  });
  await evictDurableObject(t.stub);
  await runDurableObjectAlarm(t.stub);
  await t.stub.recover();
  await t.stub.recover();
  expect(t.payment.captureCount).toBe(1);
  expect((await t.stub.status(t.owner, t.session.sessionId)).capturedCents).toBe(20);
});
it("simultaneous identical admissions have a single anchor and one order", async () => {
  const p = paypalFake(),
    owner = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      openSession(env, owner, { budgetCents: 500, creationKey: "same" }),
    ),
  );
  expect(new Set(results.map((r) => r.sessionId)).size).toBe(1);
  expect(p.createCount).toBe(1);
  expect(
    (
      await env.DB.prepare("SELECT count(*) AS n FROM session_index WHERE owner_id=?")
        .bind(owner)
        .first()
    )?.n,
  ).toBe(1);
});
it("repeated activation does not extend hard or idle deadlines", async () => {
  const t = await setup();
  const before = await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql.exec("SELECT hard_deadline,idle_deadline FROM session").one(),
  );
  await Promise.all([
    t.stub.activate(t.owner, t.session.sessionId),
    t.stub.activate(t.owner, t.session.sessionId),
  ]);
  expect(
    await runInDurableObject(t.stub, (_i, s) =>
      s.storage.sql.exec("SELECT hard_deadline,idle_deadline FROM session").one(),
    ),
  ).toEqual(before);
  expect(t.payment.authorizeCount).toBe(1);
});

it("T03 twenty synthetic seven-cent reservations produce exactly 140 ledger cents", async () => {
  const contracts = await import("../../src/domain/contracts");
  const original = contracts.quote;
  const { vi } = await import("vitest");
  const mock = vi
    .spyOn(contracts, "quote")
    .mockImplementation((name) => ({ ...original(name), priceCents: 7 }));
  try {
    const t = await setup();
    for (let i = 0; i < 20; i++)
      await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta(`seven-${i}`));
    const s = await t.stub.status(t.owner, t.session.sessionId);
    expect(s.usedCents).toBe(140);
    expect(s.ledger).toHaveLength(20);
    expect(s.ledger.reduce((sum, row) => sum + row.amountCents, 0)).toBe(140);
    expect(s.reservedCents).toBe(0);
  } finally {
    mock.mockRestore();
  }
});
