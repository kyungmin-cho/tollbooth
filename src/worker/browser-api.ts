import { z } from "zod";
import { callMetaSchema, Fault, hash } from "../domain/contracts";
import { demoPage } from "../shared/demo";
import { signAccess } from "./auth";
import {
  cookie,
  csrfProof,
  merchant,
  originProof,
  secretMatches,
  signBrowser,
  visitor,
} from "./browser-auth";
import type { AppEnv } from "./env";
import { rateLimit, requestSubjects } from "./rate-limit";
import { sessionStub } from "./service";

const loginSchema = z.strictObject({ secret: z.string().max(512) });
const callSchema = z.strictObject({
  name: z.enum(["market_lookup", "landed_cost"]),
  args: z.record(z.string(), z.unknown()),
  meta: callMetaSchema,
});
const states = new Set([
  "CREATED",
  "APPROVAL_PENDING",
  "AUTHORIZING",
  "ACTIVE",
  "CLOSING",
  "SETTLING",
  "RECONCILING",
  "CAPTURED",
  "VOIDED",
  "EXPIRED",
  "MANUAL_REVIEW",
]);
function reply(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}
export async function browserApi(
  request: Request,
  env: AppEnv,
  read: () => Promise<unknown>,
): Promise<Response | undefined> {
  const u = new URL(request.url),
    path = u.pathname;
  if (path === "/health") return reply({ status: "ok", build: "M5" });
  if (path === "/api/demo/merchant" && request.method === "GET") return reply(demoPage());
  if (path === "/api/visitor" && request.method === "POST") {
    originProof(request, env);
    const c = (await visitor(request, env)) ?? {
      aud: "visitor" as const,
      owner: crypto.randomUUID(),
      csrf: crypto.randomUUID(),
      exp: Date.now() + 90 * 86400000,
    };
    return reply({ csrf: c.csrf }, 200, {
      "Set-Cookie": cookie(
        "tb_owner",
        await signBrowser(c, env.OWNER_TOKEN_SIGNING_KEY),
        90 * 86400,
        env,
      ),
    });
  }
  if (path === "/api/client-access" && request.method === "POST") {
    const c = await visitor(request, env);
    csrfProof(request, env, c);
    const input = z.strictObject({ confirmed: z.literal(true) }).parse(await read());
    if (!input.confirmed || !c) throw new Fault("FORBIDDEN", 403);
    const exp = Date.now() + 3600000;
    return reply({
      credential: await signAccess(
        { owner: c.owner, exp, aud: "tollbooth-client", scopes: ["open", "read", "call", "close"] },
        env.OWNER_TOKEN_SIGNING_KEY,
      ),
      expiresAt: exp,
    });
  }
  const paid = /^\/api\/sessions\/([0-9a-f-]+)\/call$/.exec(path);
  if (paid && request.method === "POST") {
    const c = await visitor(request, env);
    csrfProof(request, env, c);
    const data = callSchema.parse(await read());
    if (!c || data.meta.sessionId !== paid[1]) throw new Fault("FORBIDDEN", 403);
    return reply(await sessionStub(env, paid[1]).call(c.owner, data.name, data.args, data.meta));
  }
  if (path === "/api/merchant/login" && request.method === "POST") {
    const v = await visitor(request, env);
    csrfProof(request, env, v);
    if (
      !env.MERCHANT_ADMIN_TOKEN ||
      env.MERCHANT_ADMIN_TOKEN.length < 32 ||
      !env.MERCHANT_COOKIE_SIGNING_KEY
    )
      throw new Fault("MERCHANT_ACCESS_UNAVAILABLE", 503);
    const { secret } = loginSchema.parse(await read());
    const now = Date.now();
    await rateLimit(env, "login", requestSubjects(request, v!.owner), 5, 600000);
    if (!(await secretMatches(secret, env.MERCHANT_ADMIN_TOKEN)))
      throw new Fault("UNAUTHENTICATED", 401);
    const c = {
      aud: "merchant" as const,
      owner: crypto.randomUUID(),
      csrf: crypto.randomUUID(),
      exp: now + 3600000,
      merchant: env.MERCHANT_ID,
      version: await hash(env.MERCHANT_ADMIN_TOKEN),
    };
    return reply({ csrf: c.csrf }, 200, {
      "Set-Cookie": cookie(
        "tb_merchant",
        await signBrowser(c, env.MERCHANT_COOKIE_SIGNING_KEY),
        3600,
        env,
        true,
      ),
    });
  }
  if (!path.startsWith("/api/merchant/")) return;
  const c = await merchant(request, env);
  if (path === "/api/merchant/access" && request.method === "GET") return reply({ csrf: c.csrf });
  if (request.method !== "GET") csrfProof(request, env, c);
  if (path === "/api/merchant/logout" && request.method === "POST")
    return reply({ ok: true }, 200, { "Set-Cookie": cookie("tb_merchant", "", 0, env, true) });
  const detail = /^\/api\/merchant\/sessions\/([0-9a-f-]+)(\/reconcile)?$/.exec(path);
  if (detail) {
    const id = z.uuid().parse(detail[1]);
    const row = await env.DB.prepare(
      "SELECT owner_id FROM session_index WHERE session_id=? AND merchant_id=? AND provider='sandbox'",
    )
      .bind(id, env.MERCHANT_ID)
      .first<{ owner_id: string }>();
    if (!row) throw new Fault("NOT_FOUND", 404);
    const stub = sessionStub(env, id);
    if (detail[2]) {
      if (request.method !== "POST") throw new Fault("METHOD_NOT_ALLOWED", 405);
      await stub.reconcile(row.owner_id, id);
    } else if (request.method !== "GET") throw new Fault("METHOD_NOT_ALLOWED", 405);
    const direct = await stub.inspect(row.owner_id, id);
    direct.snapshot.approvalUrl = null;
    const projection = await env.DB.prepare(
      "SELECT version,projected_at AS projectedAt,state,used_cents AS usedCents,captured_cents AS capturedCents FROM session_projection WHERE session_id=?",
    )
      .bind(id)
      .first();
    return reply({ ...direct, projection, checkedAt: Date.now() });
  }
  if (
    !["/api/merchant/summary", "/api/merchant/sessions", "/api/merchant/charges"].includes(path) ||
    request.method !== "GET"
  )
    throw new Fault("NOT_FOUND", 404);
  const now = Date.now(),
    from = Number(u.searchParams.get("from") ?? now - 7 * 86400000),
    to = Number(u.searchParams.get("to") ?? now + 1);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to - from > 90 * 86400000
  )
    throw new Fault("INVALID_INPUT", 400);
  const state = u.searchParams.get("state") ?? "",
    search = u.searchParams.get("search") ?? "";
  if ((state && !states.has(state)) || !/^[a-zA-Z0-9-]{0,64}$/.test(search))
    throw new Fault("INVALID_INPUT", 400);
  const base =
    " FROM session_index i JOIN session_projection p ON p.session_id=i.session_id LEFT JOIN charge_projection c ON c.session_id=i.session_id WHERE i.merchant_id=? AND i.provider='sandbox' AND i.created_at>=? AND i.created_at<? AND (?='' OR p.state=?) AND i.session_id LIKE ?";
  const values = [env.MERCHANT_ID, from, to, state, state, `%${search}%`];
  const summary = await env.DB.prepare(
    "SELECT coalesce(sum(p.captured_cents),0) capturedCents,coalesce(sum(p.used_cents),0) usedCents,coalesce(sum(p.state='ACTIVE'),0) active,coalesce(sum(p.state IN ('MANUAL_REVIEW','RECONCILING')),0) review,count(*) count" +
      base,
  )
    .bind(...values)
    .first();
  const cursor = u.searchParams.get("cursor");
  let extra = "",
    args: (string | number)[] = [];
  if (cursor) {
    const [t, id] = cursor.split(".");
    if (!/^\d+$/.test(t) || !z.uuid().safeParse(id).success) throw new Fault("INVALID_INPUT", 400);
    extra = " AND (i.created_at<? OR (i.created_at=? AND i.session_id<?))";
    args = [Number(t), Number(t), id];
  }
  if (path.endsWith("/charges")) extra += " AND c.session_id IS NOT NULL";
  const rows = await env.DB.prepare(
    `SELECT i.session_id sessionId,i.created_at createdAt,i.budget_cents budgetCents,p.state,p.version,p.used_cents usedCents,p.reserved_cents reservedCents,p.captured_cents capturedCents,i.budget_cents-p.used_cents-p.reserved_cents availableCents,p.projected_at projectedAt,json_array_length(json_extract(p.snapshot_json,'$.ledger')) calls,json_extract(p.snapshot_json,'$.errorCode') errorCode,c.capture_id captureId,c.kind,c.status,c.amount_cents amountCents,c.release_evidence releaseEvidence` +
      base +
      extra +
      " ORDER BY i.created_at DESC,i.session_id DESC LIMIT 101",
  )
    .bind(...values, ...args)
    .all();
  const page = rows.results.slice(0, 100),
    last = page.at(-1);
  return reply({
    rows: page,
    summary,
    nextCursor: rows.results.length > 100 && last ? `${last.createdAt}.${last.sessionId}` : null,
    at: now,
  });
}
