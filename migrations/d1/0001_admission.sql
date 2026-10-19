CREATE TABLE session_index (
 session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
 creation_key TEXT NOT NULL, creation_hash TEXT NOT NULL, budget_cents INTEGER NOT NULL CHECK(budget_cents BETWEEN 50 AND 500),
 pricing_version TEXT NOT NULL, created_at INTEGER NOT NULL, approval_deadline INTEGER NOT NULL,
 recovery_due_at INTEGER NOT NULL, mapping_version INTEGER NOT NULL DEFAULT 0,
 UNIQUE(owner_id,creation_key)
);
CREATE INDEX recovery_due ON session_index(recovery_due_at,session_id);
CREATE INDEX admission_time ON session_index(created_at,owner_id);
CREATE TABLE session_projection (session_id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL, used_cents INTEGER NOT NULL, reserved_cents INTEGER NOT NULL, captured_cents INTEGER NOT NULL, snapshot_json TEXT NOT NULL, projected_at INTEGER NOT NULL);
CREATE TABLE projection_receipts (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_version INTEGER NOT NULL, applied_at INTEGER NOT NULL, UNIQUE(session_id,session_version));
