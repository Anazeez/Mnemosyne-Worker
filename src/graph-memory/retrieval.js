import {
  GraphMemoryError,
  canonicalHash,
  normalizeGraphTarget
} from "./contracts.js";
import { assertGraphAccess } from "./policy.js";

export const GRAPH_TRAVERSAL_LIMITS = Object.freeze({
  default_depth: 2,
  max_depth: 4,
  default_nodes: 50,
  max_nodes: 200,
  default_edges: 100,
  max_edges: 500,
  default_time_ms: 1_500,
  max_time_ms: 3_000
});

const SQL = Object.freeze({
  SEARCH_ASSERTIONS: `
    SELECT a.assertion_id, a.subject_entity_id, e.canonical_label,
           a.predicate, a.object_json, a.confidence, a.lifecycle_state,
           a.valid_from, a.valid_to, a.observed_at, a.accepted_generation
      FROM memory_assertions a
      JOIN memory_entities e
        ON e.tenant_id = a.tenant_id
       AND e.project_id = a.project_id
       AND e.entity_id = a.subject_entity_id
     WHERE a.tenant_id = ?
       AND a.project_id = ?
       AND a.lifecycle_state = 'accepted'
       AND (
         a.predicate LIKE ? ESCAPE '\\'
         OR a.object_json LIKE ? ESCAPE '\\'
         OR e.canonical_label LIKE ? ESCAPE '\\'
       )
     ORDER BY a.accepted_generation DESC, a.assertion_id
     LIMIT ?`,
  ASSERTION_EVIDENCE: `
    SELECT e.evidence_id, e.source_ref, e.content_hash, e.observed_at,
           e.citation_json
      FROM memory_assertion_evidence ae
      JOIN memory_evidence e
        ON e.evidence_id = ae.evidence_id
       AND e.tenant_id = ae.tenant_id
       AND e.project_id = ae.project_id
     WHERE ae.tenant_id = ?
       AND ae.project_id = ?
       AND ae.assertion_id = ?
     ORDER BY e.evidence_id`,
  GET_ENTITY: `
    SELECT entity_id, ontology_type, canonical_label, valid_from, valid_to
      FROM memory_entities
     WHERE tenant_id = ? AND project_id = ? AND entity_id = ?
       AND lifecycle_state = 'accepted'`,
  OUTGOING_RELATIONS: `
    SELECT relation_id, source_entity_id, relation_type, target_entity_id,
           confidence, valid_from, valid_to
      FROM memory_relations
     WHERE tenant_id = ? AND project_id = ? AND source_entity_id = ?
       AND lifecycle_state = 'accepted'
     ORDER BY relation_id`,
  MAX_GENERATION: `
    SELECT COALESCE(MAX(accepted_generation), 0) AS generation
      FROM memory_assertions
     WHERE tenant_id = ? AND project_id = ?
       AND lifecycle_state = 'accepted'`,
  INSERT_INVOCATION: `
    INSERT INTO memory_invocations (
      invocation_id, tenant_id, project_id, assistant_id, credential_id,
      accepted_generation, selected_assertion_ids_json,
      retrieval_receipt_hash, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
});

export async function searchAcceptedMemory({ env, principal, body }) {
  requireDatabase(env);
  const target = normalizeGraphTarget(body);
  assertGraphAccess(principal, target, "memory.search");
  const query = String(body?.query ?? "").trim();
  if (query.length < 1 || query.length > 1_000) {
    throw new GraphMemoryError(
      "INVALID_SEARCH_QUERY",
      "Search query must contain 1–1000 characters",
      400
    );
  }
  const topK = normalizeInteger(body?.top_k, 10, 1, 25, "INVALID_TOP_K");
  const pattern = `%${escapeLike(query)}%`;
  const rows = (await env.DB.prepare(SQL.SEARCH_ASSERTIONS).bind(
    target.tenant_id,
    target.project_id,
    pattern,
    pattern,
    pattern,
    topK
  ).all()).results || [];
  const assertions = [];

  for (const row of rows) {
    const evidenceRows = (await env.DB.prepare(SQL.ASSERTION_EVIDENCE).bind(
      target.tenant_id,
      target.project_id,
      row.assertion_id
    ).all()).results || [];
    assertions.push({
      assertion_id: row.assertion_id,
      subject_entity_id: row.subject_entity_id,
      canonical_label: row.canonical_label,
      predicate: row.predicate,
      object: parseJson(row.object_json),
      confidence: Number(row.confidence),
      state: row.lifecycle_state,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      observed_at: row.observed_at,
      accepted_generation: Number(row.accepted_generation || 0),
      evidence: evidenceRows.map(evidence => ({
        evidence_id: evidence.evidence_id,
        source_ref: evidence.source_ref,
        content_hash: evidence.content_hash,
        observed_at: evidence.observed_at,
        citation: parseJson(evidence.citation_json)
      }))
    });
  }

  return {
    tenant_id: target.tenant_id,
    project_id: target.project_id,
    accepted_generation: assertions.reduce(
      (maximum, assertion) => Math.max(
        maximum,
        assertion.accepted_generation
      ),
      0
    ),
    assertions,
    conflicts: materialConflicts(assertions),
    semantic_search: {
      used: false,
      reason: "D1 accepted graph satisfied the bounded query"
    }
  };
}

export async function traverseAcceptedMemory({ env, principal, body }) {
  requireDatabase(env);
  const target = normalizeGraphTarget(body);
  assertGraphAccess(principal, target, "memory.read");
  const limits = normalizeTraversalLimits(body);
  const startEntityId = normalizeEntityId(body?.start_entity_id);
  const started = performance.now();
  const queue = [{ entity_id: startEntityId, depth: 0 }];
  const seen = new Set();
  const nodes = [];
  const edges = [];
  let truncated = false;

  while (queue.length > 0) {
    if (performance.now() - started > limits.time_ms) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (seen.has(current.entity_id)) continue;
    if (nodes.length >= limits.nodes) {
      truncated = true;
      break;
    }

    const entity = await env.DB.prepare(SQL.GET_ENTITY).bind(
      target.tenant_id,
      target.project_id,
      current.entity_id
    ).first();
    if (!entity) continue;
    seen.add(current.entity_id);
    nodes.push({ ...entity, depth: current.depth });
    if (current.depth >= limits.depth) continue;

    const relations = (await env.DB.prepare(SQL.OUTGOING_RELATIONS).bind(
      target.tenant_id,
      target.project_id,
      current.entity_id
    ).all()).results || [];
    for (const relation of relations) {
      if (edges.length >= limits.edges) {
        truncated = true;
        break;
      }
      edges.push({ ...relation });
      if (!seen.has(relation.target_entity_id)) {
        queue.push({
          entity_id: relation.target_entity_id,
          depth: current.depth + 1
        });
      }
    }
  }

  return {
    tenant_id: target.tenant_id,
    project_id: target.project_id,
    start_entity_id: startEntityId,
    nodes,
    edges,
    truncated,
    limits
  };
}

export async function rehydrateAcceptedMemory({
  env,
  principal,
  body,
  now = () => new Date()
}) {
  const result = await searchAcceptedMemory({ env, principal, body });
  const invocationId = String(body?.invocation_id ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(invocationId)) {
    throw new GraphMemoryError(
      "INVALID_INVOCATION_ID",
      "invocation_id must be a bounded stable identifier",
      400
    );
  }
  const startedAt = now().toISOString();
  const assertionIds = result.assertions.map(item => item.assertion_id);
  const receiptHash = await canonicalHash({
    invocation_id: invocationId,
    tenant_id: result.tenant_id,
    project_id: result.project_id,
    accepted_generation: result.accepted_generation,
    assertion_ids: assertionIds,
    started_at: startedAt
  });
  await env.DB.prepare(SQL.INSERT_INVOCATION).bind(
    invocationId,
    result.tenant_id,
    result.project_id,
    principal.assistant_id || principal.credential_id,
    principal.credential_id,
    result.accepted_generation,
    JSON.stringify(assertionIds),
    receiptHash,
    startedAt,
    startedAt
  ).run();

  return {
    ...result,
    invocation_id: invocationId,
    retrieval_receipt_hash: receiptHash
  };
}

export function normalizeTraversalLimits(body = {}) {
  return {
    depth: normalizeInteger(
      body.max_depth,
      GRAPH_TRAVERSAL_LIMITS.default_depth,
      0,
      GRAPH_TRAVERSAL_LIMITS.max_depth,
      "TRAVERSAL_LIMIT_EXCEEDED"
    ),
    nodes: normalizeInteger(
      body.max_nodes,
      GRAPH_TRAVERSAL_LIMITS.default_nodes,
      1,
      GRAPH_TRAVERSAL_LIMITS.max_nodes,
      "TRAVERSAL_LIMIT_EXCEEDED"
    ),
    edges: normalizeInteger(
      body.max_edges,
      GRAPH_TRAVERSAL_LIMITS.default_edges,
      1,
      GRAPH_TRAVERSAL_LIMITS.max_edges,
      "TRAVERSAL_LIMIT_EXCEEDED"
    ),
    time_ms: normalizeInteger(
      body.time_budget_ms,
      GRAPH_TRAVERSAL_LIMITS.default_time_ms,
      1,
      GRAPH_TRAVERSAL_LIMITS.max_time_ms,
      "TRAVERSAL_LIMIT_EXCEEDED"
    )
  };
}

function materialConflicts(assertions) {
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < assertions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < assertions.length;
      rightIndex += 1
    ) {
      const left = assertions[leftIndex];
      const right = assertions[rightIndex];
      if (
        left.subject_entity_id === right.subject_entity_id &&
        left.predicate === right.predicate &&
        JSON.stringify(left.object) !== JSON.stringify(right.object) &&
        intervalsOverlap(left, right)
      ) {
        conflicts.push({
          assertion_ids: [left.assertion_id, right.assertion_id].sort(),
          subject_entity_id: left.subject_entity_id,
          predicate: left.predicate,
          reason_code: "OVERLAPPING_TEMPORAL_ASSERTIONS"
        });
      }
    }
  }
  return conflicts;
}

function intervalsOverlap(left, right) {
  const leftStart = timestamp(left.valid_from, Number.NEGATIVE_INFINITY);
  const rightStart = timestamp(right.valid_from, Number.NEGATIVE_INFINITY);
  const leftEnd = timestamp(left.valid_to, Number.POSITIVE_INFINITY);
  const rightEnd = timestamp(right.valid_to, Number.POSITIVE_INFINITY);
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function timestamp(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInteger(value, fallback, minimum, maximum, code) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GraphMemoryError(
      code,
      `Value must be an integer between ${minimum} and ${maximum}`,
      400
    );
  }
  return parsed;
}

function normalizeEntityId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new GraphMemoryError(
      "INVALID_ENTITY_ID",
      "start_entity_id has an invalid bounded identifier",
      400
    );
  }
  return normalized;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new GraphMemoryError(
      "STORED_GRAPH_MALFORMED",
      "Authoritative graph data is malformed",
      500
    );
  }
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
