import {
  canonicalJson,
  sha256Hex
} from "../continuity.js";

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:api_?key|access_?token|auth_?token|password|private_?key|cookie|secret)(?:$|_)/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:gh[opusr]|sk|pk)_[A-Za-z0-9_-]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/
]);
const INSTRUCTION_PATTERNS = Object.freeze([
  /ignore (?:all |any )?(?:previous|prior) instructions/i,
  /reveal (?:the )?(?:system|developer) prompt/i,
  /\b(?:validate|resolve|publish|invalidate)\s+(?:this|the)\b/i,
  /bypass (?:authorization|capability|policy)/i
]);

export const GRAPH_LIMITS = Object.freeze({
  candidate_payload_bytes: 128 * 1024,
  assertions: 100,
  evidence: 100,
  scalar_chars: 4_000,
  source_ref_chars: 2_048,
  evidence_excerpt_chars: 4_000
});

export const CANDIDATE_STATES = Object.freeze([
  "pending_validation",
  "pending_review",
  "quarantined",
  "rejected",
  "accepted",
  "superseded"
]);

export const REASON_CODES = Object.freeze({
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  INVALID_TENANT_ID: "INVALID_TENANT_ID",
  INVALID_PROJECT_ID: "INVALID_PROJECT_ID",
  INVALID_IDEMPOTENCY_KEY: "INVALID_IDEMPOTENCY_KEY",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  PROHIBITED_SECRET_CONTENT: "PROHIBITED_SECRET_CONTENT",
  UNTRUSTED_INSTRUCTION_CONTENT: "UNTRUSTED_INSTRUCTION_CONTENT",
  INVALID_ASSERTION: "INVALID_ASSERTION",
  INVALID_EVIDENCE: "INVALID_EVIDENCE"
});

export class GraphMemoryError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "GraphMemoryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeGraphTarget(input) {
  if (!isRecord(input)) {
    throw graphError("INVALID_PAYLOAD", "Graph target must be an object");
  }

  return {
    tenant_id: normalizeId(
      input.tenant_id,
      "tenant_id",
      TENANT_ID_PATTERN,
      "INVALID_TENANT_ID"
    ),
    project_id: normalizeId(
      input.project_id,
      "project_id",
      PROJECT_ID_PATTERN,
      "INVALID_PROJECT_ID"
    )
  };
}

export function normalizeCandidatePayload(input) {
  if (!isRecord(input)) {
    throw graphError("INVALID_PAYLOAD", "Candidate payload must be an object");
  }

  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > GRAPH_LIMITS.candidate_payload_bytes) {
    throw graphError("PAYLOAD_TOO_LARGE", "Candidate payload exceeds 128 KiB");
  }

  if (containsSecret(input)) {
    throw graphError(
      "PROHIBITED_SECRET_CONTENT",
      "Candidate content contains prohibited secret-like material"
    );
  }

  if (containsUntrustedInstruction(input)) {
    throw graphError(
      "UNTRUSTED_INSTRUCTION_CONTENT",
      "Candidate content contains instruction-like material"
    );
  }

  const target = normalizeGraphTarget(input);
  const idempotencyKey = String(input.idempotency_key ?? "").trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw graphError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotency_key must be 8–128 bounded characters"
    );
  }

  if (
    !Array.isArray(input.assertions) ||
    input.assertions.length < 1 ||
    input.assertions.length > GRAPH_LIMITS.assertions
  ) {
    throw graphError(
      "INVALID_ASSERTION",
      "assertions must contain between 1 and 100 items"
    );
  }

  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length < 1 ||
    input.evidence.length > GRAPH_LIMITS.evidence
  ) {
    throw graphError(
      "INVALID_EVIDENCE",
      "evidence must contain between 1 and 100 items"
    );
  }

  return {
    ...target,
    idempotency_key: idempotencyKey,
    assertions: input.assertions.map(normalizeAssertion),
    evidence: input.evidence.map(normalizeEvidence)
  };
}

export async function canonicalHash(value) {
  return sha256Hex(canonicalJson(value));
}

function normalizeAssertion(value) {
  if (!isRecord(value)) {
    throw graphError("INVALID_ASSERTION", "Each assertion must be an object");
  }

  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw graphError(
      "INVALID_ASSERTION",
      "Assertion confidence must be between 0 and 1"
    );
  }

  return {
    subject: normalizeScalar(value.subject, "assertion subject"),
    predicate: normalizeScalar(value.predicate, "assertion predicate"),
    object: normalizeScalar(value.object, "assertion object"),
    confidence
  };
}

function normalizeEvidence(value) {
  if (!isRecord(value)) {
    throw graphError("INVALID_EVIDENCE", "Each evidence item must be an object");
  }

  const sourceRef = String(value.source_ref ?? "").trim();
  if (
    sourceRef.length < 1 ||
    sourceRef.length > GRAPH_LIMITS.source_ref_chars
  ) {
    throw graphError(
      "INVALID_EVIDENCE",
      "Evidence source_ref must be a bounded non-empty string"
    );
  }

  const contentHash = String(value.content_hash ?? "").trim().toLowerCase();
  if (!HASH_PATTERN.test(contentHash)) {
    throw graphError(
      "INVALID_EVIDENCE",
      "Evidence content_hash must be a lowercase SHA-256 digest"
    );
  }

  const observedAt = String(value.observed_at ?? "").trim();
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) {
    throw graphError(
      "INVALID_EVIDENCE",
      "Evidence observed_at must be an ISO-8601 timestamp"
    );
  }

  const sourceExcerpt = value.source_excerpt === undefined
    ? null
    : String(value.source_excerpt).trim();
  if (
    sourceExcerpt !== null &&
    (
      sourceExcerpt.length < 1 ||
      sourceExcerpt.length > GRAPH_LIMITS.evidence_excerpt_chars
    )
  ) {
    throw graphError(
      "INVALID_EVIDENCE",
      "Evidence source_excerpt must be a bounded non-empty string"
    );
  }

  return {
    source_ref: sourceRef,
    content_hash: contentHash,
    observed_at: new Date(observedAt).toISOString(),
    ...(sourceExcerpt !== null ? { source_excerpt: sourceExcerpt } : {})
  };
}

function normalizeScalar(value, field) {
  const normalized = String(value ?? "").trim();
  if (
    normalized.length < 1 ||
    normalized.length > GRAPH_LIMITS.scalar_chars
  ) {
    throw graphError(
      "INVALID_ASSERTION",
      `${field} must be a bounded non-empty scalar`
    );
  }
  return normalized;
}

function normalizeId(value, field, pattern, code) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!pattern.test(normalized)) {
    throw graphError(code, `${field} has an invalid bounded identifier format`);
  }
  return normalized;
}

function containsSecret(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }

  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value));
  }

  if (Array.isArray(value)) {
    return value.some(item => containsSecret(item));
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .some(([childKey, child]) => containsSecret(child, childKey));
  }

  return false;
}

function containsUntrustedInstruction(value) {
  if (typeof value === "string") {
    return INSTRUCTION_PATTERNS.some(pattern => pattern.test(value));
  }

  if (Array.isArray(value)) {
    return value.some(containsUntrustedInstruction);
  }

  if (isRecord(value)) {
    return Object.values(value).some(containsUntrustedInstruction);
  }

  return false;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function graphError(code, message, status = 400, details = undefined) {
  return new GraphMemoryError(code, message, status, details);
}
