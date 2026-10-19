import type { MerchantPage } from "./dashboard";
import type { Snapshot } from "./types";
export function demoSnapshot(): Snapshot {
  return {
    sessionId: "rehearsal",
    state: "ACTIVE",
    version: 1,
    budgetCents: 500,
    usedCents: 0,
    reservedCents: 0,
    availableCents: 500,
    capturedCents: 0,
    approvalUrl: null,
    orderId: null,
    authorizationId: null,
    authorizationStatus: null,
    approvalDeadline: Date.now() + 1800000,
    ledger: [],
    settlement: null,
    errorCode: null,
  };
}
export function demoPage(): MerchantPage {
  const now = Date.now();
  return {
    simulated: true,
    at: now,
    nextCursor: null,
    summary: { capturedCents: 90, usedCents: 125, active: 1, review: 1, count: 3 },
    rows: ["CAPTURED", "ACTIVE", "RECONCILING"].map((state, i) => ({
      sessionId: `demo-${i + 1}`,
      createdAt: now - (i + 1) * 60000,
      projectedAt: now - 5000,
      version: 3,
      state,
      budgetCents: 500,
      usedCents: i === 0 ? 90 : 35,
      reservedCents: 0,
      capturedCents: i === 0 ? 90 : 0,
      availableCents: i === 0 ? 410 : 465,
      calls: i === 0 ? 3 : 1,
      errorCode: i === 2 ? "PAYMENT_RECONCILING" : null,
      captureId: null,
      kind: i === 1 ? null : "CAPTURE",
      status: i === 0 ? "SUCCEEDED" : "PENDING",
      amountCents: i === 0 ? 90 : 35,
      releaseEvidence: i === 0 ? "FINAL_CAPTURE" : "UNCONFIRMED",
    })),
  };
}
