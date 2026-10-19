import assert from "node:assert/strict";

export class EvidencePending extends Error {
  constructor() {
    super("EVIDENCE_NOT_READY");
  }
}
export function requireProviderVisibility(
  orderStatus: string,
  authorizationStatus: string,
  captureCount: number,
  zero: boolean,
): void {
  if (captureCount > (zero ? 0 : 1)) throw new Error("UNEXPECTED_CAPTURE_COUNT");
  if (
    ["APPROVED", "PAYER_ACTION_REQUIRED"].includes(orderStatus) ||
    authorizationStatus === "CREATED" ||
    (!zero && captureCount === 0)
  )
    throw new EvidencePending();
  assert.equal(orderStatus, "COMPLETED");
  assert.equal(authorizationStatus, zero ? "VOIDED" : "CAPTURED");
}
export async function awaitEvidence<T>(
  read: () => Promise<T>,
  options: { attempts?: number; delay?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const {
    attempts = 31,
    delay = 2000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  for (let i = 0; i < attempts; i++) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof EvidencePending) || i === attempts - 1) throw error;
      await sleep(delay);
    }
  }
  throw new EvidencePending();
}
export function requireActive<T extends { state: string }>(snapshot: T): T {
  if (["APPROVAL_PENDING", "AUTHORIZING", "RECONCILING"].includes(snapshot.state))
    throw new EvidencePending();
  assert.equal(snapshot.state, "ACTIVE");
  return snapshot;
}

export function sandboxTarget(origin: string, deployedOrigin: string): "local" | "remote" {
  const url = new URL(origin);
  assert.equal(url.origin, origin);
  assert.ok(!url.username && !url.password);
  if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) return "local";
  assert.equal(url.protocol, "https:");
  assert.equal(origin, deployedOrigin);
  return "remote";
}

export function assertEvidenceOrigin(savedOrigin: unknown, origin: string, remote: boolean): void {
  // Legacy local evidence predates origin binding. Never import it into a remote run.
  if (savedOrigin === undefined && !remote) return;
  assert.equal(savedOrigin, origin);
}

// PayPal may include breakdown metadata. Only the currency and exact decimal total
// define this amount; comparing the whole object rejects valid provider responses.
export function assertUsdAmount(actual: unknown, expectedCents: number): void {
  assert.ok(Number.isSafeInteger(expectedCents) && expectedCents >= 0);
  assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual));
  const amount = actual as Record<string, unknown>;
  assert.equal(amount.currency_code, "USD");
  const value = `${Math.floor(expectedCents / 100)}.${String(expectedCents % 100).padStart(2, "0")}`;
  assert.equal(amount.value, value);
}

// Only allowlisted public codes may reach console diagnostics; assertion details can contain secrets.
const publicCodes = new Set([
  "EVIDENCE_NOT_READY",
  "PAYMENT_CONFIG_REQUIRED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "INTERNAL_ERROR",
  "ADMISSION_LIMIT",
  "IDEMPOTENCY_CONFLICT",
  "PAYMENT_RECONCILING",
  "PAYMENT_REVIEW_REQUIRED",
  "AWAITING_BUYER_APPROVAL",
  "SESSION_CLOSING",
]);
export function diagnosticCode(error: unknown): string {
  if (error instanceof Error && publicCodes.has(error.message)) return error.message;
  if (error instanceof Error && error.name === "AssertionError")
    return "ACCEPTANCE_ASSERTION_FAILED";
  return "REQUEST_FAILED";
}
export function fixtureConsentFlag(args: string[]): boolean {
  const selected = args.includes("--approve-fixture-calls");
  if (
    selected &&
    (!args.includes("--resume") ||
      args.includes("--prepare") ||
      args.includes("--verify") ||
      args.includes("--zero-use"))
  )
    throw new Error("INVALID_CONSENT_MODE");
  return selected;
}
export function needsCallConsent(
  price: number,
  key: string,
  ledger: { callKey: string }[],
  preapproved: boolean,
): boolean {
  return price > 30 && !ledger.some((row) => row.callKey === key) && !preapproved;
}
export function requireAiReady<T extends { status?: string; calls?: unknown[] } | null>(
  plan: T,
): NonNullable<T> {
  assert.ok(
    plan && plan.status === "READY" && plan.calls?.length === 3,
    "AI plan is not ready; no scripted substitution or activation permitted",
  );
  return plan;
}

/** Preparation may explicitly choose fixtures after a terminal model fallback, never pending. */
export function preparedRunMode(status: string, allowScriptedFallback: boolean) {
  if (status === "READY") return "ai";
  if (status === "FALLBACK" && allowScriptedFallback) return "scripted";
  throw new Error("AI plan unavailable; approval files retained, do not create another session");
}
