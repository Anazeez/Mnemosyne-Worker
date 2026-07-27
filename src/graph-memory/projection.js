import { GraphMemoryError, canonicalHash } from "./contracts.js";

export const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

const SQL = Object.freeze({
  GET_ASSERTION: `
    SELECT a.assertion_id, a.tenant_id, a.project_id, a.predicate,
           a.object_json, a.accepted_generation, e.canonical_label,
           GROUP_CONCAT(COALESCE(me.source_excerpt, ''), CHAR(10)) AS evidence_excerpt
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
     WHERE a.assertion_id = ?
       AND a.lifecycle_state = 'accepted'
     GROUP BY a.assertion_id`,
  UPSERT_OUTBOX: `
    INSERT INTO memory_projection_outbox (
      projection_id, assertion_id, tenant_id, project_id, content_hash,
      accepted_generation, embedding_model, operation, state, attempt_count,
      last_reason_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
    ON CONFLICT(projection_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      accepted_generation = excluded.accepted_generation,
      embedding_model = excluded.embedding_model,
      operation = excluded.operation,
      state = 'pending',
      attempt_count = 0,
      last_reason_code = NULL,
      updated_at = excluded.updated_at`,
  PENDING: `
    SELECT * FROM memory_projection_outbox
     WHERE state IN ('pending', 'repair_queued')
     ORDER BY updated_at, projection_id
     LIMIT ?`,
  DELETE_SEARCH: `
    DELETE FROM memory_assertion_search
     WHERE assertion_id = ? AND tenant_id = ? AND project_id = ?`,
  INSERT_SEARCH: `
    INSERT INTO memory_assertion_search (
      assertion_id, tenant_id, project_id, document
    ) VALUES (?, ?, ?, ?)`,
  COMPLETE: `
    UPDATE memory_projection_outbox
       SET state = 'complete', attempt_count = attempt_count + 1,
           last_reason_code = NULL, updated_at = ?
     WHERE projection_id = ?`,
  FAILED: `
    UPDATE memory_projection_outbox
       SET state = 'repair_queued', attempt_count = attempt_count + 1,
           last_reason_code = ?, updated_at = ?
     WHERE projection_id = ?`
});

export async function enqueueAcceptedAssertionProjection({
  env,
  assertionId,
  operation = "upsert",
  now = () => new Date()
}) {
  requireDatabase(env);
  const row = await env.DB.prepare(SQL.GET_ASSERTION).bind(assertionId).first();
  if (!row) {
    throw new GraphMemoryError(
      "ACCEPTED_ASSERTION_NOT_FOUND",
      "Accepted assertion is unavailable for projection",
      404
    );
  }
  const queued = await buildProjectionOutboxStatement({
    db: env.DB,
    assertion: row,
    operation,
    now
  });
  await queued.statement.run();
  return { projection_id: queued.projectionId, state: "pending" };
}

export async function buildProjectionOutboxStatement({
  db,
  assertion,
  operation = "upsert",
  now = () => new Date()
}) {
  const document = projectionDocument(assertion);
  const contentHash = await canonicalHash({
    assertion_id: assertion.assertion_id,
    tenant_id: assertion.tenant_id,
    project_id: assertion.project_id,
    accepted_generation: Number(assertion.accepted_generation || 0),
    document
  });
  const timestamp = now().toISOString();
  const id = projectionId(assertion);
  return {
    projectionId: id,
    statement: db.prepare(SQL.UPSERT_OUTBOX).bind(
      id,
      assertion.assertion_id,
      assertion.tenant_id,
      assertion.project_id,
      contentHash,
      Number(assertion.accepted_generation || 0),
      EMBEDDING_MODEL,
      operation,
      timestamp,
      timestamp
    )
  };
}

export async function projectAcceptedAssertion(input) {
  const queued = await enqueueAcceptedAssertionProjection(input);
  const result = await repairPendingProjections({
    env: input.env,
    limit: 1,
    now: input.now
  });
  return {
    projectionId: queued.projection_id,
    status: result.repaired === 1 ? "complete" : "repair_queued"
  };
}

