-- MNEM-GRAPH-MEMORY-003
-- Forward-only tenant isolation and governed graph-memory schema.
-- Existing continuity data belongs to the verified publisher tenant: personal.

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS context_runway_heads_publish_insert;
DROP TRIGGER IF EXISTS context_runway_heads_publish_update;
DROP TRIGGER IF EXISTS context_runways_restore_head_after_invalidation;

ALTER TABLE context_runways
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE context_runway_records
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE context_runway_validations
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE context_retrieval_receipts
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE context_publication_attempts
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE context_runway_invalidations
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE context_invocations
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'personal';

DROP INDEX IF EXISTS idx_context_runways_scope_generation;
DROP INDEX IF EXISTS idx_context_runways_published_scope_generation;
DROP INDEX IF EXISTS idx_context_runways_idempotency;
DROP INDEX IF EXISTS idx_context_runways_scope_state_created;
DROP INDEX IF EXISTS idx_context_runway_records_domain;
DROP INDEX IF EXISTS idx_context_runway_validations_runway_created;
DROP INDEX IF EXISTS idx_context_retrieval_receipts_scope_created;
DROP INDEX IF EXISTS idx_context_publication_attempts_runway_created;
DROP INDEX IF EXISTS idx_context_runway_invalidations_runway_created;

CREATE INDEX idx_context_runways_scope_generation
  ON context_runways (
    tenant_id, identity_id, project_id, scope_key, generation
  );
CREATE UNIQUE INDEX idx_context_runways_published_scope_generation
  ON context_runways (
    tenant_id, identity_id, project_id, scope_key, generation
  )
  WHERE state = 'published';
CREATE UNIQUE INDEX idx_context_runways_idempotency
  ON context_runways (
    tenant_id, created_by_credential_id, idempotency_key
  );
CREATE INDEX idx_context_runways_scope_state_created
  ON context_runways (
    tenant_id, identity_id, project_id, scope_key, state, created_at DESC
  );
CREATE INDEX idx_context_runway_records_domain
  ON context_runway_records (tenant_id, runway_id, domain, ordinal);
CREATE INDEX idx_context_runway_validations_runway_created
  ON context_runway_validations (tenant_id, runway_id, created_at DESC);
CREATE INDEX idx_context_retrieval_receipts_scope_created
  ON context_retrieval_receipts (
    tenant_id, identity_id, project_id, scope_key, created_at DESC
  );
CREATE INDEX idx_context_publication_attempts_runway_created
  ON context_publication_attempts (tenant_id, runway_id, created_at DESC);
CREATE INDEX idx_context_runway_invalidations_runway_created
  ON context_runway_invalidations (tenant_id, runway_id, created_at DESC);
CREATE INDEX idx_context_invocations_scope_started
  ON context_invocations (
    tenant_id, identity_id, project_id, scope_key, started_at DESC
  );

CREATE TABLE context_runway_heads_v3 (
  tenant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  runway_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, identity_id, project_id, scope_key),
  FOREIGN KEY (runway_id)
    REFERENCES context_runways(runway_id)
    ON DELETE RESTRICT
);

INSERT INTO context_runway_heads_v3 (
  tenant_id, identity_id, project_id, scope_key, runway_id, generation,
  manifest_hash, published_at
)
SELECT
  'personal', identity_id, project_id, scope_key, runway_id, generation,
  manifest_hash, published_at
FROM context_runway_heads;

DROP TABLE context_runway_heads;
ALTER TABLE context_runway_heads_v3 RENAME TO context_runway_heads;

CREATE TRIGGER context_runway_heads_publish_insert
AFTER INSERT ON context_runway_heads
BEGIN
  UPDATE context_runways
     SET state = 'superseded'
   WHERE tenant_id = NEW.tenant_id
     AND runway_id = (
       SELECT predecessor_runway_id
         FROM context_runways
        WHERE tenant_id = NEW.tenant_id
          AND runway_id = NEW.runway_id
     )
     AND state = 'published';

  UPDATE context_runways
     SET state = 'published',
         published_at = COALESCE(published_at, NEW.published_at)
   WHERE tenant_id = NEW.tenant_id
     AND runway_id = NEW.runway_id
     AND state IN ('sealed', 'indexing');
END;

