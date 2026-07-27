import {
  GraphMemoryError,
  canonicalHash,
} from "./contracts.js";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CANDIDATE_ID = /^candidate_[a-zA-Z0-9._:-]{8,128}$/;
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function exportMemoryScope({ env, principal, scope }) {
  requireCapability(principal, "memory.export");
  requireDatabase(env);
  const normalized = normalizePrivacyScope(scope);
  assertAdministrativeScope(principal, normalized);
  const entityScope = tableScope(normalized, "memory_entities");
  const relationScope = tableScope(normalized, "memory_relations");
  const eventScope = tableScope(normalized, "memory_events");
  const assertionScope = tableScope(normalized, "memory_assertions");
  const evidenceScope = tableScope(normalized, "memory_evidence");
  const decisionScope = tableScope(normalized, "memory_decisions");
  const [entities, relations, events, assertions, evidence, decisions] =
    await Promise.all([
      select(env.DB, `
        SELECT entity_id, project_id, ontology_type, lifecycle_state,
               canonical_label, merged_into_entity_id, valid_from, valid_to,
               created_at, updated_at
          FROM memory_entities
         WHERE ${entityScope.sql}
           AND lifecycle_state = 'accepted'
         ORDER BY project_id, entity_id`, entityScope.bindings),
      select(env.DB, `
        SELECT relation_id, project_id, source_entity_id, relation_type,
               target_entity_id, lifecycle_state, confidence, valid_from,
               valid_to, created_at
          FROM memory_relations
         WHERE ${relationScope.sql}
           AND lifecycle_state = 'accepted'
         ORDER BY project_id, relation_id`, relationScope.bindings),
      select(env.DB, `
        SELECT event_id, project_id, event_type, arguments_json, occurred_at,
               observed_at, lifecycle_state, created_at
          FROM memory_events
         WHERE ${eventScope.sql}
           AND lifecycle_state = 'accepted'
         ORDER BY project_id, event_id`, eventScope.bindings),
      select(env.DB, `
        SELECT assertion_id, project_id, subject_entity_id, predicate,
               object_json, confidence, lifecycle_state, valid_from, valid_to,
               observed_at, created_at, accepted_generation
          FROM memory_assertions
         WHERE ${assertionScope.sql}
           AND lifecycle_state = 'accepted'
         ORDER BY project_id, assertion_id`, assertionScope.bindings),
      select(env.DB, `
        SELECT evidence_id, source_ref, content_hash, observed_at, citation_json
          FROM memory_evidence
         WHERE ${evidenceScope.sql}
         ORDER BY project_id, evidence_id`, evidenceScope.bindings),
      select(env.DB, `
        SELECT decision_id, project_id, assertion_id, snapshot_id,
               decision_type, outcome, reason_code, receipt_hash, created_at
          FROM memory_decisions
         WHERE ${decisionScope.sql}
         ORDER BY project_id, decision_id`, decisionScope.bindings),
    ]);
  return {
    scope: normalized,
    entities,
    relations,
    events: events.map(parseFields(["arguments_json"])),
    assertions: assertions.map(parseFields(["object_json"])),
    evidence: evidence.map(row => ({
      evidence_id: row.evidence_id,
      source_ref: row.source_ref,
      content_hash: row.content_hash,
      observed_at: row.observed_at,
      citation: safeJson(row.citation_json),
    })),
    decisions,
  };
}

