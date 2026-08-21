import {
  GraphMemoryError,
  normalizeGraphTarget
} from "../graph-memory/contracts.js";
import { assertGraphAccess } from "../graph-memory/policy.js";
import {
  HandoffError,
  handoffPayloadHash,
  normalizeHandoffEnvelope
} from "./contracts.js";
import {
  acceptHandoffCandidate,
  createHandoffCandidate,
  getHandoffLineage
} from "./lineage.js";
import { compactAcceptedHandoffs } from "./compaction.js";

export const HANDOFF_RESOURCE_URI_TEMPLATE =
  "mnemosyne://{tenant_id}/{project_id}/handoff/latest";
export const HANDOFF_RESOURCE_MIME_TYPE = "application/json";

export const HANDOFF_RESOURCE_LIMITS = Object.freeze({
  max_handoffs: 256,
  max_lineage_rows: 512
});

const APPROVAL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;
const APPROVAL_HASH_PATTERN = /^[a-f0-9]{64}$/;

const SQL = Object.freeze({
  LIST_ACCEPTED: `
    SELECT handoff_id, tenant_id, project_id, state, boundary_event,
           occurred_at, generation, epoch_id, compaction_level,
           payload_json, payload_hash, accepted_at, expires_at
      FROM handoffs
     WHERE tenant_id = ?
       AND project_id = ?
       AND state IN ('accepted', 'superseded', 'archived')
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY generation DESC, accepted_at DESC, occurred_at DESC, handoff_id DESC
     LIMIT ?`
});

export async function proposeHandoffDraft({ principal, input }) {
  const target = assertGraphAccess(principal, input, "memory.propose");
  const envelope = normalizeHandoffEnvelope(input?.local_draft);
  if (
    envelope.scope.tenant_id !== target.tenant_id ||
    envelope.scope.project_id !== target.project_id
  ) {
    throw handoffError(
      "HANDOFF_SCOPE_MISMATCH",
      "local_draft scope must match the requested tenant and project",
      409
    );
  }

  const payloadHash = await handoffPayloadHash(envelope);
  return {
    status: "pending_confirmation",
    confirmation_required: true,
    accepted: false,
    tenant_id: target.tenant_id,
    project_id: target.project_id,
    handoff_id: envelope.handoff_id,
    payload_hash: payloadHash,
    confirmation_id: `handoff_confirmation_${payloadHash.slice(0, 32)}`,
    approval: {
      receipt_required: true,
      accepted_memory_write: false
    },
    local_draft: envelope
  };
}

/**
 * Accept exactly the draft returned by handoff.propose. This is deliberately
 * stateless at the adapter boundary: the confirmation ID and payload hash
 * bind the approval to one normalized draft, while D1 provides idempotent
 * candidate and acceptance receipts.
 */
