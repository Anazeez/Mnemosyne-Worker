import {
  GraphMemoryError,
  canonicalHash,
  normalizeGraphTarget
} from "./contracts.js";
import { assertGraphAccess } from "./policy.js";
import { publishMemoryCandidate } from "./review.js";

const DECISIONS = new Set([
  "accept",
  "edit_accept",
  "reject",
  "quarantine"
]);
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

const SQL = Object.freeze({
  LIST: `
    SELECT candidate_id, submitted_by_credential_id, assistant_id, confidence,
           state, reason_code, submitted_at, updated_at
      FROM memory_candidates
     WHERE tenant_id = ? AND project_id = ?
       AND state IN ('pending_validation', 'pending_review')
     ORDER BY submitted_at, candidate_id
     LIMIT ?`,
  GET: `
    SELECT * FROM memory_candidates
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?`,
  EVIDENCE: `
    SELECT evidence_id, source_ref, content_hash, source_excerpt, observed_at,
           producer_credential_id, authorization_labels_json, citation_json
      FROM memory_evidence
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?
     ORDER BY evidence_id`,
  DECISIONS: `
    SELECT decision_id, decision_type, outcome, reason_code, receipt_hash,
           decided_by_credential_id, created_at
      FROM memory_decisions
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?
     ORDER BY created_at, decision_id`,
  REPLAY: `
    SELECT response_json FROM memory_review_actions
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?
       AND idempotency_key = ?`,
  INSERT_ACTION: `
    INSERT INTO memory_review_actions (
      action_id, candidate_id, tenant_id, project_id, idempotency_key,
      decision, response_json, decided_by_credential_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_DECISION: `
    INSERT INTO memory_decisions (
      decision_id, tenant_id, project_id, candidate_id, assertion_id,
      snapshot_id, decision_type, outcome, reason_code, receipt_hash,
      decided_by_credential_id, created_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  UPDATE_CANDIDATE: `
    UPDATE memory_candidates
       SET state = ?, reason_code = ?, updated_at = ?
     WHERE tenant_id = ? AND project_id = ? AND candidate_id = ?`
});

export async function listReviewCandidates({
  env,
  principal,
  target,
  limit = 50
}) {
  const normalized = requireHumanReview(principal, target);
  const boundedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100
    ? limit
    : 50;
  const candidates = (await env.DB.prepare(SQL.LIST).bind(
    normalized.tenant_id,
    normalized.project_id,
    boundedLimit
  ).all()).results || [];
  return { ...normalized, candidates };
}

export async function getReviewCandidate({
  env,
  principal,
  target,
  candidateId
}) {
  const normalized = requireHumanReview(principal, target);
  const candidate = await env.DB.prepare(SQL.GET).bind(
    normalized.tenant_id,
    normalized.project_id,
    String(candidateId)
  ).first();
  if (!candidate) {
    throw new GraphMemoryError(
      "CANDIDATE_NOT_FOUND",
      "Candidate is unavailable",
      404
    );
  }
  const [evidenceResult, decisionsResult] = await Promise.all([
    env.DB.prepare(SQL.EVIDENCE).bind(
      normalized.tenant_id,
      normalized.project_id,
      candidate.candidate_id
    ).all(),
    env.DB.prepare(SQL.DECISIONS).bind(
      normalized.tenant_id,
      normalized.project_id,
      candidate.candidate_id
    ).all()
  ]);
  return {
    ...normalized,
    candidate: {
      ...candidate,
      payload: parseJson(candidate.payload_json)
    },
    evidence: (evidenceResult.results || []).map(row => ({
      ...row,
      authorization_labels: parseJson(row.authorization_labels_json),
      citation: parseJson(row.citation_json)
    })),
    decisions: decisionsResult.results || []
  };
}

export async function decideReviewCandidate({
  env,
  principal,
  target,
  candidateId,
  decision,
  editedAssertions,
  reasonCode,
  idempotencyKey,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  const normalized = requireHumanReview(principal, target);
  const normalizedDecision = String(decision || "");
  if (!DECISIONS.has(normalizedDecision)) {
    throw new GraphMemoryError(
      "INVALID_REVIEW_DECISION",
      "Review decision is invalid",
      400
    );
  }
  if (!IDEMPOTENCY_KEY.test(String(idempotencyKey || ""))) {
    throw new GraphMemoryError(
      "INVALID_IDEMPOTENCY_KEY",
      "Review idempotency key is invalid",
      400
    );
  }
  const replay = await env.DB.prepare(SQL.REPLAY).bind(
    normalized.tenant_id,
    normalized.project_id,
    String(candidateId),
    idempotencyKey
  ).first();
  if (replay) return parseJson(replay.response_json);

  const detail = await getReviewCandidate({
    env,
    principal,
    target: normalized,
    candidateId
  });
  let response;
  if (normalizedDecision === "accept" || normalizedDecision === "edit_accept") {
    if (detail.candidate.state !== "pending_review") {
      throw new GraphMemoryError(
        "CANDIDATE_NOT_REVIEWABLE",
        "Candidate is not ready for acceptance",
        409
      );
    }
    let payloadOverride = null;
    let editRecord = null;
    if (normalizedDecision === "edit_accept") {
      if (!Array.isArray(editedAssertions) || editedAssertions.length === 0) {
        throw new GraphMemoryError(
          "EDITED_ASSERTIONS_REQUIRED",
          "Edit and accept requires edited assertions",
          400
        );
      }
      payloadOverride = {
        ...detail.candidate.payload,
        assertions: editedAssertions
      };
      editRecord = {
        edit_id: `edit_${randomUUID()}`,
        reason_code: normalizeReasonCode(reasonCode, false)
      };
    }
    response = await publishMemoryCandidate({
      env,
      principal,
      candidateId: detail.candidate.candidate_id,
      payloadOverride,
      editRecord,
      now,
      randomUUID
    });
  } else {
    const requiredReason = normalizeReasonCode(reasonCode, true);
    const createdAt = now().toISOString();
    const decisionId = `decision_${randomUUID()}`;
    const outcome = normalizedDecision === "reject"
      ? "rejected"
      : "quarantined";
    const receiptHash = await canonicalHash({
      decision_id: decisionId,
      candidate_id: detail.candidate.candidate_id,
      outcome,
      reason_code: requiredReason,
      created_at: createdAt
    });
    await env.DB.batch([
      env.DB.prepare(SQL.INSERT_DECISION).bind(
        decisionId,
        normalized.tenant_id,
        normalized.project_id,
        detail.candidate.candidate_id,
        normalizedDecision === "reject" ? "rejection" : "quarantine",
        outcome,
        requiredReason,
        receiptHash,
        principal.credential_id,
        createdAt
      ),
      env.DB.prepare(SQL.UPDATE_CANDIDATE).bind(
        outcome,
        requiredReason,
        createdAt,
        normalized.tenant_id,
        normalized.project_id,
        detail.candidate.candidate_id
      )
    ]);
    response = {
      candidate_id: detail.candidate.candidate_id,
      decision_id: decisionId,
      state: outcome,
      reason_code: requiredReason
    };
  }

  const actionId = `review_${randomUUID()}`;
  const createdAt = now().toISOString();
  await env.DB.prepare(SQL.INSERT_ACTION).bind(
    actionId,
    detail.candidate.candidate_id,
    normalized.tenant_id,
    normalized.project_id,
    idempotencyKey,
    normalizedDecision,
    JSON.stringify(response),
    principal.credential_id,
    createdAt
  ).run();
  return response;
}

export async function handleHumanReviewRequest(request, { env, principal }) {
  const url = new URL(request.url);
  const target = {
    tenant_id: url.searchParams.get("tenant_id"),
    project_id: url.searchParams.get("project_id")
  };
  const match = url.pathname.match(
    /^\/admin\/memory\/candidates(?:\/([^/]+))?(?:\/decision)?$/
  );
  if (!match) return new Response("Not found", { status: 404 });

  try {
    let result;
    if (request.method === "GET" && !match[1]) {
      result = await listReviewCandidates({
        env,
        principal,
        target,
        limit: Number(url.searchParams.get("limit") || 50)
      });
    } else if (
      request.method === "GET" &&
      match[1] &&
      !url.pathname.endsWith("/decision")
    ) {
      result = await getReviewCandidate({
        env,
        principal,
        target,
        candidateId: decodeURIComponent(match[1])
      });
    } else if (
      request.method === "POST" &&
      match[1] &&
      url.pathname.endsWith("/decision")
    ) {
      const body = await request.json();
      result = await decideReviewCandidate({
        env,
        principal,
        target: {
          tenant_id: body.tenant_id ?? target.tenant_id,
          project_id: body.project_id ?? target.project_id
        },
        candidateId: decodeURIComponent(match[1]),
        decision: body.decision,
        editedAssertions: body.edited_assertions,
        reasonCode: body.reason_code,
        idempotencyKey: body.idempotency_key
      });
    } else {
      return new Response("Method not allowed", { status: 405 });
    }
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    return Response.json({
      error: {
        code: error?.code || "HUMAN_REVIEW_FAILED",
        message: safeErrorMessage(error)
      }
    }, {
      status,
      headers: { "Cache-Control": "no-store" }
    });
  }
}

function requireHumanReview(principal, target) {
  if (principal?.role !== "owner") {
    throw new GraphMemoryError(
      "HUMAN_REVIEW_REQUIRED",
      "Canonical review requires the authenticated human owner",
      403
    );
  }
  const normalized = normalizeGraphTarget(target);
  assertGraphAccess(principal, normalized, "memory.review");
  return normalized;
}

function normalizeReasonCode(value, required) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized && !required) return null;
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(normalized)) {
    throw new GraphMemoryError(
      "INVALID_REASON_CODE",
      "A bounded stable reason code is required",
      400
    );
  }
  return normalized;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new GraphMemoryError(
      "STORED_REVIEW_DATA_MALFORMED",
      "Stored review data is malformed",
      500
    );
  }
}

function safeErrorMessage(error) {
  if (error instanceof GraphMemoryError) return error.message;
  return "The human review operation could not be completed";
}
