-- Append-only entity-resolution receipts. Resolution never creates accepted
-- graph records and remains separate from human review and publication.

CREATE TABLE memory_resolution_receipts (
  resolution_receipt_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  resolutions_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('resolved', 'quarantined')
  ),
  reason_code TEXT,
  receipt_hash TEXT NOT NULL,
  resolved_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id)
    REFERENCES memory_decisions(decision_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_memory_resolution_receipts_scope
  ON memory_resolution_receipts (
    tenant_id, project_id, candidate_id, created_at
  );

CREATE TRIGGER memory_resolution_receipts_reject_update
BEFORE UPDATE ON memory_resolution_receipts
BEGIN
  SELECT RAISE(ABORT, 'memory resolution receipts are immutable');
END;

CREATE TRIGGER memory_resolution_receipts_reject_delete
BEFORE DELETE ON memory_resolution_receipts
BEGIN
  SELECT RAISE(ABORT, 'memory resolution receipts are append-only');
END;