export async function acceptHandoffDraft({
  env,
  principal,
  input,
  now = () => new Date()
}) {
  const target = assertGraphAccess(principal, input, "memory.handoff.accept");
  if (principal?.role !== "owner") {
    throw new GraphMemoryError(
      "OWNER_APPROVAL_REQUIRED",
      "Only an owner principal can accept a handoff memory write",
      403
    );
  }
  const envelope = normalizeHandoffEnvelope(input?.local_draft);
  if (
    envelope.scope.tenant_id !== target.tenant_id ||
    envelope.scope.project_id !== target.project_id
  ) {
    throw handoffError(
      "HANDOFF_SCOPE_MISMATCH",
      "local_draft scope must match the requested tenant and project",
      409
    );
  }
  const payloadHash = await handoffPayloadHash(envelope);
  const expectedConfirmationId =
    `handoff_confirmation_${payloadHash.slice(0, 32)}`;
  if (input.payload_hash !== payloadHash) {
    throw handoffError(
      "CONFIRMATION_PAYLOAD_MISMATCH",
      "Approval must include the exact payload hash returned by handoff.propose",
      409
    );
  }
  if (input.confirmation_id !== expectedConfirmationId) {
    throw handoffError(
      "CONFIRMATION_ID_MISMATCH",
      "Approval must include the exact confirmation ID returned by handoff.propose",
      409
    );
  }
  if (input?.approval?.approved !== true) {
    throw handoffError(
      "APPROVAL_REQUIRED",
      "A verified user approval is required before acceptance"
    );
  }
  if (
    String(input.approval.approved_by_credential_id || "").trim() !==
    String(principal.credential_id || "").trim()
  ) {
    throw new GraphMemoryError(
      "APPROVAL_CREDENTIAL_MISMATCH",
      "The approval credential must match the authenticated owner",
      403
    );
  }
  const approvalCredentialId = String(
    input.approval.approved_by_credential_id || ""
  ).trim();
  const approvalReceiptHash = String(input.approval.receipt_hash || "")
    .trim()
    .toLowerCase();
  if (
    !APPROVAL_ID_PATTERN.test(approvalCredentialId) ||
    !APPROVAL_HASH_PATTERN.test(approvalReceiptHash)
  ) {
    throw handoffError(
      "APPROVAL_REQUIRED",
      "Approval must include a bounded credential ID and SHA-256 receipt hash"
    );
  }

  const candidate = await createHandoffCandidate({
    env,
    envelope,
    now
  });
  const acceptance = await acceptHandoffCandidate({
    env,
    tenantId: target.tenant_id,
    projectId: target.project_id,
    handoffId: envelope.handoff_id,
    approval: input.approval,
    now
  });
  return {
    status: "accepted",
    confirmation_required: false,
    accepted: true,
    accepted_memory_write: true,
    tenant_id: target.tenant_id,
    project_id: target.project_id,
    handoff_id: envelope.handoff_id,
    payload_hash: payloadHash,
    confirmation_id: expectedConfirmationId,
    candidate,
    acceptance,
    idempotent_replay: Boolean(
      candidate.idempotent_replay && acceptance.idempotent_replay
    )
  };
}

/**
 * Compile the accepted scope into a pending epoch draft without persisting it.
 * The returned receipt is intentionally compatible with handoff.accept.
 */
export async function proposeHandoffCompaction({
  env,
  principal,
  input,
  now = () => new Date()
}) {
  const target = assertGraphAccess(principal, input, "memory.read");
  const occurredAt = input?.occurred_at || toDate(now, "compaction_time").toISOString();
  return compactAcceptedHandoffs({
    env,
    tenantId: target.tenant_id,
    projectId: target.project_id,
    occurredAt,
    event: input?.event || "phase_complete",
    agentFamily: input?.agent_family || "other",
    agentId: input?.agent_id || principal?.assistant_id || "mnemosyne-compactor",
    sessionId: input?.session_id || "mnemosyne-compaction"
  });
}

