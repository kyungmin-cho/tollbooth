export interface MerchantRow {
  sessionId: string;
  createdAt: number;
  state: string;
  budgetCents: number;
  usedCents: number;
  reservedCents: number;
  capturedCents: number;
  availableCents: number;
  calls: number;
  projectedAt: number;
  version: number;
  errorCode: string | null;
  captureId: string | null;
  kind: string | null;
  status: string | null;
  amountCents: number;
  releaseEvidence: string | null;
}
export interface MerchantPage {
  rows: MerchantRow[];
  nextCursor: string | null;
  summary: {
    capturedCents: number;
    usedCents: number;
    active: number;
    review: number;
    count: number;
  };
  at: number;
  simulated?: boolean;
}