export async function deleteMemoryScope({
  env,
  principal,
  scope,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
}) {
  requireCapability(principal, "memory.delete");
  requireDatabase(env);
  const normalized = normalizePrivacyScope(scope);
  assertAdministrativeScope(principal, normalized);
  const projectionRows = await collectProjectionRows(env.DB, normalized);
  if (projectionRows.length > 0 && !env.MATRIX_KNOWLEDGE?.deleteByIds) {
    throw new GraphMemoryError(
      "GRAPH_PROJECTION_UNAVAILABLE",
      "The retrieval projection cannot be deleted safely",
      503,
    );
  }
  const projectionIds = projectionRows.map(projectionId);
  const receiptId = `deletion_${randomUUID()}`;
  const createdAt = now().toISOString();
  const counts = await collectCounts(env.DB, normalized);
  await env.DB.prepare(`
    INSERT INTO memory_deletion_receipts (
      receipt_id, scope_kind, scope_hash, deleted_counts_json,
      projection_ids_hash, projection_status, requested_by_credential_hash,
      created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(
    receiptId,
    normalized.kind,
    await canonicalHash(normalized),
    JSON.stringify(counts),
    await canonicalHash(projectionIds),
    await canonicalHash({ credential_id: principal.credential_id }),
    createdAt,
  ).run();

  const statements = deletionStatements(env.DB, normalized);
  await env.DB.batch(statements);

  try {
    for (let index = 0; index < projectionIds.length; index += 100) {
      await env.MATRIX_KNOWLEDGE.deleteByIds(
        projectionIds.slice(index, index + 100),
      );
    }
    await updateReceipt(env.DB, receiptId, "deleted", createdAt);
    return { receipt_id: receiptId, status: "deleted" };
  } catch {
    await updateReceipt(env.DB, receiptId, "repair_queued", null);
    if (env.MATRIX_PROJECTION_QUEUE?.send) {
      await env.MATRIX_PROJECTION_QUEUE.send({
        receipt_id: receiptId,
        operation: "delete_projection_ids",
      });
    }
    return { receipt_id: receiptId, status: "deleted_projection_pending" };
  }
}

export async function rebuildMemoryProjection({ env, principal, scope }) {
  requireCapability(principal, "memory.projection.rebuild");
  requireDatabase(env);
  const normalized = normalizePrivacyScope(scope);
  assertAdministrativeScope(principal, normalized);
  if (!env.AI?.run || !env.MATRIX_KNOWLEDGE?.upsert) {
    throw new GraphMemoryError(
      "GRAPH_PROJECTION_UNAVAILABLE",
      "Projection rebuild dependencies are unavailable",
      503,
    );
  }
  const rows = await collectProjectionRows(
    env.DB,
    normalized,
    true,
  );
  let upserted = 0;
  for (let index = 0; index < rows.length; index += 50) {
    const batch = rows.slice(index, index + 50);
    const embedding = await env.AI.run(EMBEDDING_MODEL, {
      text: batch.map(projectionText),
    });
    if (!Array.isArray(embedding?.data) || embedding.data.length !== batch.length) {
      throw new GraphMemoryError(
        "GRAPH_PROJECTION_FAILED",
        "Projection embeddings were incomplete",
        502,
      );
    }
    await env.MATRIX_KNOWLEDGE.upsert(batch.map((row, offset) => ({
      id: projectionId(row),
      values: embedding.data[offset],
      metadata: {
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        record_type: row.record_type,
      },
    })));
    upserted += batch.length;
  }
  return { status: "rebuilt", upserted };
}

function normalizePrivacyScope(scope) {
  const tenantId = normalizeId(scope?.tenant_id, "INVALID_PRIVACY_SCOPE");
  const projectId = scope?.project_id
    ? normalizeId(scope.project_id, "INVALID_PRIVACY_SCOPE")
    : null;
  const identityId = scope?.identity_id
    ? normalizeId(scope.identity_id, "INVALID_PRIVACY_SCOPE")
    : null;
  const candidateId = scope?.candidate_id ? String(scope.candidate_id) : null;
  if (candidateId && !CANDIDATE_ID.test(candidateId)) {
    throw invalidScope();
  }
  const selectors = [projectId, identityId, candidateId].filter(Boolean);
  if (selectors.length > 1) throw invalidScope();
  return {
    tenant_id: tenantId,
    ...(projectId && { project_id: projectId }),
    ...(identityId && { identity_id: identityId }),
    ...(candidateId && { candidate_id: candidateId }),
    kind: candidateId ? "candidate" : identityId ? "identity" : projectId ? "project" : "tenant",
  };
}

function assertAdministrativeScope(principal, scope) {
  if (principal.role === "root") return;
  if (principal.tenant_id !== scope.tenant_id) {
    throw new GraphMemoryError("TENANT_SCOPE_DENIED", "Administrative tenant denied", 403);
  }
  if (
    scope.project_id &&
    !principal.project_ids?.includes("*") &&
    !principal.project_ids?.includes(scope.project_id)
  ) {
    throw new GraphMemoryError("PROJECT_SCOPE_DENIED", "Administrative project denied", 403);
  }
}

function requireCapability(principal, capability) {
  if (!principal?.capabilities?.includes(capability)) {
    throw new GraphMemoryError(
      "CAPABILITY_DENIED",
      "The authenticated principal lacks the required capability",
      403,
    );
  }
}

function requireDatabase(env) {
  if (!env?.DB) {
    throw new GraphMemoryError(
      "GRAPH_MEMORY_UNAVAILABLE",
      "Authoritative graph memory is unavailable",
      503,
    );
  }
}

async function select(db, sql, bindings) {
  return (await db.prepare(sql).bind(...bindings).all()).results || [];
}

async function collectProjectionRows(db, scope, acceptedOnly = false) {
  const accepted = acceptedOnly ? " AND lifecycle_state = 'accepted'" : "";
  const entityScope = tableScope(scope, "memory_entities");
  const relationScope = tableScope(scope, "memory_relations");
  const assertionScope = tableScope(scope, "memory_assertions");
  const groups = await Promise.all([
    select(db, `SELECT 'entity' AS record_type, tenant_id, project_id,
      entity_id AS record_id, canonical_label AS label, ontology_type AS detail
      FROM memory_entities WHERE ${entityScope.sql}${accepted}`, entityScope.bindings),
    select(db, `SELECT 'relation' AS record_type, tenant_id, project_id,
      relation_id AS record_id, relation_type AS label,
      source_entity_id || ' -> ' || target_entity_id AS detail
      FROM memory_relations WHERE ${relationScope.sql}${accepted}`, relationScope.bindings),
    select(db, `SELECT 'assertion' AS record_type, tenant_id, project_id,
      assertion_id AS record_id, predicate AS label, object_json AS detail
      FROM memory_assertions WHERE ${assertionScope.sql}${accepted}`, assertionScope.bindings),
  ]);
  return groups.flat().sort((left, right) => projectionId(left).localeCompare(projectionId(right)));
}

async function collectCounts(db, scope) {
  const counts = {};
  for (const table of [
    "memory_entities", "memory_relations", "memory_events", "memory_candidates",
    "memory_assertions", "memory_evidence", "memory_snapshots",
    "memory_decisions", "memory_invocations",
  ]) {
    const selection = tableScope(scope, table);
    const row = await db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${selection.sql}`,
    ).bind(...selection.bindings).first();
    counts[table] = Number(row?.count || 0);
  }
  return counts;
}