CREATE TRIGGER context_runway_heads_publish_update
AFTER UPDATE OF runway_id, generation, manifest_hash, published_at
ON context_runway_heads
BEGIN
  UPDATE context_runways
     SET state = 'superseded'
   WHERE tenant_id = OLD.tenant_id
     AND runway_id = OLD.runway_id
     AND OLD.runway_id <> NEW.runway_id
     AND state = 'published';

  UPDATE context_runways
     SET state = 'published',
         published_at = COALESCE(published_at, NEW.published_at)
   WHERE tenant_id = NEW.tenant_id
     AND runway_id = NEW.runway_id
     AND state IN ('sealed', 'indexing', 'superseded');
END;

CREATE TRIGGER context_runways_restore_head_after_invalidation
AFTER UPDATE OF state ON context_runways
WHEN OLD.state = 'published' AND NEW.state = 'invalidated'
BEGIN
  UPDATE context_runway_heads
     SET runway_id = NEW.predecessor_runway_id,
         generation = (
           SELECT generation FROM context_runways
            WHERE tenant_id = NEW.tenant_id
              AND runway_id = NEW.predecessor_runway_id
         ),
         manifest_hash = (
           SELECT manifest_hash FROM context_runways
            WHERE tenant_id = NEW.tenant_id
              AND runway_id = NEW.predecessor_runway_id
         ),
         published_at = (
           SELECT published_at FROM context_runways
            WHERE tenant_id = NEW.tenant_id
              AND runway_id = NEW.predecessor_runway_id
         )
   WHERE tenant_id = NEW.tenant_id
     AND identity_id = NEW.identity_id
     AND project_id = NEW.project_id
     AND scope_key = NEW.scope_key
     AND runway_id = NEW.runway_id
     AND NEW.predecessor_runway_id IS NOT NULL;

  DELETE FROM context_runway_heads
   WHERE tenant_id = NEW.tenant_id
     AND identity_id = NEW.identity_id
     AND project_id = NEW.project_id
     AND scope_key = NEW.scope_key
     AND runway_id = NEW.runway_id
     AND NEW.predecessor_runway_id IS NULL;
END;

CREATE TABLE memory_entities (
  entity_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ontology_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('candidate', 'accepted', 'superseded', 'deleted')
  ),
  canonical_label TEXT NOT NULL,
  merged_into_entity_id TEXT,
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, entity_id),
  FOREIGN KEY (tenant_id, project_id, merged_into_entity_id)
    REFERENCES memory_entities(tenant_id, project_id, entity_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_relations (
  relation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('candidate', 'accepted', 'superseded', 'deleted')
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, relation_id),
  FOREIGN KEY (tenant_id, project_id, source_entity_id)
    REFERENCES memory_entities(tenant_id, project_id, entity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, target_entity_id)
    REFERENCES memory_entities(tenant_id, project_id, entity_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_events (
  event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('candidate', 'accepted', 'superseded', 'deleted')
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, event_id)
);

CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  submitted_by_credential_id TEXT NOT NULL,
  assistant_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  state TEXT NOT NULL CHECK (
    state IN (
      'pending_validation',
      'pending_review',
      'quarantined',
      'rejected',
      'accepted',
      'superseded'
    )
  ),
  reason_code TEXT,
  submitted_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (
    tenant_id, project_id, submitted_by_credential_id, idempotency_key
  )
);

CREATE TABLE memory_assertions (
  assertion_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  candidate_id TEXT,
  subject_entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('candidate', 'accepted', 'superseded', 'deleted')
  ),
  valid_from TEXT,
  valid_to TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_generation INTEGER,
  FOREIGN KEY (tenant_id, project_id, subject_entity_id)
    REFERENCES memory_entities(tenant_id, project_id, entity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_evidence (
  evidence_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  candidate_id TEXT,
  source_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_excerpt TEXT,
  observed_at TEXT NOT NULL,
  producer_credential_id TEXT NOT NULL,
  authorization_labels_json TEXT NOT NULL,
  citation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_assertion_evidence (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, assertion_id, evidence_id),
  FOREIGN KEY (assertion_id)
    REFERENCES memory_assertions(assertion_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id)
    REFERENCES memory_evidence(evidence_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  covered_entity_ids_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, project_id, generation)
);

CREATE TABLE memory_decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  candidate_id TEXT,
  assertion_id TEXT,
  snapshot_id TEXT,
  decision_type TEXT NOT NULL CHECK (
    decision_type IN (
      'validation',
      'review',
      'rejection',
      'quarantine',
      'resolution',
      'merge',
      'publication',
      'rollback',
      'deletion'
    )
  ),
  outcome TEXT NOT NULL,
  reason_code TEXT,
  receipt_hash TEXT NOT NULL,
  decided_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id)
    REFERENCES memory_candidates(candidate_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (assertion_id)
    REFERENCES memory_assertions(assertion_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id)
    REFERENCES memory_snapshots(snapshot_id)
    ON DELETE RESTRICT
);

