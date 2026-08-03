import { normalizeMeshEnvelope, MeshEnvelopeError } from "./envelopes.js";
import { MeshSignatureError, verifyMeshEnvelope } from "./signatures.js";
import { observableMessageView } from "../specialists/policy.js";

const MAX_BODY_BYTES = 262_144;

export class MeshRouteError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MeshRouteError";
    this.code = code;
    this.status = status;
  }
}

export async function handleMeshIngressRequest(request, { env, now } = {}) {
  try {
    if (request.method !== "POST") throw new MeshRouteError("METHOD_NOT_ALLOWED", 405);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      throw new MeshRouteError("MESH_ENVELOPE_TOO_LARGE", 413);
    }
    await verifyMeshEnvelope({
      rawBody,
      timestamp: request.headers.get("X-Mesh-Timestamp"),
      signature: request.headers.get("X-Mesh-Signature"),
      secret: env?.MESH_GATEWAY_SECRET,
      now,
    });
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new MeshEnvelopeError("MESH_ENVELOPE_INVALID");
    }
    const result = await acceptMeshMessage({ env, envelope: parsed, now });
    return Response.json(result, {
      status: result.status === "duplicate" ? 200 : 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const known = error instanceof MeshRouteError
      || error instanceof MeshSignatureError
      || error instanceof MeshEnvelopeError;
    return Response.json(
      { ok: false, error: known ? error.code : "MESH_INGRESS_UNAVAILABLE" },
      { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function acceptMeshMessage({ env, envelope, now = () => new Date() }) {
  if (!env?.DB) throw new MeshRouteError("MESH_DATABASE_UNAVAILABLE", 503);
  const value = normalizeMeshEnvelope(envelope);
  const payloadJson = JSON.stringify(value.payload);
  const attachmentsJson = JSON.stringify(value.attachments);
  const existing = await env.DB.prepare(
    "SELECT message_id, correlation_id, target_specialist, lane, project_id, payload_json FROM mesh_messages WHERE message_id = ?",
  ).bind(value.message_id).first();
  if (existing) {
    const same = existing.correlation_id === value.correlation_id
      && existing.target_specialist === value.target_specialist
      && existing.lane === value.lane
      && existing.project_id === value.project_id
      && existing.payload_json === payloadJson;
    if (!same) throw new MeshRouteError("MESH_MESSAGE_ID_CONFLICT", 409);
    return { ok: true, status: "duplicate", message_id: value.message_id };
  }
  const timestamp = now().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO mesh_messages (
        message_id, correlation_id, source, principal_id, target_specialist,
        lane, project_id, payload_json, attachments_json, security_state,
        status, forwarded_by_architectus, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)
    `).bind(
      value.message_id, value.correlation_id, value.source, value.principal_id,
      value.target_specialist, value.lane, value.project_id, payloadJson,
      attachmentsJson, value.security_state,
      value.forwarded_by_architectus ? 1 : 0, timestamp, timestamp,
    ),
    env.DB.prepare(`
      INSERT INTO security_preflights (
        preflight_id, message_id, severity, decision, reason_codes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      `preflight:${value.message_id}`, value.message_id,
      value.preflight.severity, value.preflight.decision,
      JSON.stringify(value.preflight.reason_codes), timestamp,
    ),
  ]);
  return {
    ok: true,
    status: "accepted",
    message_id: value.message_id,
    security_state: value.security_state,
  };
}

export async function listMeshInbox({ env, principal, limit = 50 }) {
  if (!env?.DB) throw new MeshRouteError("MESH_DATABASE_UNAVAILABLE", 503);
  const actor = String(principal?.specialist_id ?? principal?.principal_id ?? "").toLowerCase();
  const root = principal?.role === "root" || principal?.role === "owner" || actor === "architectus";
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  let visibility = "1 = 1";
  let bindings = [];
  if (!root && actor === "savae") {
    visibility = "(m.target_specialist = ? OR m.lane = 'savae-routed' OR m.forwarded_by_architectus = 1)";
    bindings = [actor];
  } else if (!root && actor === "synn") {
    visibility = "(m.target_specialist = ? OR (p.severity = 'critical' AND p.decision = 'block'))";
    bindings = [actor];
  } else if (!root) {
    visibility = "m.target_specialist = ?";
    bindings = [actor];
  }
  const rows = (await env.DB.prepare(`
    SELECT m.*, p.severity, p.decision, p.reason_codes_json,
           p.override_actor, p.override_scope, p.overridden_at
      FROM mesh_messages m
      JOIN security_preflights p ON p.message_id = m.message_id
     WHERE ${visibility}
     ORDER BY m.created_at DESC, m.message_id
     LIMIT ?
  `).bind(...bindings, boundedLimit).all()).results ?? [];
  const messages = rows.map(row => observableMessageView(principal, rowToMessage(row))).filter(Boolean);
  return { messages };
}

export async function startMeshMessage({ env, messageId, override, now = () => new Date() }) {
  if (!env?.DB) throw new MeshRouteError("MESH_DATABASE_UNAVAILABLE", 503);
  const row = await env.DB.prepare(`
    SELECT m.message_id, m.status, m.security_state, p.severity, p.decision
      FROM mesh_messages m
      JOIN security_preflights p ON p.message_id = m.message_id
     WHERE m.message_id = ?
  `).bind(messageId).first();
  if (!row) throw new MeshRouteError("MESH_MESSAGE_NOT_FOUND", 404);
  if (row.status === "running") return { message_id: messageId, status: "running" };
  if (row.status !== "accepted") throw new MeshRouteError("MESH_STATE_CONFLICT", 409);
  const timestamp = now().toISOString();
  if (row.security_state !== "cleared") {
    const validOverride = override?.actor === "architectus"
      && override?.scope === `message:${messageId}`;
    if (!validOverride) throw new MeshRouteError("SECURITY_PREFLIGHT_BLOCKED", 409);
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE security_preflights
           SET override_actor = ?, override_scope = ?, overridden_at = ?
         WHERE message_id = ?
      `).bind("architectus", override.scope, timestamp, messageId),
      env.DB.prepare(`
        UPDATE mesh_messages
           SET security_state = 'cleared', status = 'running', updated_at = ?
         WHERE message_id = ? AND status = 'accepted'
      `).bind(timestamp, messageId),
    ]);
  } else {
    await env.DB.prepare(`
      UPDATE mesh_messages SET status = 'running', updated_at = ?
       WHERE message_id = ? AND status = 'accepted' AND security_state = 'cleared'
    `).bind(timestamp, messageId).run();
  }
  return { message_id: messageId, status: "running" };
}

export async function handleMeshInboxRequest(request, { env, principal } = {}) {
  if (request.method !== "GET") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  try {
    if (
      principal?.role !== "root"
      && principal?.role !== "owner"
      && (
        principal?.role !== "specialist"
        || !principal?.capabilities?.includes("exchanges.inbox")
      )
    ) throw new MeshRouteError("CAPABILITY_DENIED", 403);
    const result = await listMeshInbox({ env, principal });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error?.code ?? "MESH_INBOX_UNAVAILABLE" },
      { status: error?.status ?? 503 },
    );
  }
}

function rowToMessage(row) {
  return {
    message_id: row.message_id,
    correlation_id: row.correlation_id,
    source: row.source,
    principal_id: row.principal_id,
    target_specialist: row.target_specialist,
    lane: row.lane,
    project_id: row.project_id,
    payload: parseJson(row.payload_json, null),
    attachments: parseJson(row.attachments_json, []),
    security_state: row.security_state,
    status: row.status,
    forwarded_by_architectus: Number(row.forwarded_by_architectus),
    created_at: row.created_at,
    updated_at: row.updated_at,
    preflight: {
      severity: row.severity,
      decision: row.decision,
      reason_codes: parseJson(row.reason_codes_json, []),
      override_actor: row.override_actor,
      override_scope: row.override_scope,
      overridden_at: row.overridden_at,
    },
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
