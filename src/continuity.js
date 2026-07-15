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

export function continuityFlagEnabled(env, name) {
  return new Set(["1", "true", "yes", "on", "enabled"])
    .has(String(env?.[name] ?? "").trim().toLowerCase());
}

export function assertContinuityTarget(principal, {
  identityId,
  projectId,
  operation = "read"
}) {
  const identity = normalizeIdentityId(identityId);
  const project = normalizeProjectId(projectId);
  const role = principal?.principal_id || principal?.role;
  const projectIds = Array.isArray(principal?.project_ids)
    ? principal.project_ids
    : [];

  if (!projectIds.includes("*") && !projectIds.includes(project)) {
    throw new ContinuityError(
      "continuity_project_forbidden",
      "Credential is not authorized for the requested continuity project",
      403
    );
  }

  const crossIdentityRole = role === "root" || role === "orchestrator";
  if (!crossIdentityRole && principal?.credential_id !== identity) {
    throw new ContinuityError(
      "continuity_identity_forbidden",
      `Credential cannot ${operation} continuity for the requested identity`,
      403
    );
  }

  return { identity_id: identity, project_id: project };
}

export async function createCandidateCheckpoint({
  body,
  env,
  principal,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireContinuityDatabase(env);

  if (!continuityFlagEnabled(env, "CONTINUITY_WRITE_ENABLED")) {
    throw new ContinuityError(
      "continuity_write_disabled",
      "Continuity writes are disabled",
      503
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ContinuityError("invalid_request", "Checkpoint request must be an object");
  }

  const identityId = normalizeIdentityId(body.identity_id);
  const projectId = normalizeProjectId(body.project_id);
  const scopeKey = normalizeScopeKey(body.scope_key);
  assertContinuityTarget(principal, {
    identityId,
    projectId,
    operation: "write"
  });

  const idempotencyKey = normalizeIdempotencyKey(body.idempotency_key);
  const existing = await env.DB
    .prepare(SQL.GET_IDEMPOTENT)
    .bind(principal.credential_id, idempotencyKey)
    .first();

  if (existing) {
    if (
      existing.identity_id !== identityId ||
      existing.project_id !== projectId ||
      existing.scope_key !== scopeKey
    ) {
      throw new ContinuityError(
        "idempotency_scope_conflict",
        "Idempotency key is already bound to another continuity scope",
        409
      );
    }

    return {
      ok: true,
      runway_id: existing.runway_id,
      state: existing.state,
      generation: existing.generation,
      manifest_hash: existing.manifest_hash,
      validation_status: existing.integrity_state,
      idempotent_replay: true,
      http_status: 200
    };
  }

  const currentHead = await env.DB
    .prepare(SQL.GET_HEAD)
    .bind(identityId, projectId, scopeKey)
    .first();
  const expectedPredecessor = currentHead?.runway_id || null;
  const requestedPredecessor = normalizeNullableId(
    body.predecessor_runway_id,
    "predecessor_runway_id"
  );

  if (requestedPredecessor !== expectedPredecessor) {
    throw new ContinuityError(
      "predecessor_mismatch",
      "Checkpoint predecessor does not match the exact current head",
      409,
      {
        expected_predecessor_runway_id: expectedPredecessor,
        supplied_predecessor_runway_id: requestedPredecessor
      }
    );
  }

  const createdAt = now().toISOString();
  const runwayId = `rwy_${randomUUID()}`;
  const generation = Number(currentHead?.generation || 0) + 1;
  const sourceInvocationId = normalizeNullableId(
    body.source_invocation_id,
    "source_invocation_id",
    { required: true }
  );
  const sourceHashes = Array.isArray(body.source_hashes)
    ? structuredClone(body.source_hashes)
    : body.source_hashes;
  const payload = {
    ...(body.payload && typeof body.payload === "object" ? structuredClone(body.payload) : {}),
    schema: RUNWAY_SCHEMA,
    runway_id: runwayId,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    generation,
    predecessor_runway_id: expectedPredecessor,
    source_invocation_id: sourceInvocationId,
    source_hashes: sourceHashes,
    created_at: createdAt
  };
  const validation = await validateRunwayCandidate({
    payload,
    sourceHashes,
    expectedIdentityId: identityId,
    expectedProjectId: projectId,
    expectedScopeKey: scopeKey
  });

  if (!validation.valid) {
    throw new ContinuityError(
      "checkpoint_validation_failed",
      "Checkpoint candidate failed bounded validation",
      422,
      { findings: validation.errors }
    );
  }

  const manifest = await buildRunwayManifest({ payload, sourceHashes });
  const contextStatus = payload.context_status === "backfilled"
    ? "backfilled"
    : "current";
  const summary = typeof payload.summary === "string" && payload.summary.trim()
    ? payload.summary.trim()
    : payload.operational_state.slice(0, CONTINUITY_LIMITS.summary_chars);

  await env.DB.prepare(SQL.INSERT_RUNWAY).bind(
    runwayId,
    RUNWAY_SCHEMA,
    identityId,
    projectId,
    scopeKey,
    expectedPredecessor,
    sourceInvocationId,
    generation,
    "candidate",
    contextStatus,
    payload.objective,
    summary,
    canonicalJson(payload),
    manifest.manifest_hash,
    canonicalJson(sourceHashes),
    "candidate_validated",
    validation.completeness_score,
    principal.credential_id,
    idempotencyKey,
    null,
    "not_required",
    createdAt
  ).run();

  return {
    ok: true,
    runway_id: runwayId,
    state: "candidate",
    generation,
    manifest_hash: manifest.manifest_hash,
    validation_status: "candidate_validated",
    idempotent_replay: false,
    http_status: 201
  };
}

export async function validateCandidateCheckpoint({
  runwayId,
  env,
  principal,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireContinuityDatabase(env);

  if (!continuityFlagEnabled(env, "CONTINUITY_WRITE_ENABLED")) {
    throw new ContinuityError(
      "continuity_write_disabled",
      "Continuity validation is disabled",
      503
    );
  }

  const normalizedRunwayId = normalizeNullableId(runwayId, "runway_id", {
    required: true
  });
  const row = await env.DB.prepare(SQL.GET_RUNWAY)
    .bind(normalizedRunwayId)
    .first();

  if (!row) {
    throw new ContinuityError("runway_not_found", "Checkpoint does not exist", 404);
  }

  assertContinuityTarget(principal, {
    identityId: row.identity_id,
    projectId: row.project_id,
    operation: "validate"
  });

  const payload = parseStoredJson(row.payload_json, "payload_json");
  const sourceHashes = parseStoredJson(row.source_hashes_json, "source_hashes_json");
  const validation = await validateRunwayCandidate({
    payload,
    sourceHashes,
    expectedIdentityId: row.identity_id,
    expectedProjectId: row.project_id,
    expectedScopeKey: row.scope_key
  });
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];
  const manifest = await buildRunwayManifest({ payload, sourceHashes });

  if (manifest.manifest_hash !== row.manifest_hash) {
    errors.push(finding(
      "MANIFEST_HASH_MISMATCH",
      "Stored checkpoint manifest hash does not match canonical content"
    ));
  }

  if (row.predecessor_runway_id) {
    const predecessor = await env.DB.prepare(SQL.GET_RUNWAY)
      .bind(row.predecessor_runway_id)
      .first();

    if (!predecessor) {
      errors.push(finding("INVALID_PREDECESSOR", "Checkpoint predecessor is unavailable"));
    } else if (
      predecessor.identity_id !== row.identity_id ||
      predecessor.project_id !== row.project_id ||
      predecessor.scope_key !== row.scope_key ||
      Number(predecessor.generation) + 1 !== Number(row.generation)
    ) {
      errors.push(finding(
        "INVALID_PREDECESSOR_LINEAGE",
        "Checkpoint predecessor does not preserve exact tuple lineage"
      ));
    }
  } else if (Number(row.generation) !== 1) {
    errors.push(finding(
      "INVALID_GENESIS_GENERATION",
      "A checkpoint without a predecessor must be generation 1"
    ));
  }

  const quarantined = errors.some(error => new Set([
    "MANIFEST_HASH_MISMATCH",
    "INVALID_PREDECESSOR",
    "INVALID_PREDECESSOR_LINEAGE",
    "PROHIBITED_SECRET_CONTENT",
    "INVALID_SOURCE_HASH"
  ]).has(error.code));
  const status = errors.length === 0
    ? "passed"
    : quarantined ? "quarantined" : "failed";
  const runwayState = status === "passed"
    ? "validated"
    : status === "quarantined" ? "quarantined" : "rejected";
  const createdAt = now().toISOString();
  const validationId = `val_${randomUUID()}`;
  const receiptBody = {
    validation_id: validationId,
    runway_id: row.runway_id,
    validator_credential_id: principal.credential_id,
    status,
    errors,
    warnings,
    completeness_score: validation.completeness_score,
    created_at: createdAt
  };
  const receiptHash = await sha256Hex(canonicalJson(receiptBody));

  await env.DB.batch([
    env.DB.prepare(SQL.INSERT_VALIDATION).bind(
      validationId,
      row.runway_id,
      principal.credential_id,
      status,
      canonicalJson(errors),
      canonicalJson(warnings),
      validation.completeness_score,
      receiptHash,
      createdAt
    ),
    env.DB.prepare(SQL.SET_RUNWAY_VALIDATION_STATE).bind(
      runwayState,
      status === "passed" ? "verified" : status,
      validation.completeness_score,
      createdAt,
      row.runway_id
    )
  ]);

  return {
    ok: status === "passed",
    validation_id: validationId,
    runway_id: row.runway_id,
    status,
    errors,
    warnings,
    completeness_score: validation.completeness_score,
    receipt_hash: receiptHash,
    state: runwayState
  };
}

function requireContinuityDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new ContinuityError(
      "continuity_database_unavailable",
      "D1 continuity storage is unavailable",
      503
    );
  }
}

