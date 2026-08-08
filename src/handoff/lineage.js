import {
  HandoffError,
  handoffPayloadHash,
  normalizeHandoffEnvelope
} from "./contracts.js";
import { canonicalJson, sha256Hex } from "../continuity.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;
const HANDOFF_ID_PATTERN = /^handoff_[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_PATH_COUNT = Number.MAX_SAFE_INTEGER;

const SQL = Object.freeze({
  GET_HANDOFF: `
    SELECT *
      FROM handoffs
     WHERE tenant_id = ?
       AND project_id = ?
       AND handoff_id = ?`,
  LIST_HANDOFFS: `
    SELECT handoff_id
      FROM handoffs
     WHERE tenant_id = ?
       AND project_id = ?
     ORDER BY handoff_id`,
  LIST_EDGES: `
    SELECT handoff_id, related_handoff_id, relation_type
      FROM handoff_edges
     WHERE tenant_id = ?
       AND project_id = ?
     ORDER BY handoff_id, relation_type, related_handoff_id`,
  INSERT_HANDOFF: `
    INSERT INTO handoffs (
      handoff_id, tenant_id, project_id, schema_version, state,
      boundary_event, occurred_at, progress_state, generation, epoch_id,
      compaction_level, payload_json, payload_hash, retention_class,
      ttl_seconds, expires_at, agent_family, agent_id, session_id,
      approval_receipt_hash, approved_by_credential_id, created_at,
      accepted_at, superseded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
});

export async function createHandoffCandidate({
  env,
  envelope,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireDatabase(env);
  void randomUUID;
  const normalized = normalizeHandoffEnvelope(envelope);
  const payloadHash = await handoffPayloadHash(normalized);
  const scope = normalized.scope;
  const createdAt = toDate(now(), "created_at");

  if (
    normalized.memory.expires_at &&
    Date.parse(normalized.memory.expires_at) <= createdAt.getTime()
  ) {
    throw handoffError(
      "HANDOFF_EXPIRED",
      "Transient handoff cannot be persisted after expiration"
    );
  }

  const existing = await env.DB.prepare(SQL.GET_HANDOFF).bind(
    scope.tenant_id,
    scope.project_id,
    normalized.handoff_id
  ).first();
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw handoffError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "handoff_id is already bound to another payload",
        409
      );
    }
    return handoffProjection(existing, true);
  }

  const scopeState = await readScope(env, scope.tenant_id, scope.project_id);
  const relations = relationsFromEnvelope(normalized);
  await assertReferencedNodesExist({
    env,
    tenantId: scope.tenant_id,
    projectId: scope.project_id,
    handoffs: scopeState.handoffs,
    relations,
    epochId: normalized.boundary.epoch_id
  });
  const allHandoffs = [
    ...scopeState.handoffs,
    { handoff_id: normalized.handoff_id }
  ];
  const allEdges = [...scopeState.edges, ...relations];
  const lineageRows = await buildLineageRows({
    tenantId: scope.tenant_id,
    projectId: scope.project_id,
    handoffs: allHandoffs,
    edges: allEdges
  });

  const statements = [
    env.DB.prepare(SQL.INSERT_HANDOFF).bind(
      normalized.handoff_id,
      scope.tenant_id,
      scope.project_id,
      normalized.schema_version,
      "candidate",
      normalized.boundary.event,
      normalized.boundary.occurred_at,
      normalized.progress.state,
      normalized.memory.accepted_generation ?? 0,
      normalized.boundary.epoch_id,
      normalized.boundary.compaction_level,
      canonicalJson(normalized),
      payloadHash,
      normalized.memory.retention_class,
      normalized.memory.ttl_seconds,
      normalized.memory.expires_at,
      normalized.provenance.agent_family,
      normalized.provenance.agent_id,
      normalized.provenance.session_id,
      null,
      null,
      createdAt.toISOString(),
      null,
      null
    )
  ];

  for (const relation of relations) {
    statements.push(env.DB.prepare(`
      INSERT INTO handoff_edges (
        tenant_id, project_id, handoff_id, related_handoff_id, relation_type
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      scope.tenant_id,
      scope.project_id,
      relation.handoff_id,
      relation.related_handoff_id,
      relation.relation_type
    ));
  }

  statements.push(env.DB.prepare(`
    DELETE FROM handoff_lineage
     WHERE tenant_id = ? AND project_id = ?
  `).bind(scope.tenant_id, scope.project_id));
  statements.push(...lineageRows.map(row => env.DB.prepare(`
    INSERT INTO handoff_lineage (
      tenant_id, project_id, ancestor_handoff_id, descendant_handoff_id,
      depth, path_hash, path_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.tenant_id,
    row.project_id,
    row.ancestor_handoff_id,
    row.descendant_handoff_id,
    row.depth,
    row.path_hash,
    row.path_count
  )));

  await env.DB.batch(statements);
  return {
    handoff_id: normalized.handoff_id,
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    state: "candidate",
    payload_hash: payloadHash,
    idempotent_replay: false
  };
}

export async function acceptHandoffCandidate({
  env,
  tenantId,
  projectId,
  handoffId,
  approval,
  now = () => new Date()
}) {
  requireDatabase(env);
  const scope = normalizeScope(tenantId, projectId);
  const normalizedHandoffId = normalizeHandoffId(handoffId);
  const normalizedApproval = normalizeApproval(approval);
  const current = await env.DB.prepare(SQL.GET_HANDOFF).bind(
    scope.tenant_id,
    scope.project_id,
    normalizedHandoffId
  ).first();

  if (!current) {
    throw handoffError("HANDOFF_NOT_FOUND", "Handoff candidate was not found", 404);
  }

  if (current.state === "accepted") {
    if (
      current.approval_receipt_hash !== normalizedApproval.receipt_hash ||
      current.approved_by_credential_id !== normalizedApproval.approved_by_credential_id
    ) {
      throw handoffError(
        "IDEMPOTENCY_APPROVAL_MISMATCH",
        "Accepted handoff is bound to another approval receipt",
        409
      );
    }
    return handoffProjection(current, true);
  }

  if (current.state !== "candidate") {
    throw handoffError(
      "INVALID_HANDOFF_STATE",
      "Only candidate handoffs can be accepted",
      409
    );
  }

  const storedEnvelope = parseStoredEnvelope(current);
  const archivedHandoffIds = isCompactionEnvelope(storedEnvelope)
    ? await assertCompactionSourcesAccepted({
      env,
      scope,
      handoffId: normalizedHandoffId,
      sourceIds: storedEnvelope.boundary.supersedes
    })
    : [];
  const acceptedAt = toDate(now(), "accepted_at").toISOString();
  const statements = [
    env.DB.prepare(`
      UPDATE handoffs
         SET state = 'accepted',
             approval_receipt_hash = ?,
             approved_by_credential_id = ?,
             accepted_at = ?
       WHERE tenant_id = ?
         AND project_id = ?
         AND handoff_id = ?
         AND state = 'candidate'
    `).bind(
      normalizedApproval.receipt_hash,
      normalizedApproval.approved_by_credential_id,
      acceptedAt,
      scope.tenant_id,
      scope.project_id,
      normalizedHandoffId
    )
  ];
  for (const archivedHandoffId of archivedHandoffIds) {
    statements.push(env.DB.prepare(`
      UPDATE handoffs
         SET state = 'archived',
             superseded_at = ?
       WHERE tenant_id = ?
         AND project_id = ?
         AND handoff_id = ?
         AND state = 'accepted'
    `).bind(
      acceptedAt,
      scope.tenant_id,
      scope.project_id,
      archivedHandoffId
    ));
  }
  await env.DB.batch(statements);

  const accepted = await env.DB.prepare(SQL.GET_HANDOFF).bind(
    scope.tenant_id,
    scope.project_id,
    normalizedHandoffId
  ).first();
  return {
    ...handoffProjection(accepted, false),
    archived_handoff_ids: archivedHandoffIds
  };
}

export async function getHandoffLineage({
  env,
  tenantId,
  projectId,
  handoffId,
  direction = "ancestors",
  limit = null
}) {
  requireDatabase(env);
  const scope = normalizeScope(tenantId, projectId);
  const normalizedHandoffId = normalizeHandoffId(handoffId);
  if (direction !== "ancestors" && direction !== "descendants") {
    throw handoffError(
      "INVALID_LINEAGE_DIRECTION",
      "direction must be ancestors or descendants"
    );
  }

  const predicate = direction === "ancestors"
    ? "descendant_handoff_id = ?"
    : "ancestor_handoff_id = ?";
  const normalizedLimit = limit === null
    ? null
    : normalizeLineageLimit(limit);
  const query = `
    SELECT tenant_id, project_id, ancestor_handoff_id, descendant_handoff_id,
           depth, path_hash, path_count
      FROM handoff_lineage
     WHERE tenant_id = ?
       AND project_id = ?
       AND ${predicate}
     ORDER BY depth, ancestor_handoff_id, descendant_handoff_id${
       normalizedLimit === null ? "" : " LIMIT ?"
     }`;
  const bindings = [scope.tenant_id, scope.project_id, normalizedHandoffId];
  if (normalizedLimit !== null) bindings.push(normalizedLimit);
  const rows = await env.DB.prepare(query).bind(...bindings).all();
  return rows.results || [];
}

export async function rebuildHandoffLineage({ env, tenantId, projectId }) {
  requireDatabase(env);
  const scope = normalizeScope(tenantId, projectId);
  const scopeState = await readScope(env, scope.tenant_id, scope.project_id);
  const lineageRows = await buildLineageRows({
    tenantId: scope.tenant_id,
    projectId: scope.project_id,
    handoffs: scopeState.handoffs,
    edges: scopeState.edges
  });
  const statements = [env.DB.prepare(`
    DELETE FROM handoff_lineage
     WHERE tenant_id = ? AND project_id = ?
  `).bind(scope.tenant_id, scope.project_id)];
  statements.push(...lineageRows.map(row => env.DB.prepare(`
    INSERT INTO handoff_lineage (
      tenant_id, project_id, ancestor_handoff_id, descendant_handoff_id,
      depth, path_hash, path_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.tenant_id,
    row.project_id,
    row.ancestor_handoff_id,
    row.descendant_handoff_id,
    row.depth,
    row.path_hash,
    row.path_count
  )));
  await env.DB.batch(statements);
  return { row_count: lineageRows.length };
}

async function readScope(env, tenantId, projectId) {
  const [handoffs, edges] = await Promise.all([
    env.DB.prepare(SQL.LIST_HANDOFFS).bind(tenantId, projectId).all(),
    env.DB.prepare(SQL.LIST_EDGES).bind(tenantId, projectId).all()
  ]);
  return {
    handoffs: handoffs.results || [],
    edges: edges.results || []
  };
}

function relationsFromEnvelope(envelope) {
  const relations = [];
  if (envelope.boundary.parent_handoff_id) {
    relations.push({
      handoff_id: envelope.handoff_id,
      related_handoff_id: envelope.boundary.parent_handoff_id,
      relation_type: "parent"
    });
  }
  for (const relatedHandoffId of envelope.boundary.supersedes) {
    relations.push({
      handoff_id: envelope.handoff_id,
      related_handoff_id: relatedHandoffId,
      relation_type: "supersedes"
    });
  }
  const keys = new Set();
  return relations.filter(relation => {
    const key = `${relation.handoff_id}|${relation.related_handoff_id}|${relation.relation_type}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function assertReferencedNodesExist({
  env,
  tenantId,
  projectId,
  handoffs,
  relations,
  epochId
}) {
  const ids = new Set(handoffs.map(handoff => handoff.handoff_id));
  for (const relation of relations) {
    if (relation.handoff_id === relation.related_handoff_id) {
      throw handoffError(
        "HANDOFF_LINEAGE_SELF_EDGE",
        "Self-edge is not allowed",
        409
      );
    }
    if (!ids.has(relation.related_handoff_id)) {
      const otherScope = await env.DB.prepare(`
        SELECT 1
          FROM handoffs
         WHERE handoff_id = ?
           AND NOT (tenant_id = ? AND project_id = ?)
         LIMIT 1
      `).bind(relation.related_handoff_id, tenantId, projectId).first();
      if (otherScope) {
        throw handoffError(
          "CROSS_SCOPE_LINEAGE",
          "Lineage cannot cross tenant or project scope",
          409
        );
      }
      throw handoffError(
        "MISSING_LINEAGE_PARENT",
        "Every parent or superseded handoff must exist in the same scope",
        409
      );
    }
  }
  if (epochId && !ids.has(epochId)) {
    const otherScope = await env.DB.prepare(`
      SELECT 1
        FROM handoffs
       WHERE handoff_id = ?
         AND NOT (tenant_id = ? AND project_id = ?)
       LIMIT 1
    `).bind(epochId, tenantId, projectId).first();
    if (otherScope) {
      throw handoffError(
        "CROSS_SCOPE_LINEAGE",
        "Lineage cannot cross tenant or project scope",
        409
      );
    }
    throw handoffError(
      "MISSING_EPOCH",
      "epoch_id must reference a handoff in the same scope",
      409
    );
  }
}

async function buildLineageRows({ tenantId, projectId, handoffs, edges }) {
  const nodeIds = [...new Set(handoffs.map(handoff => handoff.handoff_id))].sort();
  const adjacency = new Map(nodeIds.map(nodeId => [nodeId, []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.related_handoff_id) || !adjacency.has(edge.handoff_id)) {
      throw handoffError(
        "CROSS_SCOPE_LINEAGE",
        "Lineage edge references a handoff outside the scope",
        409
      );
    }
    if (edge.handoff_id === edge.related_handoff_id) {
      throw handoffError("HANDOFF_LINEAGE_SELF_EDGE", "Self-edge is not allowed", 409);
    }
    adjacency.get(edge.related_handoff_id).push({
      child: edge.handoff_id,
      related: edge.related_handoff_id,
      relation_type: edge.relation_type
    });
  }

  for (const outgoing of adjacency.values()) {
    outgoing.sort(compareEdges);
  }
  const topological = topologicalOrder(nodeIds, adjacency);
  const rows = [];
  for (const ancestor of nodeIds) {
    const shortest = shortestPaths(ancestor, adjacency);
    const pathCounts = allPathCounts(ancestor, topological, adjacency);
    for (const descendant of nodeIds) {
      const depth = shortest.distance.get(descendant);
      if (depth === undefined) continue;
      const path = shortest.paths.get(descendant) || [];
      const pathDescriptor = descendant === ancestor
        ? { tenant_id: tenantId, project_id: projectId, self: ancestor }
        : {
          tenant_id: tenantId,
          project_id: projectId,
          edges: path.map(edge => ({
            handoff_id: edge.child,
            related_handoff_id: edge.related,
            relation_type: edge.relation_type
          }))
        };
      rows.push({
        tenant_id: tenantId,
        project_id: projectId,
        ancestor_handoff_id: ancestor,
        descendant_handoff_id: descendant,
        depth,
        path_hash: await sha256Hex(canonicalJson(pathDescriptor)),
        path_count: pathCounts.get(descendant) || 1
      });
    }
  }
  return rows;
}

function topologicalOrder(nodeIds, adjacency) {
  const indegree = new Map(nodeIds.map(nodeId => [nodeId, 0]));
  for (const outgoing of adjacency.values()) {
    for (const edge of outgoing) {
      indegree.set(edge.child, indegree.get(edge.child) + 1);
    }
  }
  const ready = nodeIds.filter(nodeId => indegree.get(nodeId) === 0).sort();
  const result = [];
  while (ready.length > 0) {
    const nodeId = ready.shift();
    result.push(nodeId);
    for (const edge of adjacency.get(nodeId) || []) {
      const next = indegree.get(edge.child) - 1;
      indegree.set(edge.child, next);
      if (next === 0) {
        ready.push(edge.child);
        ready.sort();
      }
    }
  }
  if (result.length !== nodeIds.length) {
    throw handoffError("HANDOFF_LINEAGE_CYCLE", "Lineage graph contains a cycle", 409);
  }
  return result;
}

function shortestPaths(source, adjacency) {
  const distance = new Map([[source, 0]]);
  const paths = new Map([[source, []]]);
  const queue = [source];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    const nodeDistance = distance.get(nodeId);
    for (const edge of adjacency.get(nodeId) || []) {
      const nextDistance = nodeDistance + 1;
      const nextPath = [...paths.get(nodeId), edge];
      const priorDistance = distance.get(edge.child);
      const priorPath = paths.get(edge.child);
      if (
        priorDistance === undefined ||
        nextDistance < priorDistance ||
        (nextDistance === priorDistance && comparePath(nextPath, priorPath) < 0)
      ) {
        distance.set(edge.child, nextDistance);
        paths.set(edge.child, nextPath);
        queue.push(edge.child);
      }
    }
  }
  return { distance, paths };
}

function allPathCounts(source, topological, adjacency) {
  const counts = new Map([[source, 1]]);
  for (const nodeId of topological) {
    const count = counts.get(nodeId);
    if (!count) continue;
    for (const edge of adjacency.get(nodeId) || []) {
      const current = counts.get(edge.child) || 0;
      counts.set(edge.child, Math.min(MAX_PATH_COUNT, current + count));
    }
  }
  return counts;
}

function compareEdges(left, right) {
  return edgeKey(left).localeCompare(edgeKey(right));
}

function comparePath(left, right) {
  if (!right) return -1;
  const leftKey = left.map(edgeKey).join("|");
  const rightKey = right.map(edgeKey).join("|");
  return leftKey.localeCompare(rightKey);
}

function edgeKey(edge) {
  return `${edge.related}->${edge.child}:${edge.relation_type}`;
}

function normalizeScope(tenantId, projectId) {
  const tenant = String(tenantId ?? "").trim().toLowerCase();
  const project = String(projectId ?? "").trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(tenant)) {
    throw handoffError("INVALID_TENANT_ID", "tenant_id is invalid");
  }
  if (!PROJECT_ID_PATTERN.test(project)) {
    throw handoffError("INVALID_PROJECT_ID", "project_id is invalid");
  }
  return { tenant_id: tenant, project_id: project };
}

function normalizeLineageLimit(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 10_000) {
    throw handoffError(
      "INVALID_LINEAGE_LIMIT",
      "lineage limit must be between 1 and 10000"
    );
  }
  return normalized;
}

function normalizeHandoffId(value) {
  const normalized = String(value ?? "").trim();
  if (!HANDOFF_ID_PATTERN.test(normalized)) {
    throw handoffError("INVALID_HANDOFF_ID", "handoff_id is invalid");
  }
  return normalized;
}

function normalizeApproval(value) {
  if (!value || value.approved !== true) {
    throw handoffError(
      "APPROVAL_REQUIRED",
      "A verified user approval is required before acceptance"
    );
  }
  const credentialId = String(value.approved_by_credential_id ?? "").trim();
  const receiptHash = String(value.receipt_hash ?? "").trim().toLowerCase();
  if (!ID_PATTERN.test(credentialId) || !HASH_PATTERN.test(receiptHash)) {
    throw handoffError(
      "APPROVAL_REQUIRED",
      "Approval must include a bounded credential ID and SHA-256 receipt hash"
    );
  }
  return {
    approved_by_credential_id: credentialId,
    receipt_hash: receiptHash
  };
}

function toDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw handoffError("INVALID_TIMESTAMP", `${field} must be a valid timestamp`);
  }
  return date;
}

function handoffProjection(row, idempotentReplay) {
  return {
    handoff_id: row.handoff_id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    state: row.state,
    payload_hash: row.payload_hash,
    idempotent_replay: idempotentReplay
  };
}

function isCompactionEnvelope(envelope) {
  return ["epoch", "project_snapshot"].includes(
    envelope.boundary.compaction_level
  );
}

async function assertCompactionSourcesAccepted({
  env,
  scope,
  handoffId,
  sourceIds
}) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw handoffError(
      "COMPACTION_SOURCES_REQUIRED",
      "An epoch must explicitly cover at least one source handoff",
      409
    );
  }
  if (sourceIds.includes(handoffId)) {
    throw handoffError(
      "COMPACTION_SELF_SOURCE",
      "An epoch cannot cover itself",
      409
    );
  }
  const placeholders = sourceIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    SELECT handoff_id, state
      FROM handoffs
     WHERE tenant_id = ?
       AND project_id = ?
       AND handoff_id IN (${placeholders})
  `).bind(
    scope.tenant_id,
    scope.project_id,
    ...sourceIds
  ).all();
  const states = new Map((result.results || []).map(row => [
    row.handoff_id,
    row.state
  ]));
  for (const sourceId of sourceIds) {
    if (!states.has(sourceId)) {
      throw handoffError(
        "COMPACTION_SOURCE_MISSING",
        "Every epoch source must exist in the same tenant and project scope",
        409,
        { handoff_id: sourceId }
      );
    }
    if (states.get(sourceId) !== "accepted") {
      throw handoffError(
        "COMPACTION_SOURCE_NOT_ACCEPTED",
        "Every epoch source must still be accepted before compaction",
        409,
        { handoff_id: sourceId, state: states.get(sourceId) }
      );
    }
  }
  return [...sourceIds];
}

function parseStoredEnvelope(row) {
  try {
    return normalizeHandoffEnvelope(JSON.parse(row.payload_json));
  } catch {
    throw handoffError(
      "INVALID_STORED_HANDOFF",
      "Stored handoff payload cannot be normalized",
      409,
      { handoff_id: row.handoff_id }
    );
  }
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function" || typeof env.DB.batch !== "function") {
    throw handoffError("DATABASE_REQUIRED", "D1 database binding is required", 503);
  }
}

function handoffError(code, message, status = 400, details = undefined) {
  return new HandoffError(code, message, status, details);
}
