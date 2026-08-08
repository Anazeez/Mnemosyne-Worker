import {
  HANDOFF_LIMITS,
  HandoffError,
  handoffPayloadHash,
  normalizeHandoffEnvelope
} from "./contracts.js";
import { canonicalJson, sha256Hex } from "../continuity.js";

export const EPOCH_COMPACTION_LIMITS = Object.freeze({
  max_source_handoffs: HANDOFF_LIMITS.list_items,
  max_summary_items: HANDOFF_LIMITS.list_items,
  max_designated_files: HANDOFF_LIMITS.designated_files
});

const SQL = Object.freeze({
  LIST_ACCEPTED: `
    SELECT handoff_id, tenant_id, project_id, state, generation,
           compaction_level, payload_json, payload_hash, accepted_at,
           occurred_at
      FROM handoffs
     WHERE tenant_id = ?
       AND project_id = ?
       AND state = 'accepted'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY generation, accepted_at, occurred_at, handoff_id`
});

/**
 * Compile the accepted scope into one bounded epoch envelope. The source IDs
 * remain explicit in boundary.supersedes and the closure table retains the
 * complete historical graph after the source rows are archived.
 */
export async function buildEpochEnvelope({
  sourceRows,
  occurredAt,
  handoffId,
  event = "phase_complete",
  compactionLevel = "epoch",
  anchorEpochId = null,
  parentHandoffId = null,
  agentFamily = "other",
  agentId = "mnemosyne-compactor",
  sessionId = "mnemosyne-compaction",
  sourceRefs = []
}) {
  const rows = normalizeSourceRows(sourceRows);
  if (rows.length === 0) {
    throw compactionError(
      "COMPACTION_NO_SOURCES",
      "At least one accepted handoff is required to build an epoch"
    );
  }
  if (rows.length > EPOCH_COMPACTION_LIMITS.max_source_handoffs) {
    throw compactionError(
      "COMPACTION_SOURCE_LIMIT",
      "Epoch compaction requires an intermediate epoch before covering more source handoffs",
      409,
      {
        source_count: rows.length,
        max_source_handoffs: EPOCH_COMPACTION_LIMITS.max_source_handoffs
      }
    );
  }

  const envelopes = rows.map(row => row.envelope);
  const latest = envelopes[envelopes.length - 1];
  const sourceIds = rows.map(row => row.handoff_id);
  const timestamp = normalizeTimestamp(occurredAt);
  const epochId = handoffId || await deriveEpochId({
    sourceRows: rows,
    occurredAt: timestamp,
    event,
    compactionLevel
  });
  const sourceDigest = await sha256Hex(canonicalJson({
    epoch_id: epochId,
    source_ids: sourceIds,
    source_hashes: rows.map(row => row.payload_hash),
    occurred_at: timestamp
  }));
  const markers = [];

  const decisions = boundedObjects(
    [{
      statement: `Epoch ${epochId} covers accepted handoffs: ${sourceIds.join(", ")}`,
      source_ref: `mnemosyne:lineage:${epochId}`,
      observed_at: timestamp
    }, ...envelopes.flatMap(envelope => envelope.decisions)],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    item => canonicalJson(item),
    "decisions",
    markers
  );
  const changes = boundedObjects(
    [{
      path: `mnemosyne/epoch/${epochId}`,
      operation: "configure",
      summary: `Compile ${sourceIds.length} accepted handoffs into a bounded epoch resume anchor`,
      diff_ref: `mnemosyne:epoch:${epochId}`,
      diff_hash: sourceDigest,
      verification_refs: [`mnemosyne:epoch-input:${epochId}`]
    }, ...envelopes.flatMap(envelope => envelope.changes)],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    item => canonicalJson(item),
    "changes",
    markers
  );
  const verification = boundedObjects(
    [{
      name: "epoch compaction input",
      status: "passed",
      command: "SELECT accepted handoffs for the scoped project",
      reproduction_step: "Read the accepted epoch resource and traverse its lineage",
      expected: `The epoch covers ${sourceIds.length} accepted handoff(s)`,
      evidence: sourceIds.join(", ")
    }, ...envelopes.flatMap(envelope => envelope.verification)],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    item => canonicalJson(item),
    "verification",
    markers
  );

  const designatedFiles = boundedObjects(
    envelopes.flatMap(envelope => envelope.source_of_truth.designated_files),
    EPOCH_COMPACTION_LIMITS.max_designated_files,
    item => item.path,
    "source_of_truth.designated_files",
    markers
  );
  const successCriteria = boundedStrings(
    envelopes.flatMap(envelope => envelope.project.success_criteria),
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "project.success_criteria",
    markers
  );
  const completed = boundedStrings(
    [
      ...envelopes.flatMap(envelope => envelope.progress.completed),
      `Compacted ${sourceIds.length} accepted handoff(s) into epoch ${epochId}`
    ],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "progress.completed",
    markers
  );
  const remaining = boundedStrings(
    [
      ...latest.progress.remaining,
      "Read the latest accepted epoch and active post-epoch handoff before continuing"
    ],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "progress.remaining",
    markers
  );
  let blockers = boundedStrings(
    [...envelopes.flatMap(envelope => envelope.blockers), ...markers],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "blockers",
    null,
    { includeMarker: true }
  );
  const rejectedHypotheses = boundedStrings(
    envelopes.flatMap(envelope => envelope.rejected_hypotheses),
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "rejected_hypotheses",
    blockers
  );
  const doNotRepeat = boundedStrings(
    envelopes.flatMap(envelope => envelope.do_not_repeat),
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "do_not_repeat",
    blockers
  );
  const sourceRefList = boundedStrings(
    [
      ...sourceIds.map(id => `handoff:${id}`),
      ...sourceRefs,
      ...envelopes.flatMap(envelope => envelope.provenance.source_refs)
    ],
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "provenance.source_refs",
    blockers
  );
  const deniedEffects = mergeStrings(
    envelopes.flatMap(envelope => envelope.authority.denied_effects)
  );
  if (deniedEffects.length > EPOCH_COMPACTION_LIMITS.max_summary_items) {
    throw compactionError(
      "COMPACTION_AUTHORITY_LIMIT",
      "Epoch compaction refuses to truncate denied authority effects",
      409,
      { denied_effect_count: deniedEffects.length }
    );
  }

  const allowedEffectSets = envelopes.map(envelope =>
    new Set(envelope.authority.allowed_effects)
  );
  const allowedEffects = mergeStrings(
    [...(allowedEffectSets[0] || [])].filter(effect =>
      allowedEffectSets.every(effects => effects.has(effect))
    )
  );
  const objectiveConflict = new Set(
    envelopes.map(envelope => envelope.project.objective)
  ).size > 1;
  const sourceTruthConflict = new Set(
    envelopes.map(envelope => `${envelope.source_of_truth.repository}@${envelope.source_of_truth.revision}`)
  ).size > 1;
  if (objectiveConflict) {
    blockers.push(
      "Compaction conflict: source handoffs disagree on the project objective; the latest objective is retained and lineage remains authoritative."
    );
  }
  if (sourceTruthConflict) {
    blockers.push(
      "Compaction conflict: source handoffs reference multiple revisions; the latest source-of-truth revision is retained."
    );
  }
  blockers = boundedStrings(
    blockers,
    EPOCH_COMPACTION_LIMITS.max_summary_items,
    "blockers",
    null,
    { includeMarker: true }
  );

  const generation = Math.max(
    ...rows.map(row => Number(row.generation || 0)),
    ...envelopes.map(envelope => Number(envelope.memory.accepted_generation || 0))
  ) + 1;
  const sourceEpoch = [...rows]
    .reverse()
    .find(row => ["epoch", "project_snapshot"].includes(row.compaction_level));

  return normalizeHandoffEnvelope({
    schema_version: "handoff.v1",
    handoff_id: epochId,
    scope: latest.scope,
    boundary: {
      event,
      occurred_at: timestamp,
      parent_handoff_id: parentHandoffId || latest.handoff_id,
      supersedes: sourceIds,
      epoch_id: anchorEpochId || sourceEpoch?.handoff_id || null,
      compaction_level: compactionLevel
    },
    progress: {
      state: "ready_for_handoff",
      checkpoint: `epoch-${epochId}`,
      completed,
      remaining
    },
    project: {
      objective: latest.project.objective,
      success_criteria: successCriteria.length > 0
        ? successCriteria
        : ["Resume from the accepted epoch and preserve lineage provenance"]
    },
    source_of_truth: {
      repository: latest.source_of_truth.repository,
      revision: latest.source_of_truth.revision,
      worktree: latest.source_of_truth.worktree,
      designated_files: designatedFiles
    },
    decisions,
    changes,
    verification,
    blockers,
    rejected_hypotheses: rejectedHypotheses,
    next_action: latest.next_action,
    do_not_repeat: doNotRepeat,
    authority: {
      allowed_effects: allowedEffects,
      denied_effects: deniedEffects
    },
    provenance: {
      agent_family: agentFamily,
      agent_id: agentId,
      session_id: sessionId,
      observed_at: timestamp,
      source_refs: sourceRefList,
      content_hash: null
    },
    memory: {
      accepted_generation: generation,
      idempotency_key: `epoch-${epochId}`,
      retention_class: "project",
      ttl_seconds: null,
      expires_at: null,
      sensitivity: "non-secret"
    }
  });
}