function normalizeIdempotencyKey(value) {
  const key = String(value ?? "").trim();

  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ContinuityError(
      "invalid_idempotency_key",
      "idempotency_key must be 8-128 bounded characters"
    );
  }

  return key;
}

function normalizeNullableId(value, field, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) {
      throw new ContinuityError(
        `invalid_${field}`,
        `${field} is required`
      );
    }
    return null;
  }

  const normalized = String(value).trim();
  if (normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new ContinuityError(
      `invalid_${field}`,
      `${field} has an invalid bounded identifier format`
    );
  }

  return normalized;
}

function parseStoredJson(value, field) {
  try {
    return JSON.parse(value);
  } catch {
    throw new ContinuityError(
      "stored_checkpoint_malformed",
      `Stored ${field} is not valid JSON`,
      500
    );
  }
}

const SQL = Object.freeze({
  GET_HEAD: `/* continuity:get-head */
    SELECT * FROM context_runway_heads
     WHERE identity_id = ? AND project_id = ? AND scope_key = ?`,
  GET_RUNWAY: `/* continuity:get-runway */
    SELECT * FROM context_runways WHERE runway_id = ?`,
  GET_IDEMPOTENT: `/* continuity:get-idempotent */
    SELECT * FROM context_runways
     WHERE created_by_credential_id = ? AND idempotency_key = ?`,
  INSERT_RUNWAY: `/* continuity:insert-runway */
    INSERT INTO context_runways (
      runway_id, schema_version, identity_id, project_id, scope_key,
      predecessor_runway_id, source_invocation_id, generation, state,
      context_status, objective, summary, payload_json, manifest_hash,
      source_hashes_json, integrity_state, completeness_score,
      created_by_credential_id, idempotency_key, portable_artifact_ref,
      indexing_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_VALIDATION: `/* continuity:insert-validation */
    INSERT INTO context_runway_validations (
      validation_id, runway_id, validator_credential_id, status,
      errors_json, warnings_json, completeness_score, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  SET_RUNWAY_VALIDATION_STATE: `/* continuity:set-runway-validation-state */
    UPDATE context_runways
       SET state = ?, integrity_state = ?, completeness_score = ?, validated_at = ?
     WHERE runway_id = ?`
});