export async function readLatestHandoffResource({
  env,
  principal,
  tenantId,
  projectId,
  now = () => new Date()
}) {
  const target = assertGraphAccess(
    principal,
    normalizeGraphTarget({ tenant_id: tenantId, project_id: projectId }),
    "memory.read"
  );
  requireDatabase(env);
  const asOf = toDate(now, "resource_time").toISOString();
  const result = await env.DB.prepare(SQL.LIST_ACCEPTED).bind(
    target.tenant_id,
    target.project_id,
    asOf,
    HANDOFF_RESOURCE_LIMITS.max_handoffs + 1
  ).all();
  const rows = result.results || [];
  const truncated = rows.length > HANDOFF_RESOURCE_LIMITS.max_handoffs;
  const boundedRows = rows.slice(0, HANDOFF_RESOURCE_LIMITS.max_handoffs);
  const conflicts = [];
  const handoffs = [];
  for (const row of boundedRows) {
    try {
      handoffs.push({
        ...row,
        generation: Number(row.generation || 0),
        envelope: JSON.parse(row.payload_json)
      });
    } catch {
      conflicts.push({
        code: "INVALID_STORED_PAYLOAD",
        handoff_id: String(row.handoff_id)
      });
    }
  }

  const latest = [...handoffs].sort(compareLatest);
  const active = latest.find(row => row.state === "accepted") || null;
  const latestEpoch = latest
    .filter(row => ["epoch", "project_snapshot"].includes(row.compaction_level))
    .sort(compareLatest)[0] || null;
  const [ancestors, descendants] = active
    ? await Promise.all([
      getHandoffLineage({
        env,
        tenantId: target.tenant_id,
        projectId: target.project_id,
        handoffId: active.handoff_id,
        direction: "ancestors",
        limit: HANDOFF_RESOURCE_LIMITS.max_lineage_rows + 1
      }),
      getHandoffLineage({
        env,
        tenantId: target.tenant_id,
        projectId: target.project_id,
        handoffId: active.handoff_id,
        direction: "descendants",
        limit: HANDOFF_RESOURCE_LIMITS.max_lineage_rows + 1
      })
    ])
    : [[], []];
  const lineageTruncated =
    ancestors.length > HANDOFF_RESOURCE_LIMITS.max_lineage_rows ||
    descendants.length > HANDOFF_RESOURCE_LIMITS.max_lineage_rows;

  return {
    schema_version: "handoff.resource.v1",
    resource_uri: handoffResourceUri(target),
    scope: target,
    accepted_generation: latest.reduce(
      (highest, row) => Math.max(highest, row.generation),
      0
    ),
    latest_epoch_or_snapshot: projectHandoff(latestEpoch),
    active_handoff: projectHandoff(active),
    lineage: {
      active_handoff_id: active?.handoff_id || null,
      ancestors: ancestors.slice(0, HANDOFF_RESOURCE_LIMITS.max_lineage_rows),
      descendants: descendants.slice(0, HANDOFF_RESOURCE_LIMITS.max_lineage_rows),
      truncated: lineageTruncated
    },
    truncation: {
      applied: truncated || lineageTruncated,
      max_handoffs: HANDOFF_RESOURCE_LIMITS.max_handoffs,
      returned_handoffs: handoffs.length,
      max_lineage_rows: HANDOFF_RESOURCE_LIMITS.max_lineage_rows
    },
    conflicts
  };
}

export function handoffResourceUri(target) {
  const normalized = normalizeGraphTarget(target);
  return `mnemosyne://${normalized.tenant_id}/${normalized.project_id}/handoff/latest`;
}

function projectHandoff(row) {
  if (!row) return null;
  return {
    handoff_id: row.handoff_id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    state: row.state,
    boundary_event: row.boundary_event,
    occurred_at: row.occurred_at,
    accepted_at: row.accepted_at,
    generation: row.generation,
    epoch_id: row.epoch_id,
    compaction_level: row.compaction_level,
    payload_hash: row.payload_hash,
    envelope: row.envelope
  };
}

function compareLatest(left, right) {
  return right.generation - left.generation ||
    String(right.accepted_at || "").localeCompare(String(left.accepted_at || "")) ||
    String(right.occurred_at || "").localeCompare(String(left.occurred_at || "")) ||
    String(right.handoff_id).localeCompare(String(left.handoff_id));
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new GraphMemoryError(
      "HANDOFF_MEMORY_UNAVAILABLE",
      "Authoritative handoff memory is unavailable",
      503
    );
  }
}

function toDate(value, field) {
  const resolved = value instanceof Function ? value() : value;
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (!Number.isFinite(date.getTime())) {
    throw handoffError("INVALID_TIMESTAMP", `${field} must be a valid timestamp`);
  }
  return date;
}

function handoffError(code, message, status = 400, details = undefined) {
  return new HandoffError(code, message, status, details);
}