function deletionStatements(db, scope) {
  const statements = [];
  const remove = table => {
    const selection = tableScope(scope, table);
    statements.push(
      db.prepare(`DELETE FROM ${table} WHERE ${selection.sql}`)
        .bind(...selection.bindings),
    );
  };
  const projectionSelection = projectionTableScope(scope);
  statements.push(
    db.prepare(
      `DELETE FROM memory_assertion_search WHERE ${projectionSelection.sql}`
    ).bind(...projectionSelection.bindings),
    db.prepare(
      `DELETE FROM memory_projection_outbox WHERE ${projectionSelection.sql}`
    ).bind(...projectionSelection.bindings)
  );
  remove("memory_assertion_evidence");
  remove("memory_decisions");
  remove("memory_evidence");
  remove("memory_assertions");
  remove("memory_relations");
  remove("memory_events");
  remove("memory_snapshots");
  remove("memory_invocations");
  remove("memory_candidates");
  const entityScope = tableScope(scope, "memory_entities");
  statements.push(db.prepare(
    `UPDATE memory_entities SET merged_into_entity_id = NULL WHERE ${entityScope.sql}`,
  ).bind(...entityScope.bindings));
  remove("memory_entities");
  for (const table of [
    "context_runway_heads",
    "context_runway_records",
    "context_runway_validations",
    "context_retrieval_receipts",
    "context_publication_attempts",
    "context_runway_invalidations",
    "context_invocations",
    "context_runways",
  ]) {
    remove(table);
  }
  return statements;
}

function projectionTableScope(scope) {
  if (scope.kind === "tenant" || scope.kind === "project") {
    return {
      sql: `tenant_id = ?${scope.project_id ? " AND project_id = ?" : ""}`,
      bindings: [
        scope.tenant_id,
        ...(scope.project_id ? [scope.project_id] : [])
      ]
    };
  }
  const selector = scope.kind === "identity"
    ? ["assistant_id = ?", scope.identity_id]
    : ["candidate_id = ?", scope.candidate_id];
  return {
    sql: `tenant_id = ? AND assertion_id IN (
      SELECT assertion_id FROM memory_assertions
       WHERE tenant_id = ? AND candidate_id IN (
         SELECT candidate_id FROM memory_candidates
          WHERE tenant_id = ? AND ${selector[0]}
       )
    )`,
    bindings: [
      scope.tenant_id,
      scope.tenant_id,
      scope.tenant_id,
      selector[1]
    ]
  };
}