CREATE TABLE memory_invocations (
  invocation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  accepted_generation INTEGER,
  selected_assertion_ids_json TEXT NOT NULL,
  retrieval_receipt_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE memory_deletion_receipts (
  receipt_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('tenant', 'project', 'identity', 'candidate')
  ),
  scope_hash TEXT NOT NULL,
  deleted_counts_json TEXT NOT NULL,
  projection_ids_hash TEXT NOT NULL,
  projection_status TEXT NOT NULL CHECK (
    projection_status IN ('pending', 'deleted', 'repair_queued')
  ),
  requested_by_credential_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_memory_entities_type_state
  ON memory_entities (
    tenant_id, project_id, ontology_type, lifecycle_state, canonical_label
  );
CREATE INDEX idx_memory_relations_source
  ON memory_relations (
    tenant_id, project_id, source_entity_id, lifecycle_state, relation_type
  );
CREATE INDEX idx_memory_relations_target
  ON memory_relations (
    tenant_id, project_id, target_entity_id, lifecycle_state, relation_type
  );
CREATE INDEX idx_memory_events_occurred
  ON memory_events (tenant_id, project_id, occurred_at DESC);
CREATE INDEX idx_memory_candidates_owner_state
  ON memory_candidates (
    tenant_id, project_id, submitted_by_credential_id, state, submitted_at DESC
  );
CREATE INDEX idx_memory_assertions_subject_state
  ON memory_assertions (
    tenant_id, project_id, subject_entity_id, lifecycle_state, predicate
  );
CREATE INDEX idx_memory_evidence_candidate
  ON memory_evidence (tenant_id, project_id, candidate_id);
CREATE INDEX idx_memory_decisions_candidate
  ON memory_decisions (tenant_id, project_id, candidate_id, created_at DESC);
CREATE INDEX idx_memory_invocations_generation
  ON memory_invocations (
    tenant_id, project_id, accepted_generation, started_at DESC
  );

CREATE TRIGGER memory_candidates_reject_payload_update
BEFORE UPDATE OF
  tenant_id,
  project_id,
  submitted_by_credential_id,
  idempotency_key,
  payload_json,
  payload_hash,
  confidence,
  submitted_at
ON memory_candidates
BEGIN
  SELECT RAISE(ABORT, 'candidate payload is immutable');
END;

CREATE TRIGGER memory_assertions_require_acceptance_receipts
BEFORE UPDATE OF lifecycle_state ON memory_assertions
WHEN NEW.lifecycle_state = 'accepted'
 AND OLD.lifecycle_state <> 'accepted'
 AND (
   NOT EXISTS (
     SELECT 1
       FROM memory_assertion_evidence
      WHERE tenant_id = NEW.tenant_id
        AND project_id = NEW.project_id
        AND assertion_id = NEW.assertion_id
   )
   OR NOT EXISTS (
     SELECT 1
       FROM memory_decisions
      WHERE tenant_id = NEW.tenant_id
        AND project_id = NEW.project_id
        AND assertion_id = NEW.assertion_id
        AND decision_type IN ('review', 'publication')
        AND outcome = 'accepted'
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'accepted assertion requires evidence and decision');
END;

CREATE TRIGGER memory_evidence_reject_update
BEFORE UPDATE ON memory_evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence is immutable');
END;

CREATE TRIGGER memory_decisions_reject_update
BEFORE UPDATE ON memory_decisions
BEGIN
  SELECT RAISE(ABORT, 'decision receipt is immutable');
END;

CREATE TRIGGER memory_snapshots_reject_update
BEFORE UPDATE ON memory_snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshot is immutable');
END;

PRAGMA foreign_keys = ON;