/**
 * Read the current accepted anchor plus post-anchor handoffs and create one
 * local pending-confirmation draft. This function never writes D1; the exact
 * returned draft must pass through the owner-controlled handoff.accept adapter.
 */
export async function compactAcceptedHandoffs({
  env,
  tenantId,
  projectId,
  occurredAt = new Date().toISOString(),
  handoffId = null,
  event = "phase_complete",
  compactionLevel = "epoch",
  anchorEpochId = null,
  parentHandoffId = null,
  agentFamily = "other",
  agentId = "mnemosyne-compactor",
  sessionId = "mnemosyne-compaction",
  sourceRefs = []
}) {
  requireDatabase(env);
  const scope = normalizeScope(tenantId, projectId);
  const compactionAt = normalizeTimestamp(occurredAt);
  const rows = await env.DB.prepare(SQL.LIST_ACCEPTED).bind(
    scope.tenant_id,
    scope.project_id,
    compactionAt
  ).all();
  const acceptedRows = (rows.results || []).map(row => ({
    ...row,
    envelope: parseStoredEnvelope(row)
  }));
  if (acceptedRows.length === 0) {
    throw compactionError(
      "COMPACTION_NO_ACCEPTED_HANDOFFS",
      "No accepted handoffs are available for epoch compaction",
      409
    );
  }
  if (acceptedRows.length > EPOCH_COMPACTION_LIMITS.max_source_handoffs) {
    throw compactionError(
      "COMPACTION_SOURCE_LIMIT",
      "Epoch compaction requires an intermediate epoch before covering more source handoffs",
      409,
      {
        source_count: acceptedRows.length,
        max_source_handoffs: EPOCH_COMPACTION_LIMITS.max_source_handoffs
      }
    );
  }

  const envelope = await buildEpochEnvelope({
    sourceRows: acceptedRows,
    occurredAt: compactionAt,
    handoffId,
    event,
    compactionLevel,
    anchorEpochId,
    parentHandoffId,
    agentFamily,
    agentId,
    sessionId,
    sourceRefs
  });
  const payloadHash = await handoffPayloadHash(envelope);
  return {
    status: "pending_confirmation",
    confirmation_required: true,
    accepted: false,
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    handoff_id: envelope.handoff_id,
    payload_hash: payloadHash,
    confirmation_id: `handoff_confirmation_${payloadHash.slice(0, 32)}`,
    covered_handoff_ids: [...envelope.boundary.supersedes],
    local_draft: envelope
  };
}

