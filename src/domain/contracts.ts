import { z } from "zod";
export const PRICING_VERSION = "fixture-v1";
export const budgetSchema = z.number().int().min(50).max(500);
export const openSchema = z.strictObject({
  budgetCents: budgetSchema,
  creationKey: z.string().min(1).max(100),
  mode: z.literal("authorize").optional(),
});
export const marketSchema = z.strictObject({
  category: z.enum(["coffee", "stationery", "outdoor"]),
});
export const landedSchema = z.strictObject({
  itemUsd: z.number().min(1).max(10000),
  destination: z.enum(["KR", "JP", "DE"]),
});
export const callMetaSchema = z.strictObject({
  sessionId: z.uuid(),
  callKey: z.string().min(1).max(100),
  maxPriceCents: z.number().int().min(0).max(500),
  pricingVersion: z.literal(PRICING_VERSION),
});
export type CallMeta = z.infer<typeof callMetaSchema>;
export type ToolName = "market_lookup" | "landed_cost";
export const catalog = [
  {
    name: "market_lookup" as const,
    priceCents: 20,
    schema: marketSchema,
    description:
      "Synthetic market fixture data. USD 0.20 per successful call; authorization required.",
  },
  {
    name: "landed_cost" as const,
    priceCents: 35,
    schema: landedSchema,
    description:
      "Illustrative synthetic shipping and duty estimate. USD 0.35 per successful call; authorization required.",
  },
];
export function quote(name: string) {
  const tool = catalog.find((t) => t.name === name);
  if (!tool) throw new Fault("INVALID_INPUT", 400);
  return tool;
}
export class Fault extends Error {
  constructor(
    public code: string,
    public status = 409,
    public retryAfterMs = 0,
  ) {
    super(code);
  }
}
const remoteErrors: Record<string, number> = {
  FORBIDDEN: 403,
  PAYMENT_CONFIG_REQUIRED: 503,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  CALL_IN_PROGRESS: 409,
  PREVIOUS_CALL_FAILED: 409,
  SESSION_CLOSING: 409,
  SESSION_EXPIRED: 409,
  PRICE_NOT_ACCEPTED: 409,
  BUDGET_EXHAUSTED: 402,
  CALL_LIMIT: 409,
  TOOL_FAILED: 409,
  AWAITING_BUYER_APPROVAL: 409,
  PAYMENT_RECONCILING: 202,
  PAYMENT_REVIEW_REQUIRED: 409,
};
export function safeError(error: unknown) {
  if (error instanceof Fault) return { code: error.code, status: error.status };
  // RPC intentionally loses custom prototypes. Accept only enumerated public codes.
  const message = error instanceof Error ? error.message : "";
  if (Object.hasOwn(remoteErrors, message)) return { code: message, status: remoteErrors[message] };
  return { code: "INTERNAL_ERROR", status: 500 };
}
export function money(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Fault("INVALID_AMOUNT", 400);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
export function cents(value: string) {
  if (!/^\d+\.\d{2}$/.test(value)) throw new Fault("INVALID_AMOUNT", 400);
  const [a, b] = value.split(".");
  const n = Number(a) * 100 + Number(b);
  if (!Number.isSafeInteger(n)) throw new Fault("INVALID_AMOUNT", 400);
  return n;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const v = JSON.stringify(value);
    if (v === undefined || (typeof value === "number" && !Number.isFinite(value)))
      throw new Fault("INVALID_INPUT", 400);
    return v;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function fixture(name: ToolName, args: unknown) {
  const tool = quote(name);
  const a = tool.schema.parse(args);
  if ("category" in a)
    return {
      source: "Synthetic fixture; not live market data",
      fixtureVersion: PRICING_VERSION,
      category: a.category,
      demandScore: { coffee: 82, stationery: 64, outdoor: 73 }[a.category],
    };
  const itemCents = Math.round(a.itemUsd * 100);
  const shippingCents = { KR: 1200, JP: 1000, DE: 1500 }[a.destination];
  const dutyCents = Math.round(itemCents * { KR: 0.08, JP: 0.05, DE: 0.12 }[a.destination]);
  return {
    source: "Illustrative synthetic estimate; not customs advice",
    fixtureVersion: PRICING_VERSION,
    itemCents,
    shippingCents,
    dutyCents,
    totalCents: itemCents + shippingCents + dutyCents,
    destination: a.destination,
  };
}
