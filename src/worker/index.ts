import { z } from "zod";
import { catalog, Fault, PRICING_VERSION, safeError } from "../domain/contracts";
import { handler } from "../mcp/server";
import { aiPlan } from "./ai";
import { authenticate, requireOperator, requireScope } from "./auth";
import { browserApi } from "./browser-api";
import { csrfProof, readSigned, visitor } from "./browser-auth";
import type { AppEnv } from "./env";
import { rateLimit, requestSubjects } from "./rate-limit";
import { openSession, recoveryScan, sessionStub } from "./service";
import { receivePayPalWebhook } from "./webhook";

export { SessionDO } from "../durable/SessionDO";
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Fault("INVALID_INPUT", 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) {
      await reader.cancel();
      throw new Fault("BODY_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Fault("INVALID_INPUT", 400);
  }
}
export default {
  async fetch(request: Request, env: AppEnv, _ctx: ExecutionContext): Promise<Response> {
    try {
      const u = new URL(request.url);
      if (
        (request.headers.has("Host") &&
          request.headers.get("Host") !== new URL(env.APP_ORIGIN).host) ||
        u.origin !== env.APP_ORIGIN
      )
        throw new Fault("FORBIDDEN", 403);
      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== env.APP_ORIGIN) throw new Fault("FORBIDDEN", 403);
      if (u.pathname === "/webhooks/paypal" && request.method === "POST")
        return json(await receivePayPalWebhook(request, env));
      const browserResponse = await browserApi(request, env, () => body(request));
      if (browserResponse) return browserResponse;
      if (u.pathname === "/paypal/return" || u.pathname === "/paypal/cancel") {
        const state = u.searchParams.get("state") ?? "";
        const bound = await readSigned(state, env.OWNER_TOKEN_SIGNING_KEY, "callback");
        const owner = await visitor(request, env);
        if (!bound?.session || !owner || bound.owner !== owner.owner)
          return new Response(
            "Return to the browser that opened your Tollbooth session. This callback does not transfer access. Open your workspace and check authorization there.",
            {
              status: 403,
              headers: {
                "Content-Type": "text/plain",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
              },
            },
          );
        const stub = sessionStub(env, bound.session);
        await stub.callback(
          owner.owner,
          bound.session,
          state,
          u.searchParams.get("token") ?? "",
          u.pathname.endsWith("cancel"),
        );
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/run/" + bound.session,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      const privatePath = u.pathname.startsWith("/api/") || u.pathname === "/mcp";
      let claims = privatePath
        ? await authenticate(request, env.OWNER_TOKEN_SIGNING_KEY)
        : undefined;
      if (privatePath && !request.headers.has("Authorization")) {
        const c = await visitor(request, env);
        if (c) {
          if (request.method !== "GET") csrfProof(request, env, c);
          claims = {
            owner: c.owner,
            exp: Math.min(c.exp, Date.now() + 3600000),
            aud: "tollbooth-client",
            scopes: ["open", "read", "call", "close"],
          };
        }
      }
      const aiMatch = /^\/api\/sessions\/([0-9a-f-]+)\/ai$/.exec(u.pathname);
      if (aiMatch) {
        if (request.method === "POST")
          await rateLimit(
            env,
            "ai",
            requestSubjects(request, requireScope(claims, "call")),
            6,
            3600000,
          );
        if (!["GET", "POST"].includes(request.method)) throw new Fault("METHOD_NOT_ALLOWED", 405);
        return json(
          await aiPlan(
            env,
            requireScope(claims, request.method === "POST" ? "call" : "read"),
            z.uuid().parse(aiMatch[1]),
            request.method === "POST",
          ),
        );
      }
      const operator = /^\/api\/operator\/sessions\/([0-9a-f-]+)(?:\/(reconcile|rebuild))?$/.exec(
        u.pathname,
      );
      if (operator) {
        const id = z.uuid().parse(operator[1]);
        const action = operator[2];
        requireOperator(
          claims,
          env.MERCHANT_ID,
          action === "reconcile" ? "reconcile" : action === "rebuild" ? "rebuild" : "read",
        );
        const row = await env.DB.prepare(
          "SELECT owner_id FROM session_index WHERE session_id=? AND merchant_id=? AND provider='sandbox'",
        )
          .bind(id, env.MERCHANT_ID)
          .first<{ owner_id: string }>();
        if (!row) throw new Fault("NOT_FOUND", 404);
        const stub = sessionStub(env, id);
        if (!action && request.method === "GET") return json(await stub.inspect(row.owner_id, id));
        if (action === "reconcile" && request.method === "POST")
          return json(await stub.reconcile(row.owner_id, id));
        if (action === "rebuild" && request.method === "POST")
          return json(await stub.rebuildProjection(row.owner_id, id));
        throw new Fault("METHOD_NOT_ALLOWED", 405);
      }
      if (u.pathname === "/api/tools" && request.method === "GET")
        return json({
          merchant: env.MERCHANT_ID,
          currency: "USD",
          pricingVersion: PRICING_VERSION,
          tools: catalog.map(({ name, priceCents, description }) => ({
            name,
            priceCents,
            description,
          })),
        });
      if (u.pathname === "/api/sessions" && request.method === "POST") {
        const owner = requireScope(claims, "open");
        await rateLimit(env, "open", requestSubjects(request, owner), 30, 3600000);
        return json(await openSession(env, owner, await body(request)));
      }
      const match = /^\/api\/sessions\/([0-9a-f-]+)(?:\/(activate|close))?$/.exec(u.pathname);
      if (match) {
        const id = z.uuid().parse(match[1]),
          action = match[2];
        const owner = requireScope(
          claims,
          action === "close" ? "close" : action === "activate" ? "open" : "read",
        );
        const stub = sessionStub(env, id);
        if (!action && request.method === "GET") return json(await stub.status(owner, id));
        if (action === "activate" && request.method === "POST")
          return json(await stub.activate(owner, id));
        if (action === "close" && request.method === "POST")
          return json(await stub.close(owner, id));
        throw new Fault("METHOD_NOT_ALLOWED", 405);
      }
      if (u.pathname === "/mcp") {
        if (request.method === "GET" || request.method === "DELETE")
          return json({ code: "METHOD_NOT_ALLOWED" }, 405);
        if (request.method !== "POST") throw new Fault("METHOD_NOT_ALLOWED", 405);
        const parsed = await body(request);
        if (
          parsed &&
          typeof parsed === "object" &&
          "method" in parsed &&
          parsed.method === "tools/call" &&
          "params" in parsed &&
          (parsed.params as { name?: string })?.name === "tollbooth_open"
        )
          await rateLimit(
            env,
            "open",
            requestSubjects(request, requireScope(claims, "open")),
            30,
            3600000,
          );
        const response = await handler(env, claims, parsed).fetch(request, { parsedBody: parsed });
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      }
      if (
        u.pathname.startsWith("/api/") ||
        u.pathname.startsWith("/webhooks/") ||
        u.pathname.startsWith("/paypal/")
      )
        return json({ code: "NOT_FOUND" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      const error = e instanceof z.ZodError ? { code: "INVALID_INPUT", status: 400 } : safeError(e);
      const response = json(error, error.status);
      if (error.status === 429)
        response.headers.set(
          "Retry-After",
          String(
            Math.max(
              1,
              Math.ceil((e instanceof Fault && e.retryAfterMs ? e.retryAfterMs : 3600000) / 1000),
            ),
          ),
        );
      return response;
    }
  },
  async scheduled(_controller: ScheduledController, env: AppEnv) {
    await recoveryScan(env);
  },
} satisfies ExportedHandler<AppEnv>;
