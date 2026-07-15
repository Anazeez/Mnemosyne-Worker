export const RUNWAY_SCHEMA = "mnemosyne.context-runway/1.0";

export const CONTINUITY_LIMITS = Object.freeze({
  payload_bytes: 128 * 1024,
  objective_chars: 2_000,
  summary_chars: 4_000,
  operational_state_chars: 8_000,
  decisions: 100,
  open_threads: 100,
  next_actions: 100,
  references_per_domain: 200,
  mounted_skills: 200,
  relevant_agents: 200,
  pending_handoffs: 100,
  constraints: 100,
  prohibited_assumptions: 100,
  integrity_warnings: 100,
  source_hashes: 500
});

const DEFAULT_FRESHNESS_LIMIT_SECONDS = 7 * 24 * 60 * 60;
const MIN_FRESHNESS_LIMIT_SECONDS = 60;
const MAX_FRESHNESS_LIMIT_SECONDS = 365 * 24 * 60 * 60;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASIC_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const BASIC_SCOPE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const QUALIFIED_SCOPE_PATTERN = /^(mandate|thread):[a-z0-9][a-z0-9_-]{1,63}$/;

const REQUIRED_ARRAY_FIELDS = Object.freeze([
  "decisions_in_force",
  "open_threads",
  "next_actions",
  "mounted_skills",
  "relevant_agents",
  "relevant_files",
  "knowledge_references",
  "library_references",
  "pending_handoffs",
  "constraints",
  "prohibited_assumptions",
  "integrity_warnings",
  "source_hashes"
]);

const ARRAY_LIMITS = Object.freeze({
  decisions_in_force: CONTINUITY_LIMITS.decisions,
  open_threads: CONTINUITY_LIMITS.open_threads,
  next_actions: CONTINUITY_LIMITS.next_actions,
  mounted_skills: CONTINUITY_LIMITS.mounted_skills,
  relevant_agents: CONTINUITY_LIMITS.relevant_agents,
  relevant_files: CONTINUITY_LIMITS.references_per_domain,
  knowledge_references: CONTINUITY_LIMITS.references_per_domain,
  library_references: CONTINUITY_LIMITS.references_per_domain,
  pending_handoffs: CONTINUITY_LIMITS.pending_handoffs,
  constraints: CONTINUITY_LIMITS.constraints,
  prohibited_assumptions: CONTINUITY_LIMITS.prohibited_assumptions,
  integrity_warnings: CONTINUITY_LIMITS.integrity_warnings,
  source_hashes: CONTINUITY_LIMITS.source_hashes
});

const ARRAY_ERROR_CODES = Object.freeze({
  decisions_in_force: "TOO_MANY_DECISIONS",
  open_threads: "TOO_MANY_OPEN_THREADS",
  next_actions: "TOO_MANY_NEXT_ACTIONS",
  mounted_skills: "TOO_MANY_MOUNTED_SKILLS",
  relevant_agents: "TOO_MANY_RELEVANT_AGENTS",
  relevant_files: "TOO_MANY_FILE_REFERENCES",
  knowledge_references: "TOO_MANY_KNOWLEDGE_REFERENCES",
  library_references: "TOO_MANY_LIBRARY_REFERENCES",
  pending_handoffs: "TOO_MANY_PENDING_HANDOFFS",
  constraints: "TOO_MANY_CONSTRAINTS",
  prohibited_assumptions: "TOO_MANY_PROHIBITED_ASSUMPTIONS",
  integrity_warnings: "TOO_MANY_INTEGRITY_WARNINGS",
  source_hashes: "TOO_MANY_SOURCE_HASHES"
});

const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:gh[opusr]|sk|pk)_[A-Za-z0-9_-]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/
]);

const SECRET_KEY_PATTERN = /(?:^|_)(?:api_?key|access_?token|auth_?token|password|private_?key|cookie|secret)(?:$|_)/i;
const INSTRUCTION_PATTERNS = Object.freeze([
  /ignore (?:all |any )?(?:previous|prior) instructions/i,
  /reveal (?:the )?(?:system|developer) prompt/i,
  /grant\s+[a-z0-9._-]+/i,
  /bypass (?:authorization|capability|policy)/i
]);

