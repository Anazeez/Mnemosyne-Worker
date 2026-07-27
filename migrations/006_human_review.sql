-- Append-only human review records. Assistant-facing adapters do not expose
-- these tables or their operations.

CREATE TABLE memory_candidate_edits (
  edit_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  edited_payload_json TEXT NOT NULL,
  edited_payload_hash TEXT NOT NULL,
  reason_code TEXT,
  edited_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_review_actions (
  action_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('accept', 'edit_accept', 'reject', 'quarantine')
  ),
  response_json TEXT NOT NULL,
  decided_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, project_id, candidate_id, idempotency_key),
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_memory_candidate_edits_candidate
  ON memory_candidate_edits (tenant_id, project_id, candidate_id, created_at);

CREATE INDEX idx_memory_review_actions_candidate
  ON memory_review_actions (tenant_id, project_id, candidate_id, created_at);
