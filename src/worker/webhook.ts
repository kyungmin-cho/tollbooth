import { z } from "zod";
import { Fault, hash } from "../domain/contracts";
import { PayPal } from "../payments/paypal";
import type { Registration } from "../shared/types";
import { eventTypes, linkedCapture, noticeSchema, type VerifiedNotice } from "../shared/webhook";
import type { AppEnv } from "./env";
import { sessionStub } from "./service";

const eventSchema = z.object({
  id: z.string().min(1).max(128),
  event_type: z.enum(eventTypes),
  resource: z.object({
    id: z.string().min(1).max(128),
    custom_id: z.string().optional(),
    invoice_id: z.string().optional(),
    links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
    supplementary_data: z
      .object({
        related_ids: z.object({
          order_id: z.string().optional(),
          authorization_id: z.string().optional(),
          capture_id: z.string().optional(),
        }),
      })
      .optional(),
    purchase_units: z.array(z.object({ custom_id: z.string().optional() })).optional(),
  }),
});
async function route(env: AppEnv, n: VerifiedNotice) {
  const r = await env.DB.prepare(
    `SELECT * FROM session_index WHERE merchant_id=? AND provider='sandbox' AND (session_id=? OR order_id=? OR authorization_id=? OR session_id IN(SELECT session_id FROM charge_projection WHERE capture_id=?)) LIMIT 2`,
  )
    .bind(env.MERCHANT_ID, n.sessionId, n.orderId, n.authorizationId, n.captureId ?? n.resourceId)
    .all<Registration>();
  if (r.results.length !== 1) return false;
  const target = r.results[0];
  // No initialize here: a webhook can never create a session or an order.
  await sessionStub(env, target.session_id).receiveWebhook(n);
  return true;
}
export async function receivePayPalWebhook(request: Request, env: AppEnv) {
  if (!env.PAYPAL_WEBHOOK_ID) throw new Fault("WEBHOOK_UNAVAILABLE", 503);
  const reader = request.body?.getReader();
  if (!reader) throw new Fault("INVALID_INPUT", 400);
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 262144) {
      await reader.cancel();
      throw new Fault("BODY_TOO_LARGE", 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  let raw: string;
  let event: unknown;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    event = JSON.parse(raw);
  } catch {
    throw new Fault("INVALID_INPUT", 400);
  }
  await new PayPal(env).verifyWebhook(request.headers, event, env.PAYPAL_WEBHOOK_ID);
  const e = eventSchema.parse(event),
    r = e.resource,
    ids = r.supplementary_data?.related_ids;
  const candidate = r.custom_id ?? r.invoice_id ?? r.purchase_units?.[0]?.custom_id;
  const n = noticeSchema.parse({
    eventId: e.id,
    eventType: e.event_type,
    resourceId: r.id,
    bodyHash: await hash(raw),
    sessionId: z.uuid().safeParse(candidate).success ? candidate : null,
    orderId: e.event_type.startsWith("CHECKOUT.ORDER.") ? r.id : (ids?.order_id ?? null),
    authorizationId: e.event_type.startsWith("PAYMENT.AUTHORIZATION.")
      ? r.id
      : (ids?.authorization_id ?? null),
    captureId:
      e.event_type === "PAYMENT.CAPTURE.REFUNDED"
        ? (ids?.capture_id ?? linkedCapture(r.links))
        : e.event_type.startsWith("PAYMENT.CAPTURE.")
          ? r.id
          : null,
  });
  try {
    // Durable ingress deduplication also covers before-mapping delivery and ACK loss.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_pending(event_id,event_type,resource_id,body_hash,metadata_json,received_at,next_attempt_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        n.eventId,
        n.eventType,
        n.resourceId,
        n.bodyHash,
        JSON.stringify(n),
        Date.now(),
        Date.now(),
      )
      .run();
    const prior = await env.DB.prepare(
      "SELECT body_hash,status FROM webhook_pending WHERE event_id=?",
    )
      .bind(n.eventId)
      .first<{ body_hash: string; status: string }>();
    if (prior?.body_hash !== n.bodyHash) {
      await env.DB.prepare("UPDATE webhook_pending SET status='CONFLICT' WHERE event_id=?")
        .bind(n.eventId)
        .run();
      throw new Fault("WEBHOOK_CONFLICT", 409);
    }
    if (prior.status === "CONFLICT") throw new Fault("WEBHOOK_CONFLICT", 409);
    if (prior.status === "PENDING" && (await route(env, n)))
      await env.DB.prepare(
        "UPDATE webhook_pending SET status='DELIVERED' WHERE event_id=? AND status='PENDING'",
      )
        .bind(n.eventId)
        .run();
  } catch (e) {
    if (e instanceof Fault && e.code === "WEBHOOK_CONFLICT") throw e;
    if (n.sessionId) {
      try {
        await sessionStub(env, n.sessionId).receiveWebhook(n);
        return { accepted: true };
      } catch {
        /* Neither durable ingress path succeeded. */
      }
    }
    throw new Fault("WEBHOOK_UNAVAILABLE", 503);
  }
  return { accepted: true };
}
export async function replayWebhooks(env: AppEnv) {
  const rows = await env.DB.prepare(
    "SELECT event_id,metadata_json,attempts FROM webhook_pending WHERE status='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 20",
  )
    .bind(Date.now())
    .all<{ event_id: string; metadata_json: string; attempts: number }>();
  for (const row of rows.results) {
    try {
      if (await route(env, noticeSchema.parse(JSON.parse(row.metadata_json)))) {
        await env.DB.prepare(
          "UPDATE webhook_pending SET status='DELIVERED' WHERE event_id=? AND status='PENDING'",
        )
          .bind(row.event_id)
          .run();
        continue;
      }
    } catch {
      /* Durable metadata remains retryable. */
    }
    await env.DB.prepare(
      "UPDATE webhook_pending SET attempts=attempts+1,next_attempt_at=? WHERE event_id=? AND status='PENDING'",
    )
      .bind(Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(row.attempts, 10)), row.event_id)
      .run();
  }
}