export class ContinuityError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "ContinuityError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeIdentityId(value) {
  return normalizeBoundedId(value, "identity_id", BASIC_ID_PATTERN, 64);
}

export function normalizeProjectId(value) {
  return normalizeBoundedId(value, "project_id", PROJECT_ID_PATTERN, 64);
}

export function normalizeScopeKey(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (
    normalized.length > 96 ||
    (!BASIC_SCOPE_PATTERN.test(normalized) &&
      !QUALIFIED_SCOPE_PATTERN.test(normalized))
  ) {
    throw new ContinuityError(
      "INVALID_SCOPE_KEY",
      "scope_key must use a bounded named, mandate, or thread scope"
    );
  }

  return normalized;
}

function normalizeBoundedId(value, field, pattern, maximumLength) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (normalized.length > maximumLength || !pattern.test(normalized)) {
    throw new ContinuityError(
      `INVALID_${field.toUpperCase()}`,
      `${field} has an invalid bounded identifier format`
    );
  }

  return normalized;
}

export function canonicalJson(value) {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => sortCanonicalValue(item));
  }

  if (value && typeof value === "object") {
    const sorted = {};

    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw new ContinuityError(
          "UNDEFINED_CANONICAL_VALUE",
          "Canonical JSON does not permit undefined values"
        );
      }

      sorted[key] = sortCanonicalValue(value[key]);
    }

    return sorted;
  }

  if (
    typeof value === "number" &&
    !Number.isFinite(value)
  ) {
    throw new ContinuityError(
      "NON_FINITE_CANONICAL_NUMBER",
      "Canonical JSON permits only finite numbers"
    );
  }

  return value;
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildRunwayManifest({ payload, sourceHashes = [] }) {
  const manifest = {
    payload: structuredClone(payload),
    source_hashes: structuredClone(sourceHashes)
  };
  const canonical = canonicalJson(manifest);

  return {
    canonical_json: canonical,
    manifest_hash: await sha256Hex(canonical),
    source_hashes: structuredClone(sourceHashes)
  };
}

