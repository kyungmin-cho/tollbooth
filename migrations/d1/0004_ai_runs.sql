-- Admission is atomic; a consumed slot is never refunded after an ambiguous inference.
CREATE TABLE ai_runs (
 session_id TEXT PRIMARY KEY REFERENCES session_index(session_id),
 owner_id TEXT NOT NULL,
 quota_day TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','READY','FALLBACK')),
 result_json TEXT,
 reason TEXT
);
CREATE INDEX ai_runs_day ON ai_runs(quota_day);
CREATE INDEX ai_runs_owner_day ON ai_runs(owner_id,quota_day);
