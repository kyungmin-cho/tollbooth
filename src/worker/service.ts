import { canonical, Fault, hash, openSchema, PRICING_VERSION } from "../domain/contracts";
import type { Registration } from "../shared/types";
import type { AppEnv } from "./env";
import { replayWebhooks } from "./webhook";
export function sessionStub(env: AppEnv, id: string) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(`${env.ENVIRONMENT}:${env.MERCHANT_ID}:${id}`));
}
export async function openSession(env: AppEnv, owner: string, input: unknown) {
  const data = openSchema.parse(input);
  const digest = await hash(
    canonical({
      budget: data.budgetCents,
      provider: "sandbox",
      merchant: env.MERCHANT_ID,
      pricingVersion: PRICING_VERSION,
      mode: "authorize",
    }),
  );
  const id = crypto.randomUUID(),
    now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000;
  await env.DB.prepare(`INSERT OR IGNORE INTO session_index(session_id,owner_id,merchant_id,creation_key,creation_hash,budget_cents,pricing_version,created_at,approval_deadline,recovery_due_at)
  SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM session_index WHERE created_at>=?)<100 AND (SELECT count(*) FROM session_index WHERE owner_id=? AND created_at>=?)<5`)
    .bind(
      id,
      owner,
      env.MERCHANT_ID,
      data.creationKey,
      digest,
      data.budgetCents,
      PRICING_VERSION,
      now,
      now + 1800000,
      now,
      day,
      owner,
      now - 3600000,
    )
    .run();
  const r = await env.DB.prepare("SELECT * FROM session_index WHERE owner_id=? AND creation_key=?")
    .bind(owner, data.creationKey)
    .first<Registration>();
  if (!r) throw new Fault("ADMISSION_LIMIT", 429);
  if (r.creation_hash !== digest) throw new Fault("IDEMPOTENCY_CONFLICT");
  return sessionStub(env, r.session_id).initialize(r);
}
export async function recoveryScan(env: AppEnv) {
  const rows = await env.DB.prepare(
    "SELECT * FROM session_index WHERE recovery_due_at<=? ORDER BY recovery_due_at,session_id LIMIT 20",
  )
    .bind(Date.now())
    .all<Registration>();
  for (const r of rows.results) {
    try {
      const stub = sessionStub(env, r.session_id);
      await stub.initialize(r);
      await stub.recover();
    } catch {
      // Isolate an unavailable object; its durable anchor remains retryable.
    }
    // Also advance unchanged healthy rows. Preserve newer future/terminal deadlines.
    await env.DB.prepare(
      "UPDATE session_index SET recovery_due_at=? WHERE session_id=? AND recovery_due_at<=?",
    )
      .bind(Date.now() + 300000, r.session_id, Date.now())
      .run();
  }
  await replayWebhooks(env);
}