function tableScope(scope, table) {
  if (scope.kind === "tenant" || scope.kind === "project") {
    return {
      sql: `tenant_id = ?${scope.project_id ? " AND project_id = ?" : ""}`,
      bindings: [scope.tenant_id, ...(scope.project_id ? [scope.project_id] : [])],
    };
  }
  const selector = scope.kind === "identity"
    ? ["assistant_id = ?", scope.identity_id]
    : ["candidate_id = ?", scope.candidate_id];
  if (table === "memory_candidates") {
    return {
      sql: `tenant_id = ? AND ${selector[0]}`,
      bindings: [scope.tenant_id, selector[1]],
    };
  }
  if (table === "memory_invocations" && scope.kind === "identity") {
    return {
      sql: "tenant_id = ? AND assistant_id = ?",
      bindings: [scope.tenant_id, scope.identity_id],
    };
  }
  if (table === "memory_assertions" || table === "memory_evidence") {
    return {
      sql: `tenant_id = ? AND candidate_id IN (
        SELECT candidate_id FROM memory_candidates
         WHERE tenant_id = ? AND ${selector[0]}
      )`,
      bindings: [scope.tenant_id, scope.tenant_id, selector[1]],
    };
  }
  if (table === "memory_decisions") {
    return {
      sql: `tenant_id = ? AND (
        candidate_id IN (
          SELECT candidate_id FROM memory_candidates
           WHERE tenant_id = ? AND ${selector[0]}
        )
        OR assertion_id IN (
          SELECT assertion_id FROM memory_assertions
           WHERE tenant_id = ? AND candidate_id IN (
             SELECT candidate_id FROM memory_candidates
              WHERE tenant_id = ? AND ${selector[0]}
           )
        )
      )`,
      bindings: [
        scope.tenant_id,
        scope.tenant_id,
        selector[1],
        scope.tenant_id,
        scope.tenant_id,
        selector[1],
      ],
    };
  }
  if (table === "memory_assertion_evidence") {
    return {
      sql: `tenant_id = ? AND assertion_id IN (
        SELECT assertion_id FROM memory_assertions
         WHERE tenant_id = ? AND candidate_id IN (
           SELECT candidate_id FROM memory_candidates
            WHERE tenant_id = ? AND ${selector[0]}
         )
      )`,
      bindings: [scope.tenant_id, scope.tenant_id, scope.tenant_id, selector[1]],
    };
  }
  if (
    scope.kind === "identity" &&
    [
      "context_runways",
      "context_runway_heads",
      "context_retrieval_receipts",
      "context_invocations",
    ].includes(table)
  ) {
    return {
      sql: "tenant_id = ? AND identity_id = ?",
      bindings: [scope.tenant_id, scope.identity_id],
    };
  }
  if (
    scope.kind === "identity" &&
    [
      "context_runway_records",
      "context_runway_validations",
      "context_publication_attempts",
      "context_runway_invalidations",
    ].includes(table)
  ) {
    return {
      sql: `tenant_id = ? AND runway_id IN (
        SELECT runway_id FROM context_runways
         WHERE tenant_id = ? AND identity_id = ?
      )`,
      bindings: [scope.tenant_id, scope.tenant_id, scope.identity_id],
    };
  }
  return {
    sql: "tenant_id = ? AND 1 = 0",
    bindings: [scope.tenant_id],
  };
}

async function updateReceipt(db, receiptId, status, completedAt) {
  await db.prepare(`
    UPDATE memory_deletion_receipts
       SET projection_status = ?, completed_at = ?
     WHERE receipt_id = ?
  `).bind(status, completedAt, receiptId).run();
}

function projectionId(row) {
  return `${row.record_type}:${row.tenant_id}:${row.project_id}:${row.record_id}`;
}

function projectionText(row) {
  return `${row.record_type}: ${row.label}; ${row.detail}`;
}

function parseFields(fields) {
  return row => {
    const output = { ...row };
    for (const field of fields) {
      output[field.replace(/_json$/, "")] = safeJson(output[field]);
      delete output[field];
    }
    return output;
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeId(value, code) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!IDENTIFIER.test(normalized)) {
    throw new GraphMemoryError(code, "Privacy scope is invalid", 400);
  }
  return normalized;
}

function invalidScope() {
  return new GraphMemoryError(
    "INVALID_PRIVACY_SCOPE",
    "Privacy scope must select one bounded tenant, project, identity, or candidate",
    400,
  );
}
