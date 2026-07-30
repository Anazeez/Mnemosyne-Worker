-- Append-only owner review receipts. Approval authorizes only a later,
-- separately controlled commit and never publishes accepted memory itself.

CREATE TABLE memory_owner_review_receipts (
  review_receipt_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL UNIQUE,
  resolution_receipt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('approve_for_commit', 'reject', 'quarantine')
  ),
  candidate_payload_hash TEXT NOT NULL,
  resolution_receipt_hash TEXT NOT NULL,
  evidence_hashes_json TEXT NOT NULL,
  reason_code TEXT,
  receipt_hash TEXT NOT NULL,
  reviewed_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id)
    REFERENCES memory_decisions(decision_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (resolution_receipt_id)
    REFERENCES memory_resolution_receipts(resolution_receipt_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_memory_owner_review_receipts_scope
  ON memory_owner_review_receipts (
    tenant_id, project_id, candidate_id, created_at
  );

CREATE TRIGGER memory_owner_review_receipts_reject_update
BEFORE UPDATE ON memory_owner_review_receipts
BEGIN
  SELECT RAISE(ABORT, 'owner review receipts are immutable');
END;

CREATE TRIGGER memory_owner_review_receipts_reject_delete
BEFORE DELETE ON memory_owner_review_receipts
BEGIN
  SELECT RAISE(ABORT, 'owner review receipts are append-only');
END;
