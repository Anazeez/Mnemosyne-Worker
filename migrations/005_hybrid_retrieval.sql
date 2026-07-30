-- Rebuildable lexical and semantic projection state for governed memory.
-- D1 accepted assertions and the decision ledger remain authoritative.

CREATE VIRTUAL TABLE memory_assertion_search USING fts5(
  assertion_id UNINDEXED,
  tenant_id UNINDEXED,
  project_id UNINDEXED,
  document,
  tokenize = 'unicode61'
);

CREATE TABLE memory_projection_outbox (
  projection_id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  accepted_generation INTEGER NOT NULL,
  embedding_model TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'complete', 'repair_queued')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memory_projection_outbox_state
  ON memory_projection_outbox (state, updated_at, projection_id);

CREATE INDEX idx_memory_projection_outbox_scope
  ON memory_projection_outbox (
    tenant_id, project_id, accepted_generation, projection_id
  );
