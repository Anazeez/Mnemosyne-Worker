-- MNEM-CONTINUITY-002
-- Forward-only D1 schema for deterministic specialist continuity.
-- Rollback disables application feature flags; it does not delete this history.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_runways (
  runway_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  predecessor_runway_id TEXT,
  source_invocation_id TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (
    state IN (
      'candidate',
      'validated',
      'sealed',
      'indexing',
      'published',
      'superseded',
      'rejected',
      'quarantined',
      'invalidated',
      'publication_failed'
    )
  ),
  context_status TEXT NOT NULL CHECK (
    context_status IN ('current', 'stale', 'degraded', 'backfilled')
  ),
  objective TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  source_hashes_json TEXT NOT NULL,
  integrity_state TEXT NOT NULL,
  completeness_score REAL CHECK (
    completeness_score IS NULL OR
    (completeness_score >= 0.0 AND completeness_score <= 1.0)
  ),
  created_by_credential_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  portable_artifact_ref TEXT,
  indexing_state TEXT NOT NULL DEFAULT 'not_required' CHECK (
    indexing_state IN ('not_required', 'pending', 'complete', 'failed')
  ),
  created_at TEXT NOT NULL,
  validated_at TEXT,
  sealed_at TEXT,
  published_at TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  FOREIGN KEY (predecessor_runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_runways_scope_generation
  ON context_runways (identity_id, project_id, scope_key, generation);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_runways_idempotency
  ON context_runways (created_by_credential_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_context_runways_scope_state_created
  ON context_runways (
    identity_id,
    project_id,
    scope_key,
    state,
    created_at DESC
  );

CREATE TABLE IF NOT EXISTS context_runway_heads (
  identity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  runway_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (identity_id, project_id, scope_key),
  FOREIGN KEY (runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS context_runway_records (
  runway_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (
    domain IN ('knowledge', 'agents', 'skills', 'files', 'library')
  ),
  record_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_hash TEXT,
  relation TEXT NOT NULL CHECK (
    relation IN (
      'decision_source',
      'active_skill',
      'relevant_file',
      'supporting_evidence',
      'open_thread_source',
      'handoff_source',
      'next_action_source'
    )
  ),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (runway_id, record_id),
  FOREIGN KEY (runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_context_runway_records_domain
  ON context_runway_records (runway_id, domain, ordinal);

CREATE TABLE IF NOT EXISTS context_runway_validations (
  validation_id TEXT PRIMARY KEY,
  runway_id TEXT NOT NULL,
  validator_credential_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'quarantined')),
  errors_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  completeness_score REAL NOT NULL CHECK (
    completeness_score >= 0.0 AND completeness_score <= 1.0
  ),
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_context_runway_validations_runway_created
  ON context_runway_validations (runway_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_retrieval_receipts (
  receipt_id TEXT PRIMARY KEY,
  requesting_credential_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  selected_runway_id TEXT,
  selected_generation INTEGER,
  context_status TEXT NOT NULL CHECK (
    context_status IN (
      'CURRENT_CONTEXT',
      'STALE_CONTEXT',
      'DEGRADED_CONTEXT',
      'NO_CONTEXT',
      'QUARANTINED_CONTEXT',
      'CONTEXT_UNAVAILABLE'
    )
  ),
  fallback_path_json TEXT NOT NULL,
  requested_domains_json TEXT NOT NULL,
  permitted_domains_json TEXT NOT NULL,
  supplemental_search_used INTEGER NOT NULL DEFAULT 0 CHECK (
    supplemental_search_used IN (0, 1)
  ),
  supplemental_result_count INTEGER NOT NULL DEFAULT 0 CHECK (
    supplemental_result_count >= 0
  ),
  omissions_json TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_retrieval_receipts_scope_created
  ON context_retrieval_receipts (
    identity_id,
    project_id,
    scope_key,
    created_at DESC
  );

CREATE TABLE IF NOT EXISTS context_publication_attempts (
  attempt_id TEXT PRIMARY KEY,
  runway_id TEXT NOT NULL,
  expected_generation INTEGER NOT NULL,
  observed_generation INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('started', 'succeeded', 'failed', 'conflict')
  ),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_context_publication_attempts_runway_created
  ON context_publication_attempts (runway_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_invocations (
  invocation_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  resolved_runway_id TEXT,
  retrieval_receipt_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('opened', 'rehydrated', 'active', 'completed', 'failed')
  ),
  continuity_outcome TEXT CHECK (
    continuity_outcome IS NULL OR
    continuity_outcome IN ('changed', 'unchanged', 'checkpoint_failed')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (resolved_runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (retrieval_receipt_id)
    REFERENCES context_retrieval_receipts(receipt_id)
    ON DELETE RESTRICT
);

CREATE TRIGGER context_runways_reject_sealed_content_update
BEFORE UPDATE OF
  schema_version,
  identity_id,
  project_id,
  scope_key,
  predecessor_runway_id,
  source_invocation_id,
  generation,
  objective,
  summary,
  payload_json,
  manifest_hash,
  source_hashes_json,
  created_by_credential_id,
  idempotency_key
ON context_runways
WHEN OLD.state IN ('sealed', 'published', 'superseded', 'invalidated')
BEGIN
  SELECT RAISE(ABORT, 'sealed runway content is immutable');
END;

CREATE TRIGGER context_runways_reject_historical_delete
BEFORE DELETE ON context_runways
WHEN OLD.state IN ('sealed', 'published', 'superseded', 'invalidated')
BEGIN
  SELECT RAISE(ABORT, 'historical runway deletion is prohibited');
END;

CREATE TRIGGER context_runway_heads_publish_insert
AFTER INSERT ON context_runway_heads
BEGIN
  UPDATE context_runways
     SET state = 'superseded'
   WHERE runway_id = (
     SELECT predecessor_runway_id
       FROM context_runways
      WHERE runway_id = NEW.runway_id
   )
     AND state = 'published';

  UPDATE context_runways
     SET state = 'published',
         published_at = COALESCE(published_at, NEW.published_at)
   WHERE runway_id = NEW.runway_id
     AND state IN ('sealed', 'indexing');
END;

CREATE TRIGGER context_runway_heads_publish_update
AFTER UPDATE OF runway_id, generation, manifest_hash, published_at
ON context_runway_heads
BEGIN
  UPDATE context_runways
     SET state = 'superseded'
   WHERE runway_id = OLD.runway_id
     AND OLD.runway_id <> NEW.runway_id
     AND state = 'published';

  UPDATE context_runways
     SET state = 'published',
         published_at = COALESCE(published_at, NEW.published_at)
   WHERE runway_id = NEW.runway_id
     AND state IN ('sealed', 'indexing', 'superseded');
END;
