export interface Session {
  singleton: number;
  id: string;
  owner_id: string;
  merchant_id: string;
  creation_hash: string;
  pricing_version: string;
  budget_cents: number;
  used_cents: number;
  reserved_cents: number;
  state: string;
  version: number;
  created_at: number;
  approval_deadline: number;
  idle_deadline: number | null;
  hard_deadline: number | null;
  close_requested_at: number | null;
  order_id: string | null;
  authorization_id: string | null;
  authorization_status: string | null;
  approval_url: string | null;
  last_error_code: string | null;
}
export interface Registration {
  session_id: string;
  owner_id: string;
  merchant_id: string;
  creation_hash: string;
  budget_cents: number;
  pricing_version: string;
  created_at: number;
  approval_deadline: number;
}
export interface Call {
  call_key: string;
  tool: string;
  canonical_args: string;
  input_hash: string;
  price_cents: number;
  state: string;
  fence: number;
  attempt: number;
  lease_until: number;
  result_json: string | null;
  result_hash: string | null;
  error_code: string | null;
}
export interface Operation {
  kind: string;
  request_id: string;
  payload_json: string;
  payload_hash: string;
  status: string;
  fence: number;
  lease_until: number;
  first_sent_at: number;
}
export interface Settlement extends Operation {
  authorization_id: string;
  amount_cents: number;
  capture_id: string | null;
  release_evidence: string;
}
export interface Snapshot {
  idleDeadline?: number | null;
  hardDeadline?: number | null;
  checkedAt?: number;
  postSettlementIssue?: string | null;
  sessionId: string;
  state: string;
  version: number;
  budgetCents: number;
  usedCents: number;
  reservedCents: number;
  availableCents: number;
  capturedCents: number;
  approvalUrl: string | null;
  orderId: string | null;
  authorizationId: string | null;
  authorizationStatus: string | null;
  approvalDeadline: number;
  ledger: { callKey: string; amountCents: number }[];
  settlement: null | {
    kind: string;
    status: string;
    amountCents: number;
    captureId: string | null;
    releaseEvidence: string;
    requestReference?: string;
  };
  errorCode: string | null;
}
