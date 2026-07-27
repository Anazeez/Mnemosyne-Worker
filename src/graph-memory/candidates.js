import {
  GraphMemoryError,
  canonicalHash,
  normalizeCandidatePayload
} from "./contracts.js";
import { assertGraphAccess } from "./policy.js";

const CANDIDATE_ID_PATTERN = /^candidate_[a-zA-Z0-9._:-]{8,128}$/;

const SQL = Object.freeze({
  GET_IDEMPOTENT: `
    SELECT candidate_id, state, submitted_at, payload_hash
      FROM memory_candidates
     WHERE tenant_id = ?
       AND project_id = ?
       AND submitted_by_credential_id = ?
       AND idempotency_key = ?`,
  INSERT_CANDIDATE: `
    INSERT INTO memory_candidates (
      candidate_id, tenant_id, project_id, submitted_by_credential_id,
      assistant_id, idempotency_key, payload_json, payload_hash, confidence,
      state, reason_code, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_EVIDENCE: `
    INSERT INTO memory_evidence (
      evidence_id, tenant_id, project_id, candidate_id, source_ref,
      content_hash, source_excerpt, observed_at, producer_credential_id,
      authorization_labels_json, citation_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  GET_OWN: `
    SELECT candidate_id, tenant_id, project_id, state, reason_code,
           submitted_at, updated_at, payload_hash
      FROM memory_candidates
     WHERE candidate_id = ?
       AND tenant_id = ?
       AND submitted_by_credential_id = ?`
});

export async function createMemoryCandidate({
  env,
  principal,
  body,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireDatabase(env);
  const normalized = normalizeCandidatePayload(body);
  assertGraphAccess(principal, normalized, "memory.propose");
  const payloadHash = await canonicalHash(normalized);
  const existing = await env.DB.prepare(SQL.GET_IDEMPOTENT).bind(
    normalized.tenant_id,
    normalized.project_id,
    principal.credential_id,
    normalized.idempotency_key
  ).first();

  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new GraphMemoryError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "The idempotency key is already bound to another payload",
        409
      );
    }
    return candidateProjection(existing, true);
  }

  const candidateId = `candidate_${randomUUID()}`;
  const submittedAt = now().toISOString();
  const confidence = normalized.assertions.reduce(
    (sum, assertion) => sum + assertion.confidence,
    0
  ) / normalized.assertions.length;
  const statements = [
    env.DB.prepare(SQL.INSERT_CANDIDATE).bind(
      candidateId,
      normalized.tenant_id,
      normalized.project_id,
      principal.credential_id,
      principal.assistant_id || principal.credential_id,
      normalized.idempotency_key,
      JSON.stringify(normalized),
      payloadHash,
      confidence,
      "pending_validation",
      null,
      submittedAt,
      submittedAt
    )
  ];

  for (const evidence of normalized.evidence) {
    statements.push(env.DB.prepare(SQL.INSERT_EVIDENCE).bind(
      `evidence_${randomUUID()}`,
      normalized.tenant_id,
      normalized.project_id,
      candidateId,
      evidence.source_ref,
      evidence.content_hash,
      evidence.source_excerpt || null,
      evidence.observed_at,
      principal.credential_id,
      JSON.stringify(["tenant", "project"]),
      JSON.stringify({ source_ref: evidence.source_ref }),
      submittedAt
    ));
  }

  await env.DB.batch(statements);
  return {
    candidate_id: candidateId,
    state: "pending_validation",
    submitted_at: submittedAt,
    payload_hash: payloadHash,
    idempotent_replay: false
  };
}

export async function getOwnCandidate({ env, principal, candidateId }) {
  requireDatabase(env);
  const normalizedId = String(candidateId ?? "").trim();
  if (!CANDIDATE_ID_PATTERN.test(normalizedId)) {
    throw candidateNotFound();
  }
  if (!principal?.capabilities?.includes("memory.candidate.read.own")) {
    throw candidateNotFound();
  }

  const row = await env.DB.prepare(SQL.GET_OWN).bind(
    normalizedId,
    principal.tenant_id,
    principal.credential_id
  ).first();
  if (!row) {
    throw candidateNotFound();
  }

  return {
    candidate_id: row.candidate_id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    state: row.state,
    reason_code: row.reason_code,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    payload_hash: row.payload_hash
  };
}

function candidateProjection(row, idempotentReplay) {
  return {
    candidate_id: row.candidate_id,
    state: row.state,
    submitted_at: row.submitted_at,
    payload_hash: row.payload_hash,
    idempotent_replay: idempotentReplay
  };
}

function candidateNotFound() {
  return new GraphMemoryError(
    "CANDIDATE_NOT_FOUND",
    "Candidate is unavailable",
    404
  );
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