export async function validateRunwayCandidate({
  payload,
  sourceHashes = [],
  expectedIdentityId,
  expectedProjectId,
  expectedScopeKey
}) {
  const errors = [];
  const warnings = [];
  let normalizedPayload = null;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return validationResult({
      errors: [finding("INVALID_PAYLOAD", "Checkpoint payload must be an object")],
      warnings,
      normalizedPayload,
      completenessScore: 0
    });
  }

  if (containsSecret(payload) || containsSecret(sourceHashes)) {
    return validationResult({
      errors: [finding(
        "PROHIBITED_SECRET_CONTENT",
        "Checkpoint content contains prohibited secret-like material"
      )],
      warnings,
      normalizedPayload: null,
      completenessScore: 0
    });
  }

  normalizedPayload = structuredClone(payload);

  if (payload.schema !== RUNWAY_SCHEMA) {
    errors.push(finding(
      "UNSUPPORTED_SCHEMA",
      `Checkpoint schema must be ${RUNWAY_SCHEMA}`
    ));
  }

  validateTupleField({
    payload,
    field: "identity_id",
    expected: expectedIdentityId,
    normalize: normalizeIdentityId,
    mismatchCode: "IDENTITY_MISMATCH",
    errors
  });
  validateTupleField({
    payload,
    field: "project_id",
    expected: expectedProjectId,
    normalize: normalizeProjectId,
    mismatchCode: "PROJECT_MISMATCH",
    errors
  });
  validateTupleField({
    payload,
    field: "scope_key",
    expected: expectedScopeKey,
    normalize: normalizeScopeKey,
    mismatchCode: "SCOPE_MISMATCH",
    errors
  });

  for (const field of ["runway_id", "source_invocation_id", "created_at"]) {
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      errors.push(finding(
        "MISSING_REQUIRED_FIELD",
        `Checkpoint field ${field} is required`,
        { field }
      ));
    }
  }

  if (!Number.isInteger(payload.generation) || payload.generation < 0) {
    errors.push(finding(
      "INVALID_GENERATION",
      "Checkpoint generation must be a non-negative integer"
    ));
  }

  if (typeof payload.objective !== "string" || !payload.objective.trim()) {
    errors.push(finding("MISSING_OBJECTIVE", "Checkpoint objective is required"));
  } else if (payload.objective.length > CONTINUITY_LIMITS.objective_chars) {
    errors.push(finding("OBJECTIVE_TOO_LONG", "Checkpoint objective exceeds its bound"));
  }

  if (
    typeof payload.operational_state !== "string" ||
    !payload.operational_state.trim()
  ) {
    errors.push(finding(
      "MISSING_OPERATIONAL_STATE",
      "Checkpoint operational_state is required"
    ));
  } else if (
    payload.operational_state.length > CONTINUITY_LIMITS.operational_state_chars
  ) {
    errors.push(finding(
      "OPERATIONAL_STATE_TOO_LONG",
      "Checkpoint operational_state exceeds its bound"
    ));
  }

  if (
    payload.summary !== undefined &&
    (typeof payload.summary !== "string" ||
      payload.summary.length > CONTINUITY_LIMITS.summary_chars)
  ) {
    errors.push(finding("SUMMARY_TOO_LONG", "Checkpoint summary exceeds its bound"));
  }

  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(payload[field])) {
      errors.push(finding(
        "INVALID_ARRAY_FIELD",
        `Checkpoint field ${field} must be an array`,
        { field }
      ));
      continue;
    }

    if (payload[field].length > ARRAY_LIMITS[field]) {
      errors.push(finding(
        ARRAY_ERROR_CODES[field],
        `Checkpoint field ${field} exceeds its item bound`,
        { field, limit: ARRAY_LIMITS[field] }
      ));
    }
  }

  const effectiveSourceHashes = sourceHashes.length > 0
    ? sourceHashes
    : payload.source_hashes;
  validateSourceHashes(effectiveSourceHashes, errors);

  let payloadBytes = 0;

  try {
    payloadBytes = new TextEncoder().encode(canonicalJson(payload)).byteLength;
  } catch (error) {
    errors.push(finding(
      error.code || "CANONICALIZATION_FAILED",
      error.message || "Checkpoint canonicalization failed"
    ));
  }

  if (payloadBytes > CONTINUITY_LIMITS.payload_bytes) {
    errors.push(finding(
      "PAYLOAD_TOO_LARGE",
      "Checkpoint payload exceeds the serialized byte bound",
      { limit: CONTINUITY_LIMITS.payload_bytes }
    ));
  }

  if (containsUntrustedInstruction(payload)) {
    warnings.push(finding(
      "UNTRUSTED_INSTRUCTION_TEXT",
      "Instruction-like source text is retained only as quoted evidence"
    ));
  }

  const completenessScore = calculateCompleteness(payload);

  return validationResult({
    errors,
    warnings,
    normalizedPayload,
    completenessScore
  });
}

function validateTupleField({
  payload,
  field,
  expected,
  normalize,
  mismatchCode,
  errors
}) {
  let actual;
  let normalizedExpected;

  try {
    actual = normalize(payload[field]);
    normalizedExpected = normalize(expected);
  } catch (error) {
    errors.push(finding(
      error.code || `INVALID_${field.toUpperCase()}`,
      error.message || `Checkpoint ${field} is invalid`
    ));
    return;
  }

  if (actual !== normalizedExpected) {
    errors.push(finding(
      mismatchCode,
      `Checkpoint ${field} does not match the authorized target`
    ));
  }
}

function validateSourceHashes(sourceHashes, errors) {
  if (!Array.isArray(sourceHashes)) {
    errors.push(finding(
      "INVALID_SOURCE_HASHES",
      "source_hashes must be an array"
    ));
    return;
  }

  if (sourceHashes.length > CONTINUITY_LIMITS.source_hashes) {
    errors.push(finding(
      "TOO_MANY_SOURCE_HASHES",
      "source_hashes exceeds its item bound"
    ));
  }

  for (const source of sourceHashes) {
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.source_ref !== "string" ||
      !source.source_ref.trim() ||
      typeof source.sha256 !== "string" ||
      !SHA256_PATTERN.test(source.sha256)
    ) {
      errors.push(finding(
        "INVALID_SOURCE_HASH",
        "Each source hash requires a bounded reference and lowercase SHA-256"
      ));
    }
  }
}

