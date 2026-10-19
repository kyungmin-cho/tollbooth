import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { aiInput, aiPlan, parsePlan } from "../../src/worker/ai";
import { setup } from "../helpers";

const response = {
  choices: [
    {
      message: {
        tool_calls: [
          { function: { name: "market_lookup", arguments: '{"category":"coffee"}' } },
          { function: { name: "landed_cost", arguments: '{"itemUsd":45,"destination":"KR"}' } },
          { function: { name: "landed_cost", arguments: '{"itemUsd":45,"destination":"JP"}' } },
        ],
      },
    },
  ],
};
it("real binding boundary validates catalog tools and fixed identities without secrets in context", () => {
  const p = parsePlan(response);
  expect(p.calls.map((c) => c.price)).toEqual([20, 35, 35]);
  expect(p.calls.map((c) => c.key)).toEqual(["ai-v1-0", "ai-v1-1", "ai-v1-2"]);
  expect(JSON.stringify(aiInput).length).toBeLessThan(4096);
  expect(aiInput.max_completion_tokens).toBe(768);
  expect(JSON.stringify(aiInput)).not.toContain("sessionId");
});
it.each(["unknown", "invalid arguments", "extra call", "wrong mission"])(
  "rejects model %s without repairing the answer",
  (kind) => {
    const r = structuredClone(response);
    if (kind === "unknown") r.choices[0].message.tool_calls[0].function.name = "tollbooth_close";
    if (kind === "invalid arguments")
      r.choices[0].message.tool_calls[0].function.arguments = '{"category":"coffee","secret":"x"}';
    if (kind === "extra call")
      r.choices[0].message.tool_calls.push(r.choices[0].message.tool_calls[0]);
    if (kind === "wrong mission")
      r.choices[0].message.tool_calls[0].function.arguments = '{"category":"outdoor"}';
    expect(() => parsePlan(r)).toThrow();
  },
);
it("concurrent starts reserve one inference, owner isolation and lost response retry return stored identity", async () => {
  const t = await setup(500, false);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = vi.fn(async () => {
    await gate;
    return response;
  });
  const e = { ...env, AI: { run } };
  const first = aiPlan(e, t.owner, t.session.sessionId, true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect((await aiPlan(e, t.owner, t.session.sessionId, true))?.status).toBe("PENDING");
  await expect(aiPlan(e, "other", t.session.sessionId, true)).rejects.toThrow("NOT_FOUND");
  release();
  const plan = await first;
  expect(await aiPlan(e, t.owner, t.session.sessionId, true)).toEqual(plan);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await t.stub.status(t.owner, t.session.sessionId)).usedCents).toBe(0);
  expect(t.payment.authorizeCount).toBe(0);
});
it("provider exhaustion is explicitly fallback and never retries or spends", async () => {
  const t = await setup(500, false),
    run = vi.fn(async () => {
      throw Error("provider private error");
    });
  const e = { ...env, AI: { run } };
  const p = await aiPlan(e, t.owner, t.session.sessionId, true);
  expect(p).toMatchObject({ status: "FALLBACK", calls: [] });
  expect(JSON.stringify(p)).not.toContain("private");
  expect(await aiPlan(e, t.owner, t.session.sessionId, true)).toEqual(p);
  expect(run).toHaveBeenCalledTimes(1);
  expect(t.payment.authorizeCount).toBe(0);
});
it("crashed inference is terminal after deadline; late success cannot replace fallback", async () => {
  const t = await setup(500, false);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = vi.fn(async () => {
    await gate;
    return response;
  });
  const e = { ...env, AI: { run } },
    first = aiPlan(e, t.owner, t.session.sessionId, true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await env.DB.prepare("UPDATE ai_runs SET created_at=? WHERE session_id=?")
    .bind(Date.now() - 100000, t.session.sessionId)
    .run();
  expect(await aiPlan(e, t.owner, t.session.sessionId)).toMatchObject({
    status: "FALLBACK",
    reason: "AI_INTERRUPTED",
  });
  release();
  expect(await first).toMatchObject({ status: "FALLBACK" });
});
it("closed sessions cannot initiate inference", async () => {
  const t = await setup();
  await t.stub.close(t.owner, t.session.sessionId);
  const run = vi.fn();
  await expect(aiPlan({ ...env, AI: { run } }, t.owner, t.session.sessionId, true)).rejects.toThrow(
    "SESSION_CLOSING",
  );
  expect(run).not.toHaveBeenCalled();
});
it.each(["owner", "global"])(
  "atomic %s admission limit blocks concurrent extra inference",
  async (scope) => {
    const t = await setup(500, false),
      day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM ai_runs").run();
    const count = scope === "owner" ? 3 : 20;
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO session_index(session_id,owner_id,merchant_id,creation_key,creation_hash,budget_cents,pricing_version,created_at,approval_deadline,recovery_due_at) VALUES(?,?,?,?,?,500,'fixture-v1',0,0,0)",
      )
        .bind(id, t.owner, env.MERCHANT_ID, id, id)
        .run();
      await env.DB.prepare("INSERT INTO ai_runs VALUES(?,?,?,?,'PENDING',NULL,NULL)")
        .bind(id, scope === "owner" ? t.owner : "other", day, Date.now())
        .run();
    }
    const run = vi.fn(async () => response),
      e = { ...env, AI: { run } };
    const results = await Promise.all([
      aiPlan(e, t.owner, t.session.sessionId, true),
      aiPlan(e, t.owner, t.session.sessionId, true),
    ]);
    expect(results.every((p) => p?.status === "FALLBACK" && p.reason === "AI_DAILY_LIMIT")).toBe(
      true,
    );
    expect(run).not.toHaveBeenCalled();
    // UTC reset: old slots no longer admit against today's budget.
    await env.DB.prepare("UPDATE ai_runs SET quota_day='2000-01-01'").run();
    expect((await aiPlan(e, t.owner, t.session.sessionId, true))?.status).toBe("READY");
    expect(run).toHaveBeenCalledTimes(1);
  },
);
it("Free allocation exhaustion is identified without retaining provider details", async () => {
  const t = await setup(500, false);
  const p = await aiPlan(
    {
      ...env,
      AI: {
        run: async () => {
          throw Error("3036 account limited private details");
        },
      },
    },
    t.owner,
    t.session.sessionId,
    true,
  );
  expect(p).toEqual({
    status: "FALLBACK",
    model: "@cf/zai-org/glm-4.7-flash",
    calls: [],
    reason: "AI_FREE_ALLOCATION_EXHAUSTED",
  });
});
