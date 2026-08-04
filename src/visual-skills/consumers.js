const ASSISTANT = /^oauth-[a-f0-9]{32}$/u;
const ACTOR = /^[a-z0-9][a-z0-9:._-]{1,127}$/u;
const ALLOWED_SCOPES = Object.freeze(["identity:read", "memory:read", "memory:search"]);

export async function approveVisualSkillConsumer(db, input) {
  assertDatabase(db);
  const normalized = normalizeMutation(input);
  const grantVersion = await sha256(JSON.stringify({
    assistant_id: normalized.assistant_id,
    consumer_id: "general-assistant",
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    allowed_scopes: ALLOWED_SCOPES,
    actor_id: normalized.actor_id,
    reason: normalized.reason,
    approved_at: normalized.now,
  }));
  await db.prepare(`
    INSERT INTO visual_skill_consumers (
      assistant_id, consumer_id, tenant_id, project_id, domain_id,
      allowed_scopes_json, grant_version, active, approved_by, reason,
      created_at, updated_at, revoked_at
    ) VALUES (?, 'general-assistant', 'personal', 'project-infinitum',
      'visual-design-expression', ?, ?, 1, ?, ?, ?, ?, NULL)
    ON CONFLICT(assistant_id) DO UPDATE SET
      consumer_id = excluded.consumer_id,
      tenant_id = excluded.tenant_id,
      project_id = excluded.project_id,
      domain_id = excluded.domain_id,
      allowed_scopes_json = excluded.allowed_scopes_json,
      grant_version = excluded.grant_version,
      active = 1,
      approved_by = excluded.approved_by,
      reason = excluded.reason,
      updated_at = excluded.updated_at,
      revoked_at = NULL
  `).bind(
    normalized.assistant_id,
    JSON.stringify(ALLOWED_SCOPES),
    grantVersion,
    normalized.actor_id,
    normalized.reason,
    normalized.now,
    normalized.now,
  ).run();
  return resolveVisualSkillConsumerBinding(db, normalized.assistant_id);
}

export async function resolveVisualSkillConsumerBinding(db, assistantId) {
  if (!db || !ASSISTANT.test(String(assistantId ?? ""))) return null;
  let row;
  try {
    row = await db.prepare(`
      SELECT assistant_id, consumer_id, tenant_id, project_id, domain_id,
             allowed_scopes_json, grant_version
        FROM visual_skill_consumers
       WHERE assistant_id = ? AND active = 1
    `).bind(assistantId).first();
  } catch (error) {
    if (/no such table/iu.test(String(error?.message ?? error))) return null;
    throw error;
  }
  if (!row) return null;
  const allowedScopes = parseScopes(row.allowed_scopes_json);
  if (
    row.consumer_id !== "general-assistant"
    || row.tenant_id !== "personal"
    || row.project_id !== "project-infinitum"
    || row.domain_id !== "visual-design-expression"
    || allowedScopes.length !== ALLOWED_SCOPES.length
    || !ALLOWED_SCOPES.every((scope) => allowedScopes.includes(scope))
    || !/^[a-f0-9]{64}$/u.test(String(row.grant_version ?? ""))
  ) throw invalid("VISUAL_SKILL_CONSUMER_BINDING_INVALID");
  return {
    assistant_id: row.assistant_id,
    consumer_id: row.consumer_id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    domain_id: row.domain_id,
    allowed_scopes: allowedScopes,
    grant_version: row.grant_version,
  };
}

export async function revokeVisualSkillConsumer(db, input) {
  assertDatabase(db);
  const normalized = normalizeMutation(input);
  const existing = await resolveVisualSkillConsumerBinding(db, normalized.assistant_id);
  if (!existing) throw invalid("VISUAL_SKILL_CONSUMER_NOT_FOUND");
  await db.prepare(`
    UPDATE visual_skill_consumers
       SET active = 0, updated_at = ?, revoked_at = ?, approved_by = ?, reason = ?
     WHERE assistant_id = ? AND active = 1
  `).bind(
    normalized.now,
    normalized.now,
    normalized.actor_id,
    normalized.reason,
    normalized.assistant_id,
  ).run();
  return { ...existing, active: false, revoked_at: normalized.now };
}

function normalizeMutation(input) {
  const assistantId = String(input?.assistant_id ?? "").trim().toLowerCase();
  const actorId = String(input?.actor_id ?? "").trim().toLowerCase();
  const reason = String(input?.reason ?? "").trim();
  const now = String(input?.now ?? "").trim();
  if (!ASSISTANT.test(assistantId)) throw invalid("VISUAL_SKILL_ASSISTANT_ID_INVALID");
  if (!ACTOR.test(actorId)) throw invalid("VISUAL_SKILL_ACTOR_INVALID");
  if (reason.length < 8 || reason.length > 500) throw invalid("VISUAL_SKILL_REASON_INVALID");
  if (!Number.isFinite(Date.parse(now))) throw invalid("VISUAL_SKILL_TIMESTAMP_INVALID");
  return { assistant_id: assistantId, actor_id: actorId, reason, now: new Date(now).toISOString() };
}

function parseScopes(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.map(String))].sort() : [];
  } catch {
    return [];
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertDatabase(db) {
  if (!db?.prepare) throw invalid("VISUAL_SKILL_CONSUMER_DATABASE_UNAVAILABLE");
}

function invalid(code) {
  return Object.assign(new Error(code), { code, status: 403 });
}
