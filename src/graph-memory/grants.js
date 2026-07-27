import { canonicalHash, GraphMemoryError } from "./contracts.js";

const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const ASSISTANT_PATTERN = /^oauth-[a-f0-9]{32}$/;
const PROJECT_PATTERN = /^(?:\*|[a-z0-9][a-z0-9._-]{1,63})$/;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,127}$/;
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const DEFAULT_EXCEPTION_SECONDS = 86_400;

export async function resolveAssistantGrant(db, input) {
  const target = normalizeResolutionTarget(input);
  const rows = await listGrantRows(db, target);
  const active = [];
  for (const row of rows) {
    if (row.expires_at && row.expires_at <= target.now) {
      await expireGrant(db, row, target.now);
      continue;
    }
    if (row.starts_at > target.now) continue;
    active.push(row);
  }

  const projectIds = new Set(["global-canon"]);
  for (const row of active) projectIds.add(row.project_id);
  return {
    project_ids: [...projectIds].sort(),
    grant_version: await canonicalHash({
      tenant_id: target.tenantId,
      owner_github_id: target.ownerGithubId,
      assistant_id: target.assistantId,
      receipts: active.map(row => row.current_receipt_hash).sort(),
    }),
  };
}

export async function approveAssistantGrant(db, input) {
  const grant = normalizeApproval(input);
  const existing = await db.prepare(`
    SELECT *
      FROM memory_access_grants
     WHERE tenant_id = ?
       AND owner_github_id = ?
       AND assistant_id = ?
       AND project_id = ?
       AND idempotency_key = ?
  `).bind(
    grant.tenant_id,
    grant.owner_github_id,
    grant.assistant_id,
    grant.project_id,
    grant.idempotency_key,
  ).first();
  if (existing) {
    assertReplayMatches(existing, grant);
    return publicGrant(existing);
  }

  const identityHash = await canonicalHash({
    tenant_id: grant.tenant_id,
    owner_github_id: grant.owner_github_id,
    assistant_id: grant.assistant_id,
    project_id: grant.project_id,
    idempotency_key: grant.idempotency_key,
  });
  const grantId = `grant_${identityHash.slice(0, 32)}`;
  const receipt = await buildReceipt({
    grant_id: grantId,
    tenant_id: grant.tenant_id,
    owner_github_id: grant.owner_github_id,
    assistant_id: grant.assistant_id,
    project_id: grant.project_id,
    action: "approved",
    capabilities_json: grant.capabilities_json,
    actor_id: grant.approved_by,
    reason: grant.reason,
    starts_at: grant.starts_at,
    expires_at: grant.expires_at,
    previous_receipt_hash: null,
    created_at: grant.now,
  });

  await db.batch([
    db.prepare(`
      INSERT INTO memory_access_grants (
        grant_id, tenant_id, owner_github_id, assistant_id, project_id,
        capabilities_json, status, starts_at, expires_at, approved_by,
        reason, idempotency_key, current_receipt_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      grantId,
      grant.tenant_id,
      grant.owner_github_id,
      grant.assistant_id,
      grant.project_id,
      grant.capabilities_json,
      grant.starts_at,
      grant.expires_at,
      grant.approved_by,
      grant.reason,
      grant.idempotency_key,
      receipt.receipt_hash,
      grant.now,
      grant.now,
    ),
    receiptInsert(db, receipt),
  ]);

  return {
    grant_id: grantId,
    tenant_id: grant.tenant_id,
    owner_github_id: grant.owner_github_id,
    assistant_id: grant.assistant_id,
    project_id: grant.project_id,
    capabilities: JSON.parse(grant.capabilities_json),
    status: "active",
    starts_at: grant.starts_at,
    expires_at: grant.expires_at,
    current_receipt_hash: receipt.receipt_hash,
    revoked_at: null,
  };
}

export async function revokeAssistantGrant(db, input) {
  const grantId = bounded(input?.grant_id, "grant_id", 6, 80);
  const actorId = normalized(input?.actor_id, "actor_id", ACTOR_PATTERN);
  const reason = bounded(input?.reason, "reason", 8, 500);
  const now = normalizeTimestamp(input?.now, "now");
  const row = await db.prepare(`
    SELECT *
      FROM memory_access_grants
     WHERE grant_id = ?
  `).bind(grantId).first();
  if (!row) throw grantError("GRANT_NOT_FOUND", "Access grant was not found", 404);
  if (row.status === "revoked") return publicGrant(row);

  const receipt = await buildReceipt({
    grant_id: row.grant_id,
    tenant_id: row.tenant_id,
    owner_github_id: Number(row.owner_github_id),
    assistant_id: row.assistant_id,
    project_id: row.project_id,
    action: "revoked",
    capabilities_json: row.capabilities_json,
    actor_id: actorId,
    reason,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    previous_receipt_hash: row.current_receipt_hash,
    created_at: now,
  });
  await closeGrant(db, row, receipt, now);
  return {
    ...publicGrant(row),
    status: "revoked",
    current_receipt_hash: receipt.receipt_hash,
    revoked_at: now,
  };
}

async function expireGrant(db, row, now) {
  if (row.status !== "active") return;
  const receipt = await buildReceipt({
    grant_id: row.grant_id,
    tenant_id: row.tenant_id,
    owner_github_id: Number(row.owner_github_id),
    assistant_id: row.assistant_id,
    project_id: row.project_id,
    action: "expired",
    capabilities_json: row.capabilities_json,
    actor_id: "system:grant-expiry",
    reason: "exceptional access grant expired",
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    previous_receipt_hash: row.current_receipt_hash,
    created_at: now,
  });
  await closeGrant(db, row, receipt, now);
}

async function closeGrant(db, row, receipt, now) {
  await db.batch([
    db.prepare(`
      UPDATE memory_access_grants
         SET status = 'revoked',
             current_receipt_hash = ?,
             updated_at = ?,
             revoked_at = ?
       WHERE grant_id = ?
         AND status = 'active'
    `).bind(receipt.receipt_hash, now, now, row.grant_id),
    receiptInsert(db, receipt),
  ]);
}

async function listGrantRows(db, target) {
  const result = await db.prepare(`
    SELECT *
      FROM memory_access_grants
     WHERE tenant_id = ?
       AND owner_github_id = ?
       AND assistant_id = ?
       AND status = 'active'
     ORDER BY project_id, grant_id
  `).bind(
    target.tenantId,
    target.ownerGithubId,
    target.assistantId,
  ).all();
  return result.results || [];
}

async function buildReceipt(value) {
  const receiptHash = await canonicalHash(value);
  return {
    ...value,
    receipt_id: `auth_${receiptHash.slice(0, 32)}`,
    receipt_hash: receiptHash,
  };
}

function receiptInsert(db, receipt) {
  return db.prepare(`
    INSERT INTO memory_authorization_receipts (
      receipt_id, grant_id, tenant_id, owner_github_id, assistant_id,
      project_id, action, capabilities_json, actor_id, reason, starts_at,
      expires_at, previous_receipt_hash, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    receipt.receipt_id,
    receipt.grant_id,
    receipt.tenant_id,
    receipt.owner_github_id,
    receipt.assistant_id,
    receipt.project_id,
    receipt.action,
    receipt.capabilities_json,
    receipt.actor_id,
    receipt.reason,
    receipt.starts_at,
    receipt.expires_at,
    receipt.previous_receipt_hash,
    receipt.receipt_hash,
    receipt.created_at,
  );
}

function normalizeResolutionTarget(input) {
  const ownerGithubId = Number(input?.ownerGithubId);
  if (!Number.isSafeInteger(ownerGithubId) || ownerGithubId <= 0) {
    throw grantError("INVALID_OWNER_ID", "ownerGithubId must be a positive integer");
  }
  return {
    tenantId: normalized(input?.tenantId, "tenantId", TENANT_PATTERN),
    ownerGithubId,
    assistantId: normalized(
      input?.assistantId,
      "assistantId",
      ASSISTANT_PATTERN,
    ),
    now: normalizeTimestamp(input?.now, "now"),
  };
}

function normalizeApproval(input) {
  const ownerGithubId = Number(input?.owner_github_id);
  if (!Number.isSafeInteger(ownerGithubId) || ownerGithubId <= 0) {
    throw grantError("INVALID_OWNER_ID", "owner_github_id must be positive");
  }
  const now = normalizeTimestamp(input?.now, "now");
  const startsAt = normalizeTimestamp(input?.starts_at || now, "starts_at");
  const permanent = input?.permanent === true;
  if (permanent && input?.expires_at) {
    throw grantError(
      "INVALID_GRANT_EXPIRY",
      "Permanent grants cannot include expires_at",
    );
  }
  const expiresAt = permanent
    ? null
    : normalizeTimestamp(
      input?.expires_at ||
        new Date(Date.parse(now) + DEFAULT_EXCEPTION_SECONDS * 1000).toISOString(),
      "expires_at",
    );
  if (expiresAt && expiresAt <= startsAt) {
    throw grantError(
      "INVALID_GRANT_EXPIRY",
      "expires_at must follow starts_at",
    );
  }
  const capabilities = [...new Set(
    (Array.isArray(input?.capabilities) ? input.capabilities : [])
      .map(value => String(value).trim())
      .filter(value => /^[a-z][a-z.]{2,63}$/.test(value)),
  )].sort();
  if (capabilities.length === 0) {
    throw grantError(
      "INVALID_GRANT_CAPABILITIES",
      "At least one bounded capability is required",
    );
  }
  return {
    tenant_id: normalized(input?.tenant_id, "tenant_id", TENANT_PATTERN),
    owner_github_id: ownerGithubId,
    assistant_id: normalized(
      input?.assistant_id,
      "assistant_id",
      ASSISTANT_PATTERN,
    ),
    project_id: normalized(input?.project_id, "project_id", PROJECT_PATTERN),
    capabilities_json: JSON.stringify(capabilities),
    approved_by: normalized(input?.approved_by, "approved_by", ACTOR_PATTERN),
    reason: bounded(input?.reason, "reason", 8, 500),
    idempotency_key: normalized(
      input?.idempotency_key,
      "idempotency_key",
      IDEMPOTENCY_PATTERN,
    ),
    starts_at: startsAt,
    expires_at: expiresAt,
    now,
  };
}

function assertReplayMatches(row, grant) {
  const matches = (
    row.capabilities_json === grant.capabilities_json &&
    row.starts_at === grant.starts_at &&
    (row.expires_at || null) === grant.expires_at &&
    row.approved_by === grant.approved_by &&
    row.reason === grant.reason
  );
  if (!matches) {
    throw grantError(
      "GRANT_IDEMPOTENCY_CONFLICT",
      "Grant idempotency key was reused with different content",
      409,
    );
  }
}

function publicGrant(row) {
  return {
    grant_id: row.grant_id,
    tenant_id: row.tenant_id,
    owner_github_id: Number(row.owner_github_id),
    assistant_id: row.assistant_id,
    project_id: row.project_id,
    capabilities: JSON.parse(row.capabilities_json),
    status: row.status,
    starts_at: row.starts_at,
    expires_at: row.expires_at || null,
    current_receipt_hash: row.current_receipt_hash,
    revoked_at: row.revoked_at || null,
  };
}

function normalized(value, name, pattern) {
  const result = String(value || "").trim().toLowerCase();
  if (!pattern.test(result)) {
    throw grantError("INVALID_GRANT_INPUT", `${name} is invalid`);
  }
  return result;
}

function bounded(value, name, minimum, maximum) {
  const result = String(value || "").trim();
  if (result.length < minimum || result.length > maximum) {
    throw grantError("INVALID_GRANT_INPUT", `${name} is invalid`);
  }
  return result;
}

function normalizeTimestamp(value, name) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    throw grantError("INVALID_GRANT_TIME", `${name} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function grantError(code, message, status = 400) {
  return new GraphMemoryError(code, message, status);
}
