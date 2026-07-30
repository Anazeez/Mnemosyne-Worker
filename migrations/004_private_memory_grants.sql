-- MNEM-PRIVATE-GRANTS-004
-- Forward-only owner authorization and immutable grant receipts.

CREATE TABLE memory_access_grants (
  grant_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_github_id INTEGER NOT NULL CHECK (owner_github_id > 0),
  assistant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  current_receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (
    tenant_id,
    owner_github_id,
    assistant_id,
    project_id,
    idempotency_key
  )
);

CREATE UNIQUE INDEX idx_memory_access_grants_active_project
  ON memory_access_grants (
    tenant_id,
    owner_github_id,
    assistant_id,
    project_id
  )
  WHERE status = 'active';

CREATE INDEX idx_memory_access_grants_resolution
  ON memory_access_grants (
    tenant_id,
    owner_github_id,
    assistant_id,
    status,
    starts_at,
    expires_at
  );

CREATE TABLE memory_authorization_receipts (
  receipt_id TEXT PRIMARY KEY,
  grant_id TEXT,
  tenant_id TEXT NOT NULL,
  owner_github_id INTEGER NOT NULL CHECK (owner_github_id > 0),
  assistant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('approved', 'denied', 'expired', 'revoked')
  ),
  capabilities_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  starts_at TEXT,
  expires_at TEXT,
  previous_receipt_hash TEXT,
  receipt_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (grant_id)
    REFERENCES memory_access_grants(grant_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_memory_authorization_receipts_subject
  ON memory_authorization_receipts (
    tenant_id,
    owner_github_id,
    assistant_id,
    project_id,
    created_at DESC
  );

CREATE TRIGGER memory_authorization_receipts_reject_update
BEFORE UPDATE ON memory_authorization_receipts
BEGIN
  SELECT RAISE(ABORT, 'authorization receipt is immutable');
END;

CREATE TRIGGER memory_authorization_receipts_reject_delete
BEFORE DELETE ON memory_authorization_receipts
BEGIN
  SELECT RAISE(ABORT, 'authorization receipt is immutable');
END;
