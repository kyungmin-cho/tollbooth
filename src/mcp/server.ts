import {
  type CallToolResult,
  McpServer,
  type StandardSchemaWithJSON,
  specTypeSchemas,
  type Tool,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  callMetaSchema,
  catalog,
  Fault,
  openSchema,
  PRICING_VERSION,
  safeError,
} from "../domain/contracts";
import { type Claims, requireScope } from "../worker/auth";
import type { AppEnv } from "../worker/env";
import { openSession, sessionStub } from "../worker/service";

// Cache only immutable schemas, never request principals or mutable MCP servers.
function cachedSchema<T extends z.ZodType>(
  schema: T,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const input = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });
  const output = z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" });
  return {
    "~standard": {
      ...schema["~standard"],
      jsonSchema: { input: () => input, output: () => output },
    },
  } as StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}
const toolSchemas = new Map(catalog.map((t) => [t.name, cachedSchema(t.schema)]));
const sessionSchema = cachedSchema(z.strictObject({ sessionId: z.uuid() }));
const openingSchema = cachedSchema(openSchema);
// Immutable catalog projection: no per-request schema conversion or list allocation.
const listedTools: { tools: Tool[] } = {
  tools: [
    ...catalog.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, {
        io: "input",
        target: "draft-2020-12",
      }) as Tool["inputSchema"],
    })),
    {
      name: "tollbooth_open",
      description:
        "Explicitly open a USD wallet authorization session. Human approval required; no prepaid mode.",
      inputSchema: z.toJSONSchema(openSchema, {
        io: "input",
        target: "draft-2020-12",
      }) as Tool["inputSchema"],
    },
    ...(["status", "close"] as const).map((action) => ({
      name: `tollbooth_${action}`,
      description:
        action === "status"
          ? "Read your authoritative usage and payment state."
          : "Finish usage and settle once. Pending is not paid.",
      inputSchema: sessionSchema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }) as Tool["inputSchema"],
    })),
  ],
};
// Force Zod's lazy validation internals during isolate startup as well as schema creation.
// These are public catalog data only; no requests, principals, I/O or mutable servers.
specTypeSchemas.ListToolsResult["~standard"].validate(listedTools);
specTypeSchemas.ListToolsRequest["~standard"].validate({ method: "tools/list", params: {} });
specTypeSchemas.InitializeRequest["~standard"].validate({
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "startup", version: "1" },
  },
});

// Legacy initialize also validates the JSON-RPC wrapper and the response capability tree.
// Preloading schema objects alone leaves these nested validators lazy until first use.
specTypeSchemas.JSONRPCMessage["~standard"].validate({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "startup", version: "1" },
  },
});
specTypeSchemas.InitializeResult["~standard"].validate({
  protocolVersion: "2025-11-25",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "tollbooth", version: "0.1.0" },
});
function result(data: unknown): CallToolResult {
  const body = data as Record<string, unknown>;
  return {
    isError: typeof body.code === "string",
    structuredContent: body,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}
async function guarded(f: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await f());
  } catch (e) {
    return result(e instanceof z.ZodError ? { code: "INVALID_INPUT", status: 400 } : safeError(e));
  }
}
function requestHandler(env: AppEnv, claims: Claims | undefined, body: unknown, discovery = false) {
  const envelope = body as { params?: { _meta?: { tollbooth?: unknown } } };
  return createMcpHandler(
    () => {
      const server = new McpServer({ name: "tollbooth", version: "0.1.0" });
      if (discovery) {
        server.server.registerCapabilities({ tools: { listChanged: true } });
        server.server.setRequestHandler("tools/list", () => listedTools);
        return server;
      }
      for (const tool of catalog)
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: toolSchemas.get(tool.name) as StandardSchemaWithJSON<
              unknown,
              Record<string, unknown>
            >,
          },
          async (args: Record<string, unknown>) =>
            guarded(async (): Promise<unknown> => {
              const raw = envelope.params?._meta?.tollbooth;
              if (!raw)
                return {
                  schemaVersion: 1,
                  code: "PAYMENT_REQUIRED",
                  status: 402,
                  priceCents: tool.priceCents,
                  currency: "USD",
                  merchant: env.MERCHANT_ID,
                  pricingVersion: PRICING_VERSION,
                  nextAction: "OPEN_SESSION",
                };
              const owner = requireScope(claims, "call");
              const meta = callMetaSchema.parse(raw);
              return sessionStub(env, meta.sessionId).call(owner, tool.name, args, meta);
            }),
        );
      server.registerTool(
        "tollbooth_open",
        {
          description:
            "Explicitly open a USD wallet authorization session. Human approval required; no prepaid mode.",
          inputSchema: openingSchema,
        },
        async (args) => guarded(() => openSession(env, requireScope(claims, "open"), args)),
      );
      for (const action of ["status", "close"] as const)
        server.registerTool(
          `tollbooth_${action}`,
          {
            description:
              action === "status"
                ? "Read your authoritative usage and payment state."
                : "Finish usage and settle once. Pending is not paid.",
            inputSchema: sessionSchema,
          },
          async ({ sessionId }) =>
            guarded(async (): Promise<unknown> => {
              const owner = requireScope(claims, action === "status" ? "read" : "close");
              return sessionStub(env, sessionId)[action](owner, sessionId);
            }),
        );
      server.server.setRequestHandler("tools/list", () => listedTools);
      return server;
    },
    {
      route: "/mcp",
      legacy: "stateless",
      responseMode: "json",
      corsOptions: false,
      allowedHostnames: [new URL(env.APP_ORIGIN).hostname],
      allowedOriginHostnames: [new URL(env.APP_ORIGIN).hostname],
      onerror: () => {
        /* No arbitrary provider/SDK errors in logs. */
      },
    },
  );
}
// Discovery carries no principal or business metadata. The handler still creates a fresh
// McpServer per request; only its immutable transport configuration is reused.
const discoveryHandlers = new WeakMap<AppEnv, ReturnType<typeof createMcpHandler>>();
export function handler(env: AppEnv, claims: Claims | undefined, body: unknown) {
  const method = body && typeof body === "object" && "method" in body ? body.method : undefined;
  if (["initialize", "notifications/initialized", "tools/list"].includes(String(method))) {
    let h = discoveryHandlers.get(env);
    if (!h) {
      h = requestHandler(env, undefined, {}, true);
      discoveryHandlers.set(env, h);
    }
    return h;
  }
  return requestHandler(env, claims, body);
}
export { Fault };
