import {
  GraphMemoryError,
  canonicalHash,
  normalizeCandidatePayload
} from "./contracts.js";
import { assertGraphAccess } from "./policy.js";
import { buildProjectionOutboxStatement } from "./projection.js";

const SQL = Object.freeze({
  GET_CANDIDATE: `
    SELECT * FROM memory_candidates
     WHERE candidate_id = ? AND tenant_id = ?`,
  UPDATE_CANDIDATE: `
    UPDATE memory_candidates
       SET state = ?, reason_code = ?, updated_at = ?
     WHERE candidate_id = ? AND tenant_id = ?`,
  INSERT_DECISION: `
    INSERT INTO memory_decisions (
      decision_id, tenant_id, project_id, candidate_id, assertion_id,
      snapshot_id, decision_type, outcome, reason_code, receipt_hash,
      decided_by_credential_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_CANDIDATE_EDIT: `
    INSERT INTO memory_candidate_edits (
      edit_id, candidate_id, tenant_id, project_id, edited_payload_json,
      edited_payload_hash, reason_code, edited_by_credential_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  LIST_EVIDENCE: `
    SELECT * FROM memory_evidence
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?
     ORDER BY evidence_id`,
  GET_ENTITY: `
    SELECT * FROM memory_entities
     WHERE tenant_id = ? AND project_id = ? AND entity_id = ?`,
  INSERT_ENTITY: `
    INSERT INTO memory_entities (
      entity_id, tenant_id, project_id, ontology_type, lifecycle_state,
      canonical_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_ASSERTION: `
    INSERT INTO memory_assertions (
      assertion_id, tenant_id, project_id, candidate_id, subject_entity_id,
      predicate, object_json, confidence, lifecycle_state, valid_from,
      valid_to, observed_at, created_at, accepted_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  LINK_EVIDENCE: `
    INSERT INTO memory_assertion_evidence (
      tenant_id, project_id, assertion_id, evidence_id
    ) VALUES (?, ?, ?, ?)`,
  ACCEPT_ASSERTION: `
    UPDATE memory_assertions
       SET lifecycle_state = 'accepted'
     WHERE tenant_id = ? AND project_id = ? AND assertion_id = ?`,
  NEXT_GENERATION: `
    SELECT COALESCE(MAX(generation), 0) + 1 AS generation
      FROM memory_snapshots
     WHERE tenant_id = ? AND project_id = ?`,
  INSERT_SNAPSHOT: `
    INSERT INTO memory_snapshots (
      snapshot_id, tenant_id, project_id, generation,
      covered_entity_ids_json, snapshot_json, snapshot_hash,
      created_by_credential_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  GET_DECISION: `
    SELECT * FROM memory_decisions
     WHERE decision_id = ? AND tenant_id = ?`,
  GET_SNAPSHOT: `
    SELECT * FROM memory_snapshots
     WHERE snapshot_id = ? AND tenant_id = ?`,
  SUPERSEDE_ASSERTIONS: `
    UPDATE memory_assertions
       SET lifecycle_state = 'superseded'
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?
       AND lifecycle_state = 'accepted'`,
  LIST_ACCEPTED_CANDIDATE_ASSERTIONS: `
    SELECT a.assertion_id, a.tenant_id, a.project_id, a.predicate,
           a.object_json, a.accepted_generation, e.canonical_label,
           GROUP_CONCAT(COALESCE(me.source_excerpt, ''), CHAR(10))
             AS evidence_excerpt
      FROM memory_assertions a
      JOIN memory_entities e
        ON e.tenant_id = a.tenant_id
       AND e.project_id = a.project_id
       AND e.entity_id = a.subject_entity_id
      LEFT JOIN memory_assertion_evidence ae
        ON ae.tenant_id = a.tenant_id
       AND ae.project_id = a.project_id
       AND ae.assertion_id = a.assertion_id
      LEFT JOIN memory_evidence me
        ON me.tenant_id = ae.tenant_id
       AND me.project_id = ae.project_id
       AND me.evidence_id = ae.evidence_id
     WHERE a.tenant_id = ? AND a.project_id = ? AND a.candidate_id = ?
       AND a.lifecycle_state = 'accepted'
     GROUP BY a.assertion_id`,
  SUPERSEDE_ORPHAN_ENTITIES: `
    UPDATE memory_entities
       SET lifecycle_state = 'superseded', updated_at = ?
     WHERE tenant_id = ? AND project_id = ? AND lifecycle_state = 'accepted'
       AND NOT EXISTS (
         SELECT 1 FROM memory_assertions
          WHERE memory_assertions.tenant_id = memory_entities.tenant_id
            AND memory_assertions.project_id = memory_entities.project_id
            AND memory_assertions.subject_entity_id = memory_entities.entity_id
            AND memory_assertions.lifecycle_state = 'accepted'
       )`
});

export async function validateMemoryCandidate({
  env,
  principal,
  candidateId,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  const candidate = await requireCandidate(
    env,
    principal,
    candidateId,
    "memory.validate"
  );
  if (candidate.state !== "pending_validation") {
    return candidateState(candidate);
  }

  let normalized;
  let reasonCode = null;
  try {
    normalized = normalizeCandidatePayload(JSON.parse(candidate.payload_json));
    const observedHash = await canonicalHash(normalized);
    if (observedHash !== candidate.payload_hash) {
      reasonCode = "PAYLOAD_HASH_MISMATCH";
    }
  } catch (error) {
    reasonCode = error instanceof GraphMemoryError
      ? error.code
      : "MALFORMED_CANDIDATE_PAYLOAD";
  }

  const state = reasonCode ? "quarantined" : "pending_review";
  const createdAt = now().toISOString();
  const decisionId = `decision_${randomUUID()}`;
  const receipt = {
    decision_id: decisionId,
    candidate_id: candidate.candidate_id,
    decision_type: "validation",
    outcome: state,
    reason_code: reasonCode,
    created_at: createdAt
  };
  const receiptHash = await canonicalHash(receipt);
  await env.DB.batch([
    env.DB.prepare(SQL.INSERT_DECISION).bind(
      decisionId,
      candidate.tenant_id,
      candidate.project_id,
      candidate.candidate_id,
      null,
      null,
      "validation",
      state,
      reasonCode,
      receiptHash,
      principal.credential_id,
      createdAt
    ),
    env.DB.prepare(SQL.UPDATE_CANDIDATE).bind(
      state,
      reasonCode,
      createdAt,
      candidate.candidate_id,
      candidate.tenant_id
    )
  ]);

  return {
    candidate_id: candidate.candidate_id,
    state,
    ...(reasonCode ? { reason_code: reasonCode } : {})
  };
}

export async function evaluateMemoryCandidate(input) {
  return validateMemoryCandidate(input);
}

export async function resolveMemoryCandidate({
  env,
  principal,
  candidateId,
  entityMatches = [],
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  const candidate = await requireCandidate(
    env,
    principal,
    candidateId,
    "memory.resolve"
  );
  if (candidate.state !== "pending_review") {
    return candidateState(candidate);
  }

  const ordered = [...entityMatches].sort(
    (left, right) => Number(right.confidence) - Number(left.confidence)
  );
  const ambiguous = ordered.length > 1 && (
    Number(ordered[0].confidence) < 0.9 ||
    Number(ordered[0].confidence) - Number(ordered[1].confidence) < 0.05
  );
  if (!ambiguous) {
    return {
      candidate_id: candidate.candidate_id,
      state: "pending_review",
      resolved_entity_id: ordered[0]?.entity_id || null
    };
  }

  const reasonCode = "AMBIGUOUS_ENTITY_MATCH";
  const createdAt = now().toISOString();
  const decisionId = `decision_${randomUUID()}`;
  const receiptHash = await canonicalHash({
    decision_id: decisionId,
    candidate_id: candidate.candidate_id,
    matches: ordered,
    reason_code: reasonCode,
    created_at: createdAt
  });
  await env.DB.batch([
    env.DB.prepare(SQL.INSERT_DECISION).bind(
      decisionId,
      candidate.tenant_id,
      candidate.project_id,
      candidate.candidate_id,
      null,
      null,
      "resolution",
      "quarantined",
      reasonCode,
      receiptHash,
      principal.credential_id,
      createdAt
    ),
    env.DB.prepare(SQL.UPDATE_CANDIDATE).bind(
      "quarantined",
      reasonCode,
      createdAt,
      candidate.candidate_id,
      candidate.tenant_id
    )
  ]);
  return {
    candidate_id: candidate.candidate_id,
    state: "quarantined",
    reason_code: reasonCode
  };
}

export async function publishMemoryCandidate({
  env,
  principal,
  candidateId,
  payloadOverride = null,
  editRecord = null,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  const candidate = await requireCandidate(
    env,
    principal,
    candidateId,
    "memory.publish"
  );
  if (candidate.state !== "pending_review") {
    throw new GraphMemoryError(
      "CANDIDATE_NOT_REVIEWED",
      "Candidate requires successful validation and review",
      409
    );
  }

  const payload = normalizeCandidatePayload(
    payloadOverride ?? JSON.parse(candidate.payload_json)
  );
  const evidence = (await env.DB.prepare(SQL.LIST_EVIDENCE).bind(
    candidate.tenant_id,
    candidate.project_id,
    candidate.candidate_id
  ).all()).results || [];
  if (evidence.length === 0) {
    throw new GraphMemoryError(
      "EVIDENCE_REQUIRED",
      "Publication requires immutable evidence",
      422
    );
  }

  const acceptedBefore = await acceptedView(
    env,
    candidate.tenant_id,
    candidate.project_id
  );
  const preSnapshotHash = await canonicalHash(acceptedBefore);
  const generationRow = await env.DB.prepare(SQL.NEXT_GENERATION).bind(
    candidate.tenant_id,
    candidate.project_id
  ).first();
  const generation = Number(generationRow.generation);
  const createdAt = now().toISOString();
  const snapshotId = `snapshot_${randomUUID()}`;
  const publicationDecisionId = `decision_${randomUUID()}`;
  const statements = [
    env.DB.prepare(SQL.INSERT_SNAPSHOT).bind(
      snapshotId,
      candidate.tenant_id,
      candidate.project_id,
      generation,
      JSON.stringify(acceptedBefore.entities.map(row => row.entity_id)),
      JSON.stringify(acceptedBefore),
      preSnapshotHash,
      principal.credential_id,
      createdAt
    )
  ];
  if (editRecord) {
    const editedPayloadJson = JSON.stringify(payload);
    statements.push(env.DB.prepare(SQL.INSERT_CANDIDATE_EDIT).bind(
      editRecord.edit_id,
      candidate.candidate_id,
      candidate.tenant_id,
      candidate.project_id,
      editedPayloadJson,
      await canonicalHash(payload),
      editRecord.reason_code || null,
      principal.credential_id,
      createdAt
    ));
  }

  for (const [index, assertion] of payload.assertions.entries()) {
    const entityId = normalizeEntityId(assertion.subject);
    const existingEntity = await env.DB.prepare(SQL.GET_ENTITY).bind(
      candidate.tenant_id,
      candidate.project_id,
      entityId
    ).first();
    if (!existingEntity) {
      statements.push(env.DB.prepare(SQL.INSERT_ENTITY).bind(
        entityId,
        candidate.tenant_id,
        candidate.project_id,
        "entity",
        "accepted",
        assertion.subject,
        createdAt,
        createdAt
      ));
    }

    const assertionId = `assertion_${randomUUID()}_${index}`;
    statements.push(env.DB.prepare(SQL.INSERT_ASSERTION).bind(
      assertionId,
      candidate.tenant_id,
      candidate.project_id,
      candidate.candidate_id,
      entityId,
      assertion.predicate,
      JSON.stringify(assertion.object),
      assertion.confidence,
      "candidate",
      null,
      null,
      evidence[0].observed_at,
      createdAt,
      generation
    ));
    for (const item of evidence) {
      statements.push(env.DB.prepare(SQL.LINK_EVIDENCE).bind(
        candidate.tenant_id,
        candidate.project_id,
        assertionId,
        item.evidence_id
      ));
    }
    const reviewDecisionId = `decision_${randomUUID()}_${index}`;
    const reviewReceiptHash = await canonicalHash({
      decision_id: reviewDecisionId,
      assertion_id: assertionId,
      outcome: "accepted",
      generation,
      created_at: createdAt
    });
    statements.push(env.DB.prepare(SQL.INSERT_DECISION).bind(
      reviewDecisionId,
      candidate.tenant_id,
      candidate.project_id,
      candidate.candidate_id,
      assertionId,
      snapshotId,
      "review",
      "accepted",
      null,
      reviewReceiptHash,
      principal.credential_id,
      createdAt
    ));
    statements.push(env.DB.prepare(SQL.ACCEPT_ASSERTION).bind(
      candidate.tenant_id,
      candidate.project_id,
      assertionId
    ));
    const projection = await buildProjectionOutboxStatement({
      db: env.DB,
      assertion: {
        assertion_id: assertionId,
        tenant_id: candidate.tenant_id,
        project_id: candidate.project_id,
        canonical_label: assertion.subject,
        predicate: assertion.predicate,
        object_json: JSON.stringify(assertion.object),
        evidence_excerpt: evidence
          .map(item => item.source_excerpt || "")
          .filter(Boolean)
          .join("\n"),
        accepted_generation: generation
      },
      now
    });
    statements.push(projection.statement);
  }

  const publicationReceiptHash = await canonicalHash({
    decision_id: publicationDecisionId,
    candidate_id: candidate.candidate_id,
    snapshot_id: snapshotId,
    generation,
    outcome: "accepted",
    created_at: createdAt
  });
  statements.push(env.DB.prepare(SQL.INSERT_DECISION).bind(
    publicationDecisionId,
    candidate.tenant_id,
    candidate.project_id,
    candidate.candidate_id,
    null,
    snapshotId,
    "publication",
    "accepted",
    null,
    publicationReceiptHash,
    principal.credential_id,
    createdAt
  ));
  statements.push(env.DB.prepare(SQL.UPDATE_CANDIDATE).bind(
    "accepted",
    null,
    createdAt,
    candidate.candidate_id,
    candidate.tenant_id
  ));
  await env.DB.batch(statements);

  return {
    candidate_id: candidate.candidate_id,
    decision_id: publicationDecisionId,
    state: "accepted",
    generation,
    pre_snapshot_hash: preSnapshotHash
  };
}

export async function rollbackMemoryDecision({
  env,
  principal,
  decisionId,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireCapability(principal, "memory.rollback");
  const decision = await env.DB.prepare(SQL.GET_DECISION).bind(
    decisionId,
    principal.tenant_id
  ).first();
  if (!decision || decision.decision_type !== "publication") {
    throw new GraphMemoryError(
      "DECISION_NOT_FOUND",
      "Publication decision is unavailable",
      404
    );
  }
  assertGraphAccess(principal, decision, "memory.rollback");
  const snapshot = await env.DB.prepare(SQL.GET_SNAPSHOT).bind(
    decision.snapshot_id,
    principal.tenant_id
  ).first();
  if (!snapshot) {
    throw new GraphMemoryError(
      "SNAPSHOT_NOT_FOUND",
      "Verified rollback snapshot is unavailable",
      409
    );
  }

  const createdAt = now().toISOString();
  const rollbackDecisionId = `decision_${randomUUID()}`;
  const supersededAssertions = (await env.DB.prepare(
    SQL.LIST_ACCEPTED_CANDIDATE_ASSERTIONS
  ).bind(
    decision.tenant_id,
    decision.project_id,
    decision.candidate_id
  ).all()).results || [];
  const statements = [
    env.DB.prepare(SQL.SUPERSEDE_ASSERTIONS).bind(
      decision.tenant_id,
      decision.project_id,
      decision.candidate_id
    ),
    env.DB.prepare(SQL.SUPERSEDE_ORPHAN_ENTITIES).bind(
      createdAt,
      decision.tenant_id,
      decision.project_id
    ),
    env.DB.prepare(SQL.INSERT_DECISION).bind(
      rollbackDecisionId,
      decision.tenant_id,
      decision.project_id,
      decision.candidate_id,
      null,
      snapshot.snapshot_id,
      "rollback",
      "restored",
      null,
      await canonicalHash({
        decision_id: rollbackDecisionId,
        restored_snapshot_hash: snapshot.snapshot_hash,
        created_at: createdAt
      }),
      principal.credential_id,
      createdAt
    )
  ];
  for (const assertion of supersededAssertions) {
    const projection = await buildProjectionOutboxStatement({
      db: env.DB,
      assertion,
      operation: "delete",
      now
    });
    statements.push(projection.statement);
  }
  await env.DB.batch(statements);
  const restored = await acceptedView(
    env,
    decision.tenant_id,
    decision.project_id
  );
  const restoredHash = await canonicalHash(restored);
  if (restoredHash !== snapshot.snapshot_hash) {
    throw new GraphMemoryError(
      "ROLLBACK_VERIFICATION_FAILED",
      "Restored accepted view does not match the verified snapshot",
      500
    );
  }

  return {
    decision_id: rollbackDecisionId,
    restored_snapshot_hash: restoredHash,
    state: "restored"
  };
}

async function requireCandidate(env, principal, candidateId, capability) {
  requireCapability(principal, capability);
  const normalizedId = String(candidateId ?? "").trim();
  const candidate = await env.DB.prepare(SQL.GET_CANDIDATE).bind(
    normalizedId,
    principal.tenant_id
  ).first();
  if (!candidate) {
    throw new GraphMemoryError(
      "CANDIDATE_NOT_FOUND",
      "Candidate is unavailable",
      404
    );
  }
  assertGraphAccess(principal, candidate, capability);
  return candidate;
}

function requireCapability(principal, capability) {
  if (!principal?.capabilities?.includes(capability)) {
    throw new GraphMemoryError(
      "CAPABILITY_DENIED",
      "The authenticated principal lacks the required capability",
      403
    );
  }
}

function candidateState(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    state: candidate.state,
    ...(candidate.reason_code ? { reason_code: candidate.reason_code } : {})
  };
}

function normalizeEntityId(value) {
  const normalized = String(value).trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (normalized.length < 2) {
    throw new GraphMemoryError(
      "INVALID_ENTITY_ID",
      "Assertion subject cannot produce a stable entity identifier",
      422
    );
  }
  return normalized;
}

async function acceptedView(env, tenantId, projectId) {
  const query = async (table, columns, orderBy) => (
    await env.DB.prepare(`
      SELECT ${columns} FROM ${table}
       WHERE tenant_id = ? AND project_id = ? AND lifecycle_state = 'accepted'
       ORDER BY ${orderBy}
    `).bind(tenantId, projectId).all()
  ).results.map(row => ({ ...row }));

  return {
    entities: await query(
      "memory_entities",
      "entity_id, ontology_type, canonical_label, valid_from, valid_to",
      "entity_id"
    ),
    relations: await query(
      "memory_relations",
      "relation_id, source_entity_id, relation_type, target_entity_id, valid_from, valid_to",
      "relation_id"
    ),
    events: await query(
      "memory_events",
      "event_id, event_type, arguments_json, occurred_at, observed_at",
      "event_id"
    ),
    assertions: await query(
      "memory_assertions",
      "assertion_id, subject_entity_id, predicate, object_json, valid_from, valid_to, observed_at",
      "assertion_id"
    )
  };
}
