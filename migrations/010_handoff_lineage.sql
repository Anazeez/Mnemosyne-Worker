-- MNEM-HANDOFF-010
-- Forward-only save-file handoffs and scope-bound DAG lineage.
-- Direct edges are authoritative; handoff_lineage is a rebuildable closure.

CREATE TABLE handoffs (
  handoff_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = 'handoff.v1'),
  state TEXT NOT NULL CHECK (
    state IN ('candidate', 'accepted', 'superseded', 'archived', 'quarantined', 'rejected')
  ),
  boundary_event TEXT NOT NULL CHECK (
    boundary_event IN (
      'stop',
      'credit_warning',
      'credit_termination',
      'task_complete',
      'phase_complete',
      'project_complete',
      'interruption',
      'failure',
      'context_compaction'
    )
  ),
  occurred_at TEXT NOT NULL,
  progress_state TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  epoch_id TEXT,
  compaction_level TEXT NOT NULL CHECK (
    compaction_level IN ('checkpoint', 'handoff', 'epoch', 'project_snapshot')
  ),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  retention_class TEXT NOT NULL CHECK (
    retention_class IN ('project', 'phase', 'transient')
  ),
  ttl_seconds INTEGER CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  expires_at TEXT,
  agent_family TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  approval_receipt_hash TEXT,
  approved_by_credential_id TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  superseded_at TEXT,
  PRIMARY KEY (tenant_id, project_id, handoff_id),
  FOREIGN KEY (tenant_id, project_id, epoch_id)
    REFERENCES handoffs(tenant_id, project_id, handoff_id)
    ON DELETE RESTRICT,
  CHECK (
    state <> 'accepted'
    OR (
      approval_receipt_hash IS NOT NULL
      AND approved_by_credential_id IS NOT NULL
      AND accepted_at IS NOT NULL
    )
  )
);

CREATE TABLE handoff_edges (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  related_handoff_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (
    relation_type IN ('parent', 'supersedes')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    tenant_id, project_id, handoff_id, related_handoff_id, relation_type
  ),
  CHECK (handoff_id <> related_handoff_id),
  FOREIGN KEY (tenant_id, project_id, handoff_id)
    REFERENCES handoffs(tenant_id, project_id, handoff_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, related_handoff_id)
    REFERENCES handoffs(tenant_id, project_id, handoff_id)
    ON DELETE RESTRICT
);

CREATE TABLE handoff_lineage (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ancestor_handoff_id TEXT NOT NULL,
  descendant_handoff_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  path_hash TEXT NOT NULL CHECK (
    length(path_hash) = 64 AND path_hash NOT GLOB '*[^0-9a-f]*'
  ),
  path_count INTEGER NOT NULL DEFAULT 1 CHECK (path_count >= 1),
  PRIMARY KEY (
    tenant_id, project_id, ancestor_handoff_id, descendant_handoff_id
  ),
  CHECK (
    (ancestor_handoff_id = descendant_handoff_id AND depth = 0)
    OR (ancestor_handoff_id <> descendant_handoff_id AND depth > 0)
  ),
  FOREIGN KEY (tenant_id, project_id, ancestor_handoff_id)
    REFERENCES handoffs(tenant_id, project_id, handoff_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, descendant_handoff_id)
    REFERENCES handoffs(tenant_id, project_id, handoff_id)
    ON DELETE RESTRICT
);

CREATE INDEX handoff_edges_scope_related
  ON handoff_edges (tenant_id, project_id, related_handoff_id);

CREATE INDEX handoffs_scope_state_generation
  ON handoffs (tenant_id, project_id, state, generation DESC, handoff_id);

CREATE INDEX handoff_edges_scope_relation
  ON handoff_edges (
    tenant_id, project_id, relation_type, handoff_id
  );

CREATE INDEX handoff_lineage_scope_ancestor
  ON handoff_lineage (
    tenant_id, project_id, ancestor_handoff_id, depth
  );

CREATE INDEX handoff_lineage_scope_descendant
  ON handoff_lineage (
    tenant_id, project_id, descendant_handoff_id, depth
  );

CREATE TRIGGER handoffs_reject_payload_update
BEFORE UPDATE OF
  handoff_id,
  tenant_id,
  project_id,
  schema_version,
  boundary_event,
  occurred_at,
  progress_state,
  generation,
  epoch_id,
  compaction_level,
  payload_json,
  payload_hash,
  retention_class,
  ttl_seconds,
  expires_at,
  agent_family,
  agent_id,
  session_id,
  created_at
ON handoffs
BEGIN
  SELECT RAISE(ABORT, 'handoff payload is immutable');
END;

CREATE TRIGGER handoffs_reject_delete
BEFORE DELETE ON handoffs
BEGIN
  SELECT RAISE(ABORT, 'handoffs are append-only');
END;

CREATE TRIGGER handoffs_validate_state_transition
BEFORE UPDATE OF state ON handoffs
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'candidate' AND NEW.state IN ('accepted', 'quarantined', 'rejected'))
  OR (OLD.state = 'accepted' AND NEW.state IN ('superseded', 'archived'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid handoff state transition');
END;

CREATE TRIGGER handoffs_validate_acceptance
BEFORE UPDATE OF state ON handoffs
WHEN NEW.state = 'accepted'
 AND (
   NEW.approval_receipt_hash IS NULL
   OR NEW.approved_by_credential_id IS NULL
   OR NEW.accepted_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'accepted handoff requires approval receipt');
END;

CREATE TRIGGER handoff_edges_reject_update
BEFORE UPDATE ON handoff_edges
BEGIN
  SELECT RAISE(ABORT, 'handoff edges are immutable');
END;

CREATE TRIGGER handoff_edges_reject_delete
BEFORE DELETE ON handoff_edges
BEGIN
  SELECT RAISE(ABORT, 'handoff edges are append-only');
END;

CREATE TRIGGER handoff_edges_reject_self_edge
BEFORE INSERT ON handoff_edges
WHEN NEW.handoff_id = NEW.related_handoff_id
BEGIN
  SELECT RAISE(ABORT, 'HANDOFF_LINEAGE_SELF_EDGE');
END;

CREATE TRIGGER handoff_edges_reject_cycle
BEFORE INSERT ON handoff_edges
WHEN NEW.handoff_id <> NEW.related_handoff_id
BEGIN
  WITH RECURSIVE prior_nodes(node_id) AS (
    SELECT NEW.related_handoff_id
    UNION
    SELECT edge.related_handoff_id
      FROM handoff_edges AS edge
      JOIN prior_nodes AS prior
        ON edge.handoff_id = prior.node_id
     WHERE edge.tenant_id = NEW.tenant_id
       AND edge.project_id = NEW.project_id
  )
  SELECT RAISE(ABORT, 'HANDOFF_LINEAGE_CYCLE')
    WHERE EXISTS (
      SELECT 1 FROM prior_nodes WHERE node_id = NEW.handoff_id
    );
END;
