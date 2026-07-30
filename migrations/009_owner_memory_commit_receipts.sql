-- Append-only receipts for the separately enabled owner-controlled commit.
-- Each receipt binds one reviewed candidate to the exact canonical generation
-- written atomically with its snapshot, decisions, assertions, and outbox.

CREATE TABLE memory_owner_commit_receipts (
  commit_receipt_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  review_receipt_id TEXT NOT NULL UNIQUE,
  resolution_receipt_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  publication_decision_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  candidate_payload_hash TEXT NOT NULL,
  review_receipt_hash TEXT NOT NULL,
  resolution_receipt_hash TEXT NOT NULL,
  accepted_assertion_ids_json TEXT NOT NULL,
  pre_snapshot_hash TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  committed_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (review_receipt_id)
    REFERENCES memory_owner_review_receipts(review_receipt_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (resolution_receipt_id)
    REFERENCES memory_resolution_receipts(resolution_receipt_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id)
    REFERENCES memory_snapshots(snapshot_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (publication_decision_id)
    REFERENCES memory_decisions(decision_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_memory_owner_commit_receipts_scope
  ON memory_owner_commit_receipts (
    tenant_id, project_id, generation, candidate_id
  );

CREATE TRIGGER memory_owner_commit_receipts_reject_update
BEFORE UPDATE ON memory_owner_commit_receipts
BEGIN
  SELECT RAISE(ABORT, 'owner commit receipts are immutable');
END;

CREATE TRIGGER memory_owner_commit_receipts_reject_delete
BEFORE DELETE ON memory_owner_commit_receipts
BEGIN
  SELECT RAISE(ABORT, 'owner commit receipts are append-only');
END;