async function deriveEpochId({ sourceRows, occurredAt, event, compactionLevel }) {
  const digest = await sha256Hex(canonicalJson({
    source_ids: sourceRows.map(row => row.handoff_id),
    source_hashes: sourceRows.map(row => row.payload_hash),
    occurred_at: occurredAt,
    event,
    compaction_level: compactionLevel
  }));
  return `handoff_epoch_${digest.slice(0, 32)}`;
}

function normalizeSourceRows(sourceRows) {
  if (!Array.isArray(sourceRows)) {
    throw compactionError("COMPACTION_NO_SOURCES", "sourceRows must be an array");
  }
  return sourceRows.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw compactionError("COMPACTION_INVALID_SOURCE", `sourceRows[${index}] is invalid`);
    }
    const envelope = row.envelope
      ? normalizeHandoffEnvelope(row.envelope)
      : parseStoredEnvelope(row);
    const handoffId = String(row.handoff_id || envelope.handoff_id);
    if (handoffId !== envelope.handoff_id) {
      throw compactionError(
        "COMPACTION_SOURCE_MISMATCH",
        "A source row ID does not match its envelope",
        409
      );
    }
    return {
      ...row,
      handoff_id: handoffId,
      payload_hash: String(row.payload_hash || ""),
      envelope
    };
  });
}

function parseStoredEnvelope(row) {
  try {
    return normalizeHandoffEnvelope(JSON.parse(row.payload_json));
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw compactionError(
      "COMPACTION_INVALID_SOURCE",
      "An accepted handoff contains invalid stored payload",
      409,
      { handoff_id: row.handoff_id }
    );
  }
}

function boundedObjects(items, maximum, key, field, markers) {
  const unique = uniqueBy(items, key);
  if (unique.length <= maximum) return unique;
  markers.push(`Compaction truncated ${field}: retained ${maximum} of ${unique.length}; consult lineage for the complete source records.`);
  return unique.slice(0, maximum);
}

function boundedStrings(items, maximum, field, markers, { includeMarker = false } = {}) {
  const unique = mergeStrings(items);
  if (unique.length <= maximum) return unique;
  const marker = `Compaction truncated ${field}: retained ${maximum} of ${unique.length}; consult lineage for the complete source records.`;
  if (markers) {
    markers.push(marker);
  }
  return includeMarker
    ? [...unique.slice(0, Math.max(0, maximum - 1)), marker]
    : unique.slice(0, maximum);
}

function uniqueBy(items, key) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const identity = key(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(item);
  }
  return unique;
}

function mergeStrings(items) {
  return uniqueBy(
    items.map(item => String(item)),
    item => item
  );
}

function normalizeScope(tenantId, projectId) {
  const tenant = String(tenantId ?? "").trim().toLowerCase();
  const project = String(projectId ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(tenant)) {
    throw compactionError("INVALID_TENANT_ID", "tenant_id is invalid");
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(project)) {
    throw compactionError("INVALID_PROJECT_ID", "project_id is invalid");
  }
  return { tenant_id: tenant, project_id: project };
}

function normalizeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw compactionError("INVALID_TIMESTAMP", "occurredAt must be a valid timestamp");
  }
  return date.toISOString();
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw compactionError(
      "HANDOFF_MEMORY_UNAVAILABLE",
      "Authoritative handoff memory is unavailable",
      503
    );
  }
}

function compactionError(code, message, status = 400, details = undefined) {
  return new HandoffError(code, message, status, details);
}