export async function repairPendingProjections({
  env,
  limit = 50,
  now = () => new Date()
}) {
  requireDatabase(env);
  const boundedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100
    ? limit
    : 50;
  const rows = (await env.DB.prepare(SQL.PENDING).bind(boundedLimit).all())
    .results || [];
  let repaired = 0;
  let failed = 0;

  for (const projection of rows) {
    const timestamp = now().toISOString();
    try {
      if (projection.operation === "delete") {
        if (!env.MATRIX_KNOWLEDGE?.deleteByIds) {
          throw projectionFailure("VECTORIZE_BINDING_UNAVAILABLE");
        }
        await env.MATRIX_KNOWLEDGE.deleteByIds([projection.projection_id]);
        await env.DB.prepare(SQL.DELETE_SEARCH).bind(
          projection.assertion_id,
          projection.tenant_id,
          projection.project_id
        ).run();
      } else {
        const assertion = await env.DB.prepare(SQL.GET_ASSERTION)
          .bind(projection.assertion_id)
          .first();
        if (!assertion) {
          throw projectionFailure("ACCEPTED_ASSERTION_NOT_FOUND");
        }
        if (!env.AI?.run) {
          throw projectionFailure("EMBEDDING_SERVICE_UNAVAILABLE");
        }
        if (!env.MATRIX_KNOWLEDGE?.upsert) {
          throw projectionFailure("VECTORIZE_BINDING_UNAVAILABLE");
        }
        const document = projectionDocument(assertion);
        let embedding;
        try {
          embedding = await env.AI.run(EMBEDDING_MODEL, { text: [document] });
        } catch {
          throw projectionFailure("EMBEDDING_SERVICE_UNAVAILABLE");
        }
        const values = embedding?.data?.[0];
        if (!Array.isArray(values)) {
          throw projectionFailure("EMBEDDING_SERVICE_UNAVAILABLE");
        }
        await env.MATRIX_KNOWLEDGE.upsert([{
          id: projection.projection_id,
          values,
          metadata: {
            assertion_id: projection.assertion_id,
            tenant_id: projection.tenant_id,
            project_id: projection.project_id,
            content_hash: projection.content_hash,
            accepted_generation: Number(projection.accepted_generation),
            embedding_model: projection.embedding_model
          }
        }]);
        await env.DB.batch([
          env.DB.prepare(SQL.DELETE_SEARCH).bind(
            projection.assertion_id,
            projection.tenant_id,
            projection.project_id
          ),
          env.DB.prepare(SQL.INSERT_SEARCH).bind(
            projection.assertion_id,
            projection.tenant_id,
            projection.project_id,
            document
          )
        ]);
      }
      await env.DB.prepare(SQL.COMPLETE).bind(
        timestamp,
        projection.projection_id
      ).run();
      repaired += 1;
    } catch (error) {
      await env.DB.prepare(SQL.FAILED).bind(
        error?.reasonCode || "SEMANTIC_PROJECTION_UNAVAILABLE",
        timestamp,
        projection.projection_id
      ).run();
      failed += 1;
    }
  }

  return { repaired, failed };
}

function projectionId(row) {
  return `assertion:${row.tenant_id}:${row.project_id}:${row.assertion_id}`;
}

function projectionDocument(row) {
  const excerpt = String(row.evidence_excerpt || "").slice(0, 2_000);
  return [
    row.canonical_label,
    row.predicate,
    row.object_json,
    excerpt
  ].filter(Boolean).join("\n");
}

function projectionFailure(reasonCode) {
  const error = new Error(reasonCode);
  error.reasonCode = reasonCode;
  return error;
}

function requireDatabase(env) {
  if (!env?.DB) {
    throw new GraphMemoryError(
      "GRAPH_MEMORY_UNAVAILABLE",
      "Authoritative graph memory is unavailable",
      503
    );
  }
}
