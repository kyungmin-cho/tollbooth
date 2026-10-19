export const schema = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
 creation_hash TEXT NOT NULL, pricing_version TEXT NOT NULL, budget_cents INTEGER NOT NULL CHECK(budget_cents BETWEEN 50 AND 500),
 used_cents INTEGER NOT NULL DEFAULT 0, reserved_cents INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, approval_deadline INTEGER NOT NULL, idle_deadline INTEGER, hard_deadline INTEGER, close_requested_at INTEGER,
 order_id TEXT UNIQUE, authorization_id TEXT UNIQUE, authorization_status TEXT, approval_url TEXT,
 last_error_code TEXT, CHECK(used_cents>=0 AND reserved_cents>=0 AND used_cents+reserved_cents<=budget_cents)
);
CREATE TABLE IF NOT EXISTS calls(call_key TEXT PRIMARY KEY, tool TEXT NOT NULL, canonical_args TEXT NOT NULL, input_hash TEXT NOT NULL,
 price_cents INTEGER NOT NULL CHECK(price_cents>0), state TEXT NOT NULL, fence INTEGER NOT NULL, attempt INTEGER NOT NULL, lease_until INTEGER NOT NULL,
 result_json TEXT, result_hash TEXT, error_code TEXT);
CREATE TABLE IF NOT EXISTS ledger(seq INTEGER PRIMARY KEY,call_key TEXT NOT NULL UNIQUE REFERENCES calls(call_key), amount_cents INTEGER NOT NULL CHECK(amount_cents>0), result_hash TEXT NOT NULL, committed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payment_operations(kind TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,fence INTEGER NOT NULL,lease_until INTEGER NOT NULL,first_sent_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settlement(singleton INTEGER PRIMARY KEY CHECK(singleton=1),kind TEXT NOT NULL CHECK(kind IN ('CAPTURE','VOID')),
 authorization_id TEXT NOT NULL,amount_cents INTEGER NOT NULL,request_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,
 status TEXT NOT NULL,fence INTEGER NOT NULL,lease_until INTEGER NOT NULL,first_sent_at INTEGER NOT NULL,capture_id TEXT,release_evidence TEXT NOT NULL DEFAULT 'UNCONFIRMED',
 CHECK((kind='CAPTURE' AND amount_cents>0) OR (kind='VOID' AND amount_cents=0)));
CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,session_version INTEGER NOT NULL UNIQUE,snapshot_json TEXT NOT NULL,delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS jobs(kind TEXT PRIMARY KEY,due_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO schema_version VALUES(1, unixepoch()*1000);
CREATE INDEX IF NOT EXISTS call_leases ON calls(state,lease_until);
CREATE INDEX IF NOT EXISTS job_due ON jobs(due_at);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered_at,session_version);
CREATE TABLE IF NOT EXISTS recovery_state(kind TEXT PRIMARY KEY, attempts INTEGER NOT NULL, first_at INTEGER NOT NULL, review_checks INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS provider_cooldown(singleton INTEGER PRIMARY KEY CHECK(singleton=1),until_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),post_settlement_issue TEXT);
CREATE TABLE IF NOT EXISTS webhook_inbox(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,resource_id TEXT NOT NULL,body_hash TEXT NOT NULL,metadata_json TEXT NOT NULL,received_at INTEGER NOT NULL,processed_at INTEGER,outcome TEXT NOT NULL);
INSERT OR IGNORE INTO schema_version VALUES(2, unixepoch()*1000);
CREATE TABLE IF NOT EXISTS callback_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),nonce TEXT NOT NULL,consumed_at INTEGER);
INSERT OR IGNORE INTO schema_version VALUES(3, unixepoch()*1000);
`;