function containsSecret(value, key = "") {
  if (Array.isArray(value)) {
    return value.some(item => containsSecret(item, key));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsSecret(childValue, childKey)
    );
  }

  if (typeof value !== "string") {
    return false;
  }

  if (SECRET_KEY_PATTERN.test(key) && value.trim()) {
    return true;
  }

  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

function containsUntrustedInstruction(value) {
  if (Array.isArray(value)) {
    return value.some(item => containsUntrustedInstruction(item));
  }

  if (value && typeof value === "object") {
    return Object.values(value).some(item => containsUntrustedInstruction(item));
  }

  return typeof value === "string" &&
    INSTRUCTION_PATTERNS.some(pattern => pattern.test(value));
}

function calculateCompleteness(payload) {
  const checks = [
    Boolean(payload.objective?.trim()),
    Boolean(payload.operational_state?.trim()),
    payload.decisions_in_force?.length > 0,
    payload.open_threads?.length > 0,
    payload.next_actions?.length > 0,
    payload.mounted_skills?.length > 0,
    payload.relevant_files?.length > 0,
    payload.knowledge_references?.length > 0
  ];
  const achieved = checks.filter(Boolean).length;

  return Number((achieved / checks.length).toFixed(4));
}

function validationResult({
  errors,
  warnings,
  normalizedPayload,
  completenessScore
}) {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized_payload: normalizedPayload,
    completeness_score: completenessScore
  };
}

function finding(code, message, details = undefined) {
  return details === undefined
    ? { code, message }
    : { code, message, details };
}

export function classifyFreshness(input) {
  if (!input) {
    return {
      status: "NO_CONTEXT",
      age_seconds: null,
      freshness_limit_seconds: null,
      reason: "No valid checkpoint exists"
    };
  }

  const {
    publishedAt,
    now = new Date(),
    freshnessLimitSeconds = DEFAULT_FRESHNESS_LIMIT_SECONDS,
    state,
    contextStatus,
    integrityState
  } = input;
  const limit = clampFreshnessLimit(freshnessLimitSeconds);
  const publishedTime = Date.parse(publishedAt);
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const ageSeconds = Number.isFinite(publishedTime) && Number.isFinite(nowTime)
    ? Math.max(0, Math.floor((nowTime - publishedTime) / 1000))
    : null;

  if (
    state === "quarantined" ||
    state === "invalidated" ||
    integrityState === "hash_mismatch" ||
    integrityState === "corrupt"
  ) {
    return freshnessResult(
      "QUARANTINED_CONTEXT",
      ageSeconds,
      limit,
      "Checkpoint integrity or eligibility failed"
    );
  }

  if (
    contextStatus === "degraded" ||
    contextStatus === "backfilled" ||
    ageSeconds === null
  ) {
    return freshnessResult(
      "DEGRADED_CONTEXT",
      ageSeconds,
      limit,
      "Checkpoint is incomplete, backfilled, or partially verifiable"
    );
  }

  if (ageSeconds > limit || contextStatus === "stale") {
    return freshnessResult(
      "STALE_CONTEXT",
      ageSeconds,
      limit,
      "No newer published checkpoint exists"
    );
  }

  return freshnessResult(
    "CURRENT_CONTEXT",
    ageSeconds,
    limit,
    "Latest valid checkpoint is within its operational freshness window"
  );
}

function clampFreshnessLimit(value) {
  const parsed = Number(value);
  const finite = Number.isFinite(parsed)
    ? Math.floor(parsed)
    : DEFAULT_FRESHNESS_LIMIT_SECONDS;

  return Math.min(
    MAX_FRESHNESS_LIMIT_SECONDS,
    Math.max(MIN_FRESHNESS_LIMIT_SECONDS, finite)
  );
}

function freshnessResult(status, ageSeconds, freshnessLimitSeconds, reason) {
  return {
    status,
    age_seconds: ageSeconds,
    freshness_limit_seconds: freshnessLimitSeconds,
    reason
  };
}
