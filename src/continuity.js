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

const INVOCATION_ELIGIBLE_CONTEXT_STATUSES = new Set([
  "CURRENT_CONTEXT",
  "STALE_CONTEXT",
  "DEGRADED_CONTEXT",
  "NO_CONTEXT"
]);

export async function requireInvocationContinuity({
  request,
  env,
  principal,
  identityId
}) {
  if (!continuityFlagEnabled(env, "CONTINUITY_INVOCATION_ENFORCEMENT")) {
    return null;
  }

  requireContinuityDatabase(env);
  const receiptId = String(
    request.headers.get("X-Continuity-Receipt") || ""
  ).trim();

  if (!receiptId) {
    throw new ContinuityError(
      "continuity_receipt_required",
      "Exact contextual continuity must be resolved before invocation",
      428
    );
  }

  const receipt = await env.DB.prepare(SQL.GET_RETRIEVAL_RECEIPT)
    .bind(principal.tenant_id, receiptId)
    .first();
  if (!receipt) {
    throw new ContinuityError(
      "continuity_receipt_invalid",
      "Continuity receipt is unavailable",
      428
    );
  }

  const expectedIdentity = normalizeIdentityId(identityId);
  if (
    receipt.requesting_credential_id !== principal.credential_id ||
    receipt.identity_id !== expectedIdentity
  ) {
    throw new ContinuityError(
      "continuity_receipt_scope_mismatch",
      "Continuity receipt does not match the invoking credential and identity",
      403
    );
  }

  if (!INVOCATION_ELIGIBLE_CONTEXT_STATUSES.has(receipt.context_status)) {
    throw new ContinuityError(
      "continuity_context_ineligible",
      "Resolved context is not eligible for specialist invocation",
      428,
      { context_status: receipt.context_status }
    );
  }

  return {
    receipt_id: receipt.receipt_id,
    identity_id: receipt.identity_id,
    project_id: receipt.project_id,
    scope_key: receipt.scope_key,
    context_status: receipt.context_status,
    selected_runway_id: receipt.selected_runway_id,
    selected_generation: receipt.selected_generation
  };
}

export function assertContinuityTarget(principal, {
  identityId,
  projectId,
  operation = "read"
}) {
  const identity = normalizeIdentityId(identityId);
  const project = normalizeProjectId(projectId);
  const projectIds = Array.isArray(principal?.project_ids)
    ? principal.project_ids
    : [];
  const identityIds = Array.isArray(principal?.identity_ids)
    ? principal.identity_ids
    : [principal?.credential_id].filter(Boolean);

  if (!projectIds.includes("*") && !projectIds.includes(project)) {
    throw new ContinuityError(
      "continuity_project_forbidden",
      "Credential is not authorized for the requested continuity project",
      403
    );
  }

  if (!identityIds.includes("*") && !identityIds.includes(identity)) {
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

  const obsidianSubmission = body?.source === "obsidian-plugin" ||
    body?.client === "obsidian";
  if (
    obsidianSubmission &&
    !continuityFlagEnabled(env, "CONTINUITY_OBSIDIAN_ACTIONS")
  ) {
    throw new ContinuityError(
      "continuity_obsidian_actions_disabled",
      "Obsidian continuity submissions are disabled",
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
    .bind(principal.tenant_id, principal.credential_id, idempotencyKey)
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
    .bind(principal.tenant_id, identityId, projectId, scopeKey)
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
    principal.tenant_id,
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

  await emitContinuityMetric(env, "continuity.candidate.created", {
    credential_id: principal.credential_id,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    runway_id: runwayId,
    generation,
    status: "candidate"
  });

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
  const row = await env.DB.prepare(SQL.GET_RUNWAY_FOR_TENANT)
    .bind(principal.tenant_id, normalizedRunwayId)
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
    const predecessor = await env.DB.prepare(SQL.GET_RUNWAY_FOR_TENANT)
      .bind(principal.tenant_id, row.predecessor_runway_id)
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
      principal.tenant_id,
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
      principal.tenant_id,
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

export async function resolveLatestRunway({
  env,
  principal,
  tenantId = principal?.tenant_id,
  identityId,
  projectId,
  scopeKey,
  requestedDomains = [],
  permittedDomains = [],
  now = new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireContinuityDatabase(env);

  if (!continuityFlagEnabled(env, "CONTINUITY_READ_ENABLED")) {
    throw new ContinuityError(
      "continuity_read_disabled",
      "Continuity reads are disabled",
      503
    );
  }

  const identity = normalizeIdentityId(identityId);
  const tenant = normalizeIdentityId(tenantId);
  const project = normalizeProjectId(projectId);
  const scope = normalizeScopeKey(scopeKey);
  assertContinuityTarget(principal, {
    identityId: identity,
    projectId: project,
    operation: "read"
  });

  const fallbackPath = [];
  let selected = null;
  let resolution = "exact";
  let expectedTuple = {
    tenant_id: tenant,
    identity_id: identity,
    project_id: project,
    scope_key: scope
  };
  const exactHead = await getHead(env.DB, expectedTuple);

  if (exactHead) {
    fallbackPath.push("exact:hit");
    const exactResult = await verifyHeadTarget({
      db: env.DB,
      head: exactHead,
      expectedTuple,
      now,
      freshnessLimitSeconds: env.CONTINUITY_FRESHNESS_SECONDS
    });

    if (!exactResult.ok) {
      return persistResolution({
        env,
        principal,
        identity,
        project,
        scope,
        fallbackPath,
        requestedDomains,
        permittedDomains,
        context: quarantinedContext(exactHead, exactResult.reason),
        now,
        randomUUID
      });
    }

    selected = exactResult.context;
  } else {
    fallbackPath.push("exact:miss");

    if (scope !== "default") {
      expectedTuple = {
        tenant_id: tenant,
        identity_id: identity,
        project_id: project,
        scope_key: "default"
      };
      const defaultHead = await getHead(env.DB, expectedTuple);

      if (defaultHead) {
        fallbackPath.push("default:hit");
        const defaultResult = await verifyHeadTarget({
          db: env.DB,
          head: defaultHead,
          expectedTuple,
          now,
          freshnessLimitSeconds: env.CONTINUITY_FRESHNESS_SECONDS,
          fallback: true
        });

        if (!defaultResult.ok) {
          return persistResolution({
            env,
            principal,
            identity,
            project,
            scope,
            fallbackPath,
            requestedDomains,
            permittedDomains,
            context: quarantinedContext(defaultHead, defaultResult.reason),
            now,
            randomUUID
          });
        }

        selected = defaultResult.context;
        resolution = "default_scope_fallback";
      } else {
        fallbackPath.push("default:miss");
      }
    } else {
      fallbackPath.push("default:same_as_exact");
    }

    if (!selected) {
      const genesis = await env.DB.prepare(SQL.GET_GENESIS)
        .bind(tenant, identity, project)
        .first();

      if (genesis) {
        fallbackPath.push("genesis:hit");
        const genesisResult = await verifyStoredRunway({
          row: genesis,
          expectedTuple: {
            tenant_id: tenant,
            identity_id: identity,
            project_id: project,
            scope_key: genesis.scope_key
          },
          now,
          freshnessLimitSeconds: env.CONTINUITY_FRESHNESS_SECONDS,
          fallback: true
        });

        if (genesisResult.ok) {
          selected = genesisResult.context;
          resolution = "genesis_fallback";
        } else {
          return persistResolution({
            env,
            principal,
            identity,
            project,
            scope,
            fallbackPath,
            requestedDomains,
            permittedDomains,
            context: quarantinedContext(genesis, genesisResult.reason),
            now,
            randomUUID
          });
        }
      } else {
        fallbackPath.push("genesis:miss");
      }
    }

    if (!selected) {
      if (continuityFlagEnabled(env, "CONTINUITY_GLOBAL_FALLBACK_ENABLED")) {
        const globalTuple = {
          tenant_id: tenant,
          identity_id: identity,
          project_id: "global",
          scope_key: "default"
        };
        const globalHead = await getHead(env.DB, globalTuple);

        if (globalHead) {
          fallbackPath.push("global:hit");
          const globalResult = await verifyHeadTarget({
            db: env.DB,
            head: globalHead,
            expectedTuple: globalTuple,
            now,
            freshnessLimitSeconds: env.CONTINUITY_FRESHNESS_SECONDS,
            fallback: true
          });

          if (globalResult.ok) {
            selected = globalResult.context;
            resolution = "global_fallback";
          } else {
            return persistResolution({
              env,
              principal,
              identity,
              project,
              scope,
              fallbackPath,
              requestedDomains,
              permittedDomains,
              context: quarantinedContext(globalHead, globalResult.reason),
              now,
              randomUUID
            });
          }
        } else {
          fallbackPath.push("global:miss");
        }
      } else {
        fallbackPath.push("global:not_permitted");
      }
    }

    if (!selected) {
      const backfilled = await env.DB.prepare(SQL.GET_BACKFILLED)
        .bind(tenant, identity, project, scope)
        .first();

      if (backfilled) {
        fallbackPath.push("backfill:hit");
        const backfillResult = await verifyStoredRunway({
          row: backfilled,
          expectedTuple: {
            tenant_id: tenant,
            identity_id: identity,
            project_id: project,
            scope_key: scope
          },
          now,
          freshnessLimitSeconds: env.CONTINUITY_FRESHNESS_SECONDS,
          fallback: true
        });

        if (backfillResult.ok) {
          selected = backfillResult.context;
          resolution = "backfill_fallback";
        } else {
          return persistResolution({
            env,
            principal,
            identity,
            project,
            scope,
            fallbackPath,
            requestedDomains,
            permittedDomains,
            context: quarantinedContext(backfilled, backfillResult.reason),
            now,
            randomUUID
          });
        }
      } else {
        fallbackPath.push("backfill:miss");
      }
    }
  }

  if (!selected) {
    fallbackPath.push("no_context");
    return persistResolution({
      env,
      principal,
      tenant,
      identity,
      project,
      scope,
      fallbackPath,
      requestedDomains,
      permittedDomains,
      context: {
        status: "NO_CONTEXT",
        runway_id: null,
        generation: null,
        payload: null,
        age_seconds: null,
        freshness_limit_seconds: null,
        reason: "No valid checkpoint exists",
        resolution: "none"
      },
      now,
      randomUUID
    });
  }

  selected.resolution = resolution;
  if (resolution !== "exact") {
    selected.status = "DEGRADED_CONTEXT";
    selected.reason = "A governed fallback supplied continuity because the exact scope had no head";
  }

  return persistResolution({
    env,
    principal,
    tenant,
    identity,
    project,
    scope,
    fallbackPath,
    requestedDomains,
    permittedDomains,
    context: selected,
    now,
    randomUUID
  });
}

export async function publishCheckpoint({
  runwayId,
  body,
  env,
  principal,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireContinuityDatabase(env);

  if (!continuityFlagEnabled(env, "CONTINUITY_PUBLICATION_ENABLED")) {
    throw new ContinuityError(
      "continuity_publication_disabled",
      "Continuity publication is disabled",
      503
    );
  }

  const normalizedRunwayId = normalizeNullableId(runwayId, "runway_id", {
    required: true
  });
  const row = await env.DB.prepare(SQL.GET_RUNWAY_FOR_TENANT)
    .bind(principal.tenant_id, normalizedRunwayId)
    .first();

  if (!row) {
    throw new ContinuityError("runway_not_found", "Checkpoint does not exist", 404);
  }

  assertContinuityTarget(principal, {
    identityId: row.identity_id,
    projectId: row.project_id,
    operation: "publish"
  });

  const currentHead = await getHead(env.DB, row);
  if (row.state === "published" && currentHead?.runway_id === row.runway_id) {
    return {
      ok: true,
      runway_id: row.runway_id,
      state: "published",
      generation: Number(row.generation),
      manifest_hash: row.manifest_hash,
      idempotent_replay: true
    };
  }

  const validation = await env.DB.prepare(SQL.GET_LATEST_VALIDATION)
    .bind(principal.tenant_id, row.runway_id)
    .first();

  if (!validation || validation.status !== "passed" || row.state !== "validated") {
    throw new ContinuityError(
      "publication_validation_required",
      "Checkpoint requires a passed validation receipt before publication",
      422
    );
  }

  const expectedGeneration = normalizeExpectedGeneration(body?.expected_generation);
  const expectedPredecessor = normalizeNullableId(
    body?.expected_predecessor_runway_id,
    "expected_predecessor_runway_id"
  );

  if (
    Number(row.generation) !== expectedGeneration + 1 ||
    row.predecessor_runway_id !== expectedPredecessor
  ) {
    throw new ContinuityError(
      "publication_expectation_mismatch",
      "Publication expectation does not match candidate lineage",
      409
    );
  }

  const startedAt = now().toISOString();
  const attemptId = `attempt_${randomUUID()}`;
  const observedGeneration = currentHead == null
    ? null
    : Number(currentHead.generation);

  await env.DB.prepare(SQL.INSERT_PUBLICATION_ATTEMPT).bind(
    attemptId,
    principal.tenant_id,
    row.runway_id,
    expectedGeneration,
    observedGeneration,
    "started",
    null,
    null,
    startedAt,
    null
  ).run();

  try {
    const artifactRequired = continuityFlagEnabled(env, "CONTINUITY_ARTIFACT_REQUIRED");
    const indexingRequired = continuityFlagEnabled(env, "CONTINUITY_INDEX_REQUIRED");
    const sealed = await env.DB.prepare(SQL.SEAL_RUNWAY).bind(
      startedAt,
      indexingRequired ? "pending" : "not_required",
      principal.tenant_id,
      row.runway_id
    ).run();

    if (changedRows(sealed) !== 1) {
      throw new ContinuityError(
        "publication_state_conflict",
        "Checkpoint could not be sealed from its validated state",
        409
      );
    }

    const payload = parseStoredJson(row.payload_json, "payload_json");

    if (artifactRequired) {
      const artifactRef = await persistPortableArtifact({ env, row, payload });
      await env.DB.prepare(SQL.SET_ARTIFACT_REF)
        .bind(artifactRef, principal.tenant_id, row.runway_id)
        .run();
    }

    if (indexingRequired) {
      await indexRunwaySummary({ env, row, payload });
      await env.DB.prepare(SQL.SET_INDEXING_STATE)
        .bind("complete", "sealed", principal.tenant_id, row.runway_id)
        .run();
    }

    const publishedAt = now().toISOString();
    const published = await env.DB.prepare(SQL.PUBLISH_HEAD_CAS).bind(
      principal.tenant_id,
      row.identity_id,
      row.project_id,
      row.scope_key,
      row.runway_id,
      Number(row.generation),
      row.manifest_hash,
      publishedAt,
      expectedGeneration,
      expectedPredecessor
    ).run();

    if (changedRows(published) !== 1) {
      throw new ContinuityError(
        "publication_conflict",
        "Another successor advanced the exact runway head",
        409
      );
    }

    await updatePublicationAttempt(env.DB, {
      attemptId,
      tenantId: principal.tenant_id,
      status: "succeeded",
      errorCode: null,
      errorMessage: null,
      completedAt: now().toISOString()
    });

    return {
      ok: true,
      runway_id: row.runway_id,
      state: "published",
      generation: Number(row.generation),
      manifest_hash: row.manifest_hash,
      publication_attempt_id: attemptId,
      idempotent_replay: false
    };
  } catch (error) {
    const continuityError = normalizePublicationError(error);
    const attemptStatus = continuityError.code === "publication_conflict"
      ? "conflict"
      : "failed";
    const indexingState = continuityError.code === "continuity_indexing_failed"
      ? "failed"
      : "not_required";

    try {
      await env.DB.prepare(SQL.SET_PUBLICATION_FAILED)
        .bind(indexingState, principal.tenant_id, row.runway_id)
        .run();
      await updatePublicationAttempt(env.DB, {
        attemptId,
        tenantId: principal.tenant_id,
        status: attemptStatus,
        errorCode: continuityError.code,
        errorMessage: "Publication stage failed",
        completedAt: now().toISOString()
      });
    } catch {
      // The bounded API error is retained even when failure bookkeeping is
      // unavailable; raw provider or database details are never echoed.
    }

    throw continuityError;
  }
}

export async function invalidateCheckpoint({
  runwayId,
  body,
  env,
  principal,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  requireContinuityDatabase(env);

  if (!continuityFlagEnabled(env, "CONTINUITY_PUBLICATION_ENABLED")) {
    throw new ContinuityError(
      "continuity_publication_disabled",
      "Continuity invalidation is disabled",
      503
    );
  }

  const normalizedRunwayId = normalizeNullableId(runwayId, "runway_id", {
    required: true
  });
  const reason = String(body?.reason || "").trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new ContinuityError(
      "invalid_invalidation_reason",
      "Invalidation reason must contain 8-500 characters"
    );
  }

  const row = await env.DB.prepare(SQL.GET_RUNWAY_FOR_TENANT)
    .bind(principal.tenant_id, normalizedRunwayId)
    .first();
  if (!row) {
    throw new ContinuityError("runway_not_found", "Checkpoint does not exist", 404);
  }

  assertContinuityTarget(principal, {
    identityId: row.identity_id,
    projectId: row.project_id,
    operation: "invalidate"
  });

  if (row.state === "invalidated") {
    const head = await getHead(env.DB, row);
    return {
      ok: true,
      runway_id: row.runway_id,
      state: "invalidated",
      restored_head_runway_id: head?.runway_id || null,
      idempotent_replay: true
    };
  }

  if (!["published", "superseded"].includes(row.state)) {
    throw new ContinuityError(
      "runway_not_invalidation_eligible",
      "Only published continuity history can be invalidated",
      409
    );
  }

  const currentHead = await getHead(env.DB, row);
  const wasCurrent = currentHead?.runway_id === row.runway_id;
  const restoredHeadId = wasCurrent ? row.predecessor_runway_id : currentHead?.runway_id || null;
  const createdAt = now().toISOString();
  const invalidationId = `invalidation_${randomUUID()}`;
  const receiptBody = {
    invalidation_id: invalidationId,
    runway_id: row.runway_id,
    invalidated_by_credential_id: principal.credential_id,
    reason,
    previous_head_runway_id: wasCurrent ? row.runway_id : null,
    restored_head_runway_id: restoredHeadId,
    created_at: createdAt
  };
  const receiptHash = await sha256Hex(canonicalJson(receiptBody));

  await env.DB.batch([
    env.DB.prepare(SQL.INVALIDATE_RUNWAY).bind(
      createdAt,
      reason,
      principal.tenant_id,
      row.runway_id
    ),
    env.DB.prepare(SQL.INSERT_INVALIDATION).bind(
      invalidationId,
      principal.tenant_id,
      row.runway_id,
      principal.credential_id,
      reason,
      wasCurrent ? row.runway_id : null,
      restoredHeadId,
      createdAt,
      receiptHash
    )
  ]);

  const restoredHead = await getHead(env.DB, row);
  return {
    ok: true,
    invalidation_id: invalidationId,
    runway_id: row.runway_id,
    state: "invalidated",
    restored_head_runway_id: restoredHead?.runway_id || null,
    receipt_hash: receiptHash,
    idempotent_replay: false
  };
}

async function persistPortableArtifact({ env, row, payload }) {
  if (!env.CONTINUITY_ARTIFACTS || typeof env.CONTINUITY_ARTIFACTS.put !== "function") {
    throw new ContinuityError(
      "portable_artifact_failed",
      "Required portable artifact storage is unavailable",
      502
    );
  }

  const key = [
    "continuity",
    row.project_id,
    row.identity_id,
    row.scope_key,
    `${row.runway_id}.md`
  ].join("/");
  const markdown = renderPortableRunway(row, payload);

  try {
    await env.CONTINUITY_ARTIFACTS.put(key, markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: {
        runway_id: row.runway_id,
        manifest_hash: row.manifest_hash,
        schema: row.schema_version
      }
    });
  } catch {
    throw new ContinuityError(
      "portable_artifact_failed",
      "Required portable artifact generation or storage failed",
      502
    );
  }

  return key;
}

function renderPortableRunway(row, payload) {
  const list = value => Array.isArray(value) && value.length > 0
    ? value.map(item => `- ${typeof item === "string" ? item : canonicalJson(item)}`).join("\n")
    : "- None";

  return `---
id: ${row.runway_id}
title: ${row.identity_id} ${row.scope_key} runway ${row.generation}
created: ${payload.created_at}
status: sealed
sha256: ${row.manifest_hash}
parents: [${row.predecessor_runway_id || ""}]
sources: [invocation:${row.source_invocation_id || ""}]
tags: [continuity, runway, ${row.identity_id}]
schema: ${row.schema_version}
identity_id: ${row.identity_id}
project_id: ${row.project_id}
scope_key: ${row.scope_key}
generation: ${row.generation}
---
# Objective
${payload.objective}
# Current Operational State
${payload.operational_state}
# Decisions in Force
${list(payload.decisions_in_force)}
# Open Threads
${list(payload.open_threads)}
# Relevant Skills
${list(payload.mounted_skills)}
# Relevant Files
${list(payload.relevant_files)}
# Next Actions
${list(payload.next_actions)}
# Integrity Notes
${list(payload.integrity_warnings)}
`;
}

async function indexRunwaySummary({ env, row, payload }) {
  if (
    !env.AI || typeof env.AI.run !== "function" ||
    !env.MATRIX_KNOWLEDGE || typeof env.MATRIX_KNOWLEDGE.upsert !== "function"
  ) {
    throw new ContinuityError(
      "continuity_indexing_failed",
      "Required continuity indexing bindings are unavailable",
      502
    );
  }

  try {
    const embedding = await env.AI.run(
      "@cf/baai/bge-large-en-v1.5",
      { text: [`${payload.objective}\n${payload.operational_state}`.slice(0, 2000)] }
    );
    const vector = embedding.data?.[0];
    if (!vector) throw new Error("missing vector");

    await env.MATRIX_KNOWLEDGE.upsert([{
      id: `continuity:${row.runway_id}:summary`,
      values: vector,
      metadata: {
        document_id: row.runway_id,
        schema: row.schema_version,
        status: "sealed",
        project_id: row.project_id,
        scope_key: row.scope_key,
        runway_id: row.runway_id,
        identity_id: row.identity_id,
        generation: String(row.generation),
        sha256: row.manifest_hash,
        source_ref: `runway:${row.runway_id}`,
        created: row.created_at
      }
    }]);
  } catch {
    throw new ContinuityError(
      "continuity_indexing_failed",
      "Required continuity indexing failed",
      502
    );
  }
}

function normalizePublicationError(error) {
  if (error instanceof ContinuityError) return error;
  return new ContinuityError(
    "continuity_publication_unavailable",
    "Continuity publication storage is unavailable",
    503
  );
}

function normalizeExpectedGeneration(value) {
  const generation = Number(value);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new ContinuityError(
      "invalid_expected_generation",
      "expected_generation must be a non-negative integer"
    );
  }
  return generation;
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

async function updatePublicationAttempt(db, {
  attemptId,
  tenantId,
  status,
  errorCode,
  errorMessage,
  completedAt
}) {
  await db.prepare(SQL.UPDATE_PUBLICATION_ATTEMPT).bind(
    status,
    errorCode,
    errorMessage,
    completedAt,
    tenantId,
    attemptId
  ).run();
}

async function getHead(db, tuple) {
  return db.prepare(SQL.GET_HEAD)
    .bind(
      tuple.tenant_id,
      tuple.identity_id,
      tuple.project_id,
      tuple.scope_key
    )
    .first();
}

async function verifyHeadTarget({ db, head, expectedTuple, ...options }) {
  const row = await db.prepare(SQL.GET_RUNWAY_FOR_TENANT)
    .bind(expectedTuple.tenant_id, head.runway_id)
    .first();

  if (!row) {
    return { ok: false, reason: "Runway head references a missing checkpoint" };
  }

  if (
    Number(head.generation) !== Number(row.generation) ||
    head.manifest_hash !== row.manifest_hash
  ) {
    return { ok: false, reason: "Runway head generation or hash does not match its checkpoint" };
  }

  return verifyStoredRunway({ row, expectedTuple, ...options });
}

async function verifyStoredRunway({
  row,
  expectedTuple,
  now,
  freshnessLimitSeconds,
  fallback = false
}) {
  const allowedState = fallback
    ? ["published", "superseded"].includes(row.state)
    : row.state === "published";

  if (!allowedState) {
    return { ok: false, reason: `Checkpoint state ${row.state} is not eligible for resolution` };
  }

  if (
    row.tenant_id !== expectedTuple.tenant_id ||
    row.identity_id !== expectedTuple.identity_id ||
    row.project_id !== expectedTuple.project_id ||
    row.scope_key !== expectedTuple.scope_key
  ) {
    return { ok: false, reason: "Checkpoint tuple does not match the exact lookup tuple" };
  }

  let payload;
  let sourceHashes;
  try {
    payload = JSON.parse(row.payload_json);
    sourceHashes = JSON.parse(row.source_hashes_json);
  } catch {
    return { ok: false, reason: "Checkpoint canonical content is malformed" };
  }

  const manifest = await buildRunwayManifest({ payload, sourceHashes });
  if (manifest.manifest_hash !== row.manifest_hash) {
    return { ok: false, reason: "Checkpoint manifest hash verification failed" };
  }

  if (
    payload.identity_id !== row.identity_id ||
    payload.project_id !== row.project_id ||
    payload.scope_key !== row.scope_key ||
    Number(payload.generation) !== Number(row.generation) ||
    payload.runway_id !== row.runway_id
  ) {
    return { ok: false, reason: "Checkpoint payload tuple or generation is inconsistent" };
  }

  const freshness = classifyFreshness({
    publishedAt: row.published_at,
    now,
    freshnessLimitSeconds,
    state: row.state,
    contextStatus: row.context_status,
    integrityState: row.integrity_state
  });

  return {
    ok: true,
    context: {
      ...freshness,
      runway_id: row.runway_id,
      generation: Number(row.generation),
      manifest_hash: row.manifest_hash,
      tenant_id: row.tenant_id,
      identity_id: row.identity_id,
      project_id: row.project_id,
      scope_key: row.scope_key,
      payload
    }
  };
}

function quarantinedContext(row, reason) {
  return {
    status: "QUARANTINED_CONTEXT",
    runway_id: row?.runway_id || null,
    generation: row?.generation == null ? null : Number(row.generation),
    payload: null,
    age_seconds: null,
    freshness_limit_seconds: null,
    reason,
    resolution: "integrity_failure"
  };
}

async function persistResolution({
  env,
  principal,
  tenant = principal?.tenant_id,
  identity,
  project,
  scope,
  fallbackPath,
  requestedDomains,
  permittedDomains,
  context,
  now,
  randomUUID
}) {
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const receiptId = `receipt_${randomUUID()}`;
  const receiptBody = {
    receipt_id: receiptId,
    tenant_id: tenant,
    requesting_credential_id: principal.credential_id,
    identity_id: identity,
    project_id: project,
    scope_key: scope,
    selected_runway_id: context.runway_id,
    selected_generation: context.generation,
    context_status: context.status,
    fallback_path: fallbackPath,
    requested_domains: requestedDomains,
    permitted_domains: permittedDomains,
    supplemental_search_used: false,
    supplemental_result_count: 0,
    omissions: [],
    created_at: createdAt
  };
  const receiptHash = await sha256Hex(canonicalJson(receiptBody));

  await env.DB.prepare(SQL.INSERT_RETRIEVAL_RECEIPT).bind(
    receiptId,
    tenant,
    principal.credential_id,
    identity,
    project,
    scope,
    context.runway_id,
    context.generation,
    context.status,
    canonicalJson(fallbackPath),
    canonicalJson(requestedDomains),
    canonicalJson(permittedDomains),
    0,
    0,
    "[]",
    receiptHash,
    createdAt
  ).run();

  const resolveMetric = {
    CURRENT_CONTEXT: "continuity.resolve.success",
    NO_CONTEXT: "continuity.resolve.missing",
    STALE_CONTEXT: "continuity.resolve.stale",
    DEGRADED_CONTEXT: "continuity.resolve.degraded",
    QUARANTINED_CONTEXT: "continuity.resolve.hash_failure",
    CONTEXT_UNAVAILABLE: "continuity.resolve.unavailable"
  }[context.status] || "continuity.resolve.degraded";
  await emitContinuityMetric(env, resolveMetric, {
    credential_id: principal.credential_id,
    identity_id: identity,
    project_id: project,
    scope_key: scope,
    runway_id: context.runway_id,
    generation: context.generation,
    receipt_id: receiptId,
    status: context.status
  });

  return {
    context,
    fallback_path: fallbackPath,
    retrieval_receipt_id: receiptId
  };
}

export async function rehydrateContext({
  body,
  env,
  principal,
  permittedDomains = [],
  supplementalSearch,
  now = new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ContinuityError(
      "invalid_rehydration_request",
      "Rehydration request must be an object"
    );
  }

  const startedAt = performance.now();
  const invocationId = normalizeNullableId(
    body.invocation_id || `inv_${randomUUID()}`,
    "invocation_id",
    { required: true }
  );
  const identityId = normalizeIdentityId(body.identity_id);
  const projectId = normalizeProjectId(body.project_id);
  const scopeKey = normalizeScopeKey(body.scope_key);
  const startedIso = (now instanceof Date ? now : new Date(now)).toISOString();

  await env.DB.prepare(SQL.INSERT_INVOCATION).bind(
    invocationId,
    principal.tenant_id,
    identityId,
    projectId,
    scopeKey,
    principal.credential_id,
    null,
    null,
    "opened",
    null,
    startedIso,
    null
  ).run();

  const requestedDomains = normalizeDomainList(body.supplemental_domains);
  const permitted = requestedDomains.length > 0
    ? requestedDomains.filter(domain => permittedDomains.includes(domain))
    : [...permittedDomains];
  const resolution = await resolveLatestRunway({
    env,
    principal,
    identityId,
    projectId,
    scopeKey,
    requestedDomains,
    permittedDomains: permitted,
    now
  });
  const omissions = [];
  const authorizedReferences = [];

  if (resolution.context.runway_id && resolution.context.payload) {
    const records = await env.DB.prepare(SQL.LIST_RUNWAY_RECORDS)
      .bind(principal.tenant_id, resolution.context.runway_id)
      .all();

    for (const record of records.results || []) {
      if (permittedDomains.includes(record.domain)) {
        authorizedReferences.push({
          record_id: record.record_id,
          domain: record.domain,
          record_type: record.record_type,
          source_ref: record.source_ref,
          source_hash: record.source_hash,
          relation: record.relation,
          ordinal: Number(record.ordinal)
        });
      } else {
        omissions.push({
          record_id: record.record_id,
          domain: record.domain,
          reason: "domain_not_permitted"
        });
      }
    }
  }

  resolution.context.authorized_references = authorizedReferences;

  const shadowEnabled = continuityFlagEnabled(env, "CONTINUITY_SHADOW_MODE");
  const supplementalQuery = String(
    body.supplemental_query || (shadowEnabled ? body.shadow_query : "") || ""
  ).trim();
  const supplemental = {
    used: supplementalQuery.length > 0,
    results: [],
    errors: []
  };

  if (supplemental.used) {
    if (permitted.length === 0) {
      supplemental.errors.push({ code: "no_permitted_supplemental_domains" });
    } else {
      try {
        const searchResult = await supplementalSearch({
          query: supplementalQuery,
          domains: permitted,
          topK: sanitizeContinuityTopK(body.top_k),
          projectId: normalizeProjectId(body.project_id),
          domainId: String(body.domain_id ?? "").trim().toLowerCase(),
          scopeKey: normalizeScopeKey(body.scope_key),
          runwayId: resolution.context.runway_id,
          createdAfter: body.created_after,
          sourceRefs: Array.isArray(body.source_refs) ? body.source_refs : []
        });
        supplemental.results = searchResult.results || [];
        supplemental.errors = searchResult.errors || [];
      } catch {
        supplemental.errors = [{ code: "supplemental_search_unavailable" }];
      }
    }
  }

  const receiptProjection = {
    receipt_id: resolution.retrieval_receipt_id,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    selected_runway_id: resolution.context.runway_id,
    selected_generation: resolution.context.generation,
    context_status: resolution.context.status,
    fallback_path: resolution.fallback_path,
    requested_domains: requestedDomains,
    permitted_domains: permitted,
    supplemental_search_used: supplemental.used,
    supplemental_result_count: supplemental.results.length,
    omissions
  };
  const receiptHash = await sha256Hex(canonicalJson(receiptProjection));

  await env.DB.prepare(SQL.UPDATE_RETRIEVAL_RECEIPT).bind(
    supplemental.used ? 1 : 0,
    supplemental.results.length,
    canonicalJson(omissions),
    canonicalJson(requestedDomains),
    canonicalJson(permitted),
    receiptHash,
    principal.tenant_id,
    resolution.retrieval_receipt_id
  ).run();

  await env.DB.prepare(SQL.SET_INVOCATION_REHYDRATED).bind(
    resolution.context.runway_id,
    resolution.retrieval_receipt_id,
    principal.tenant_id,
    invocationId
  ).run();

  const durationMs = Math.max(0, performance.now() - startedAt);
  const payloadBytes = resolution.context.payload
    ? new TextEncoder().encode(canonicalJson(resolution.context.payload)).byteLength
    : 0;
  await emitContinuityMetric(env, "continuity.rehydrate.duration_ms", {
    credential_id: principal.credential_id,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    runway_id: resolution.context.runway_id,
    generation: resolution.context.generation,
    receipt_id: resolution.retrieval_receipt_id,
    status: resolution.context.status,
    value: durationMs
  });
  await emitContinuityMetric(env, "continuity.rehydrate.payload_bytes", {
    credential_id: principal.credential_id,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    runway_id: resolution.context.runway_id,
    generation: resolution.context.generation,
    receipt_id: resolution.retrieval_receipt_id,
    status: resolution.context.status,
    value: payloadBytes
  });
  await emitContinuityMetric(env, "continuity.supplemental.used", {
    credential_id: principal.credential_id,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    runway_id: resolution.context.runway_id,
    receipt_id: resolution.retrieval_receipt_id,
    status: resolution.context.status,
    value: supplemental.used ? 1 : 0
  });
  await emitContinuityMetric(env, "continuity.supplemental.result_count", {
    credential_id: principal.credential_id,
    identity_id: identityId,
    project_id: projectId,
    scope_key: scopeKey,
    runway_id: resolution.context.runway_id,
    receipt_id: resolution.retrieval_receipt_id,
    status: resolution.context.status,
    value: supplemental.results.length
  });

  const invocation = {
    invocation_id: invocationId,
    runway_acknowledged: true,
    runway_id: resolution.context.runway_id,
    generation: resolution.context.generation,
    context_status: resolution.context.status
  };
  const shadow = shadowEnabled
    ? {
        enabled: true,
        exact_runway_id: resolution.context.runway_id,
        exact_context_status: resolution.context.status,
        legacy_top_result_id: supplemental.results[0]?.id || null,
        behavior_changed: false
      }
    : { enabled: false };

  return {
    context: resolution.context,
    supplemental,
    requested_domains: requestedDomains,
    permitted_domains: permitted,
    omissions,
    fallback_path: resolution.fallback_path,
    retrieval_receipt_id: resolution.retrieval_receipt_id,
    invocation,
    shadow
  };
}

export async function completeContinuityInvocation({
  invocationId,
  body,
  env,
  principal,
  now = () => new Date()
}) {
  requireContinuityDatabase(env);

  if (!continuityFlagEnabled(env, "CONTINUITY_WRITE_ENABLED")) {
    throw new ContinuityError(
      "continuity_write_disabled",
      "Continuity completion writes are disabled",
      503
    );
  }

  const normalizedInvocationId = normalizeNullableId(
    invocationId,
    "invocation_id",
    { required: true }
  );
  const invocation = await env.DB.prepare(SQL.GET_INVOCATION)
    .bind(principal.tenant_id, normalizedInvocationId)
    .first();
  if (!invocation) {
    throw new ContinuityError("invocation_not_found", "Invocation does not exist", 404);
  }

  assertContinuityTarget(principal, {
    identityId: invocation.identity_id,
    projectId: invocation.project_id,
    operation: "complete"
  });

  if (
    principal.principal_id === "specialist" &&
    invocation.credential_id !== principal.credential_id
  ) {
    throw new ContinuityError(
      "invocation_credential_mismatch",
      "Invocation belongs to another credential",
      403
    );
  }

  let state = "completed";
  let outcome;
  let candidate = null;

  if (body?.checkpoint_failed === true) {
    state = "failed";
    outcome = "checkpoint_failed";
  } else if (body?.continuity_changed === false) {
    outcome = "unchanged";
  } else if (body?.continuity_changed === true) {
    candidate = await createCandidateCheckpoint({
      body: {
        identity_id: invocation.identity_id,
        project_id: invocation.project_id,
        scope_key: invocation.scope_key,
        predecessor_runway_id: body.predecessor_runway_id,
        source_invocation_id: normalizedInvocationId,
        payload: body.checkpoint_payload,
        source_hashes: body.source_hashes || [],
        idempotency_key: body.idempotency_key
      },
      env,
      principal
    });
    outcome = "changed";
  } else {
    throw new ContinuityError(
      "continuity_outcome_required",
      "Completion must declare changed, unchanged, or checkpoint failure"
    );
  }

  const completedAt = now().toISOString();
  const result = await env.DB.prepare(SQL.COMPLETE_INVOCATION).bind(
    state,
    outcome,
    completedAt,
    principal.tenant_id,
    normalizedInvocationId,
    invocation.credential_id
  ).run();
  if (changedRows(result) !== 1) {
    throw new ContinuityError(
      "invocation_completion_conflict",
      "Invocation completion could not be recorded",
      409
    );
  }

  return {
    ok: true,
    invocation_id: normalizedInvocationId,
    state,
    continuity_outcome: outcome,
    candidate_runway_id: candidate?.runway_id || null
  };
}

export async function processContinuityQueueMessage({
  envelope,
  env,
  principal
}) {
  if (!envelope || typeof envelope !== "object") {
    throw new ContinuityError("invalid_continuity_queue_message", "Queue message is invalid");
  }

  if (envelope.type === "continuity.validate") {
    return validateCandidateCheckpoint({
      runwayId: envelope.runway_id,
      env,
      principal
    });
  }

  if (envelope.type === "continuity.publish") {
    return publishCheckpoint({
      runwayId: envelope.runway_id,
      body: {
        expected_generation: envelope.expected_generation,
        expected_predecessor_runway_id: envelope.expected_predecessor_runway_id
      },
      env,
      principal
    });
  }

  throw new ContinuityError(
    "unknown_continuity_queue_message",
    "Queue message type is not supported"
  );
}

export async function runScheduledContinuityVerification({ env, principal }) {
  requireContinuityDatabase(env);
  const heads = await env.DB.prepare(SQL.LIST_HEADS)
    .bind(principal.tenant_id)
    .all();
  const health = await env.DB.prepare(SQL.LIST_CONTINUITY_HEALTH)
    .bind(principal.tenant_id)
    .all();
  let verified = 0;
  let failed = 0;

  for (const head of heads.results || []) {
    const result = await verifyHeadTarget({
      db: env.DB,
      head,
      expectedTuple: head,
      now: new Date(),
      freshnessLimitSeconds: env.CONTINUITY_FRESHNESS_SECONDS
    });
    if (result.ok) verified += 1;
    else failed += 1;
  }

  await emitContinuityMetric(env, "continuity.scheduled.verification", {
    credential_id: principal.credential_id,
    status: failed === 0 ? "passed" : "failed",
    verified_heads: verified,
    failed_heads: failed,
    candidate_count: (health.results || []).filter(row => row.state === "candidate").length,
    publication_failed_count: (health.results || []).filter(
      row => row.state === "publication_failed"
    ).length
  });

  return { verified_heads: verified, failed_heads: failed };
}

export async function getContinuityHistory({
  env,
  principal,
  identityId,
  projectId,
  scopeKey
}) {
  requireContinuityDatabase(env);
  const identity = normalizeIdentityId(identityId);
  const project = normalizeProjectId(projectId);
  const scope = normalizeScopeKey(scopeKey);
  assertContinuityTarget(principal, {
    identityId: identity,
    projectId: project,
    operation: "audit"
  });
  const rows = await env.DB.prepare(SQL.LIST_HISTORY)
    .bind(principal.tenant_id, identity, project, scope)
    .all();

  return {
    identity_id: identity,
    project_id: project,
    scope_key: scope,
    runways: (rows.results || []).map(auditRunwayMetadata)
  };
}

export async function getCheckpointAudit({ env, principal, runwayId }) {
  const row = await requireAuditableRunway(env, principal, runwayId);
  const [records, validations, attempts, invalidations] = await Promise.all([
    env.DB.prepare(SQL.LIST_RUNWAY_RECORDS)
      .bind(principal.tenant_id, row.runway_id).all(),
    env.DB.prepare(SQL.LIST_VALIDATIONS)
      .bind(principal.tenant_id, row.runway_id).all(),
    env.DB.prepare(SQL.LIST_PUBLICATION_ATTEMPTS)
      .bind(principal.tenant_id, row.runway_id).all(),
    env.DB.prepare(SQL.LIST_INVALIDATIONS)
      .bind(principal.tenant_id, row.runway_id).all()
  ]);

  return {
    runway: auditRunwayMetadata(row),
    payload: parseStoredJson(row.payload_json, "payload_json"),
    records: records.results || [],
    validations: (validations.results || []).map(parseValidationAudit),
    publication_attempts: attempts.results || [],
    invalidations: invalidations.results || []
  };
}

export async function getValidationAudit({ env, principal, runwayId }) {
  const row = await requireAuditableRunway(env, principal, runwayId);
  const validations = await env.DB.prepare(SQL.LIST_VALIDATIONS)
    .bind(principal.tenant_id, row.runway_id)
    .all();

  return {
    runway_id: row.runway_id,
    validations: (validations.results || []).map(parseValidationAudit)
  };
}

export async function getRetrievalReceiptAudit({
  env,
  principal,
  receiptId
}) {
  requireContinuityDatabase(env);
  const normalizedReceiptId = normalizeNullableId(receiptId, "receipt_id", {
    required: true
  });
  const row = await env.DB.prepare(SQL.GET_RETRIEVAL_RECEIPT)
    .bind(principal.tenant_id, normalizedReceiptId)
    .first();

  if (!row) {
    throw new ContinuityError(
      "retrieval_receipt_not_found",
      "Retrieval receipt does not exist",
      404
    );
  }

  assertContinuityTarget(principal, {
    identityId: row.identity_id,
    projectId: row.project_id,
    operation: "audit"
  });

  return {
    ...row,
    fallback_path: parseStoredJson(row.fallback_path_json, "fallback_path_json"),
    requested_domains: parseStoredJson(
      row.requested_domains_json,
      "requested_domains_json"
    ),
    permitted_domains: parseStoredJson(
      row.permitted_domains_json,
      "permitted_domains_json"
    ),
    omissions: parseStoredJson(row.omissions_json, "omissions_json"),
    fallback_path_json: undefined,
    requested_domains_json: undefined,
    permitted_domains_json: undefined,
    omissions_json: undefined
  };
}

async function requireAuditableRunway(env, principal, runwayId) {
  requireContinuityDatabase(env);
  const normalizedRunwayId = normalizeNullableId(runwayId, "runway_id", {
    required: true
  });
  const row = await env.DB.prepare(SQL.GET_RUNWAY_FOR_TENANT)
    .bind(principal.tenant_id, normalizedRunwayId)
    .first();
  if (!row) {
    throw new ContinuityError("runway_not_found", "Checkpoint does not exist", 404);
  }
  assertContinuityTarget(principal, {
    identityId: row.identity_id,
    projectId: row.project_id,
    operation: "audit"
  });
  return row;
}

function auditRunwayMetadata(row) {
  return {
    runway_id: row.runway_id,
    schema_version: row.schema_version,
    identity_id: row.identity_id,
    project_id: row.project_id,
    scope_key: row.scope_key,
    predecessor_runway_id: row.predecessor_runway_id,
    source_invocation_id: row.source_invocation_id,
    generation: Number(row.generation),
    state: row.state,
    context_status: row.context_status,
    manifest_hash: row.manifest_hash,
    integrity_state: row.integrity_state,
    completeness_score: row.completeness_score,
    indexing_state: row.indexing_state,
    portable_artifact_ref: row.portable_artifact_ref || null,
    created_at: row.created_at,
    validated_at: row.validated_at || null,
    sealed_at: row.sealed_at || null,
    published_at: row.published_at || null,
    invalidated_at: row.invalidated_at || null,
    invalidation_reason: row.invalidation_reason || null
  };
}

function parseValidationAudit(row) {
  return {
    ...row,
    errors: parseStoredJson(row.errors_json, "errors_json"),
    warnings: parseStoredJson(row.warnings_json, "warnings_json"),
    errors_json: undefined,
    warnings_json: undefined
  };
}

function normalizeDomainList(value) {
  const allowed = new Set(["knowledge", "agents", "skills", "files", "library"]);
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => String(item).trim().toLowerCase())
    .filter(item => allowed.has(item)))];
}

function sanitizeContinuityTopK(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 5;
  return Math.min(parsed, 25);
}

async function emitContinuityMetric(env, metric, fields) {
  const point = {
    metric,
    timestamp: new Date().toISOString(),
    ...fields
  };

  if (
    env?.CONTINUITY_TELEMETRY &&
    typeof env.CONTINUITY_TELEMETRY.writeDataPoint === "function"
  ) {
    await env.CONTINUITY_TELEMETRY.writeDataPoint(point);
  }
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
     WHERE tenant_id = ? AND identity_id = ? AND project_id = ? AND scope_key = ?`,
  GET_RUNWAY_FOR_TENANT: `/* continuity:get-runway-for-tenant */
    SELECT * FROM context_runways WHERE tenant_id = ? AND runway_id = ?`,
  GET_IDEMPOTENT: `/* continuity:get-idempotent */
    SELECT * FROM context_runways
     WHERE tenant_id = ? AND created_by_credential_id = ? AND idempotency_key = ?`,
  INSERT_RUNWAY: `/* continuity:insert-runway */
    INSERT INTO context_runways (
      runway_id, tenant_id, schema_version, identity_id, project_id, scope_key,
      predecessor_runway_id, source_invocation_id, generation, state,
      context_status, objective, summary, payload_json, manifest_hash,
      source_hashes_json, integrity_state, completeness_score,
      created_by_credential_id, idempotency_key, portable_artifact_ref,
      indexing_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_VALIDATION: `/* continuity:insert-validation */
    INSERT INTO context_runway_validations (
      validation_id, tenant_id, runway_id, validator_credential_id, status,
      errors_json, warnings_json, completeness_score, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  SET_RUNWAY_VALIDATION_STATE: `/* continuity:set-runway-validation-state */
    UPDATE context_runways
       SET state = ?, integrity_state = ?, completeness_score = ?, validated_at = ?
     WHERE tenant_id = ? AND runway_id = ?`,
  GET_GENESIS: `/* continuity:get-genesis */
    SELECT * FROM context_runways
     WHERE tenant_id = ? AND identity_id = ? AND project_id = ? AND generation = 1
       AND state IN ('published', 'superseded')
     ORDER BY created_at DESC LIMIT 1`,
  GET_BACKFILLED: `/* continuity:get-backfilled */
    SELECT * FROM context_runways
     WHERE tenant_id = ? AND identity_id = ? AND project_id = ? AND scope_key = ?
       AND context_status = 'backfilled'
       AND state IN ('published', 'superseded')
     ORDER BY generation DESC LIMIT 1`,
  INSERT_RETRIEVAL_RECEIPT: `/* continuity:insert-retrieval-receipt */
    INSERT INTO context_retrieval_receipts (
      receipt_id, tenant_id, requesting_credential_id, identity_id, project_id, scope_key,
      selected_runway_id, selected_generation, context_status,
      fallback_path_json, requested_domains_json, permitted_domains_json,
      supplemental_search_used, supplemental_result_count, omissions_json,
      receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  GET_LATEST_VALIDATION: `/* continuity:get-latest-validation */
    SELECT * FROM context_runway_validations
     WHERE tenant_id = ? AND runway_id = ? ORDER BY created_at DESC LIMIT 1`,
  INSERT_PUBLICATION_ATTEMPT: `/* continuity:insert-publication-attempt */
    INSERT INTO context_publication_attempts (
      attempt_id, tenant_id, runway_id, expected_generation, observed_generation,
      status, error_code, error_message, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  UPDATE_PUBLICATION_ATTEMPT: `/* continuity:update-publication-attempt */
    UPDATE context_publication_attempts
       SET status = ?, error_code = ?, error_message = ?, completed_at = ?
     WHERE tenant_id = ? AND attempt_id = ?`,
  SEAL_RUNWAY: `/* continuity:seal-runway */
    UPDATE context_runways
       SET state = 'sealed', sealed_at = ?, indexing_state = ?
     WHERE tenant_id = ? AND runway_id = ? AND state = 'validated'`,
  SET_ARTIFACT_REF: `/* continuity:set-artifact-ref */
    UPDATE context_runways SET portable_artifact_ref = ?
     WHERE tenant_id = ? AND runway_id = ?`,
  SET_INDEXING_STATE: `/* continuity:set-indexing-state */
    UPDATE context_runways SET indexing_state = ?, state = ?
     WHERE tenant_id = ? AND runway_id = ?`,
  SET_PUBLICATION_FAILED: `/* continuity:set-publication-failed */
    UPDATE context_runways
       SET state = 'publication_failed', indexing_state = ?
     WHERE tenant_id = ? AND runway_id = ? AND state <> 'published'`,
  PUBLISH_HEAD_CAS: `/* continuity:publish-head-cas */
    INSERT INTO context_runway_heads (
      tenant_id, identity_id, project_id, scope_key, runway_id, generation,
      manifest_hash, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, identity_id, project_id, scope_key) DO UPDATE SET
      runway_id = excluded.runway_id,
      generation = excluded.generation,
      manifest_hash = excluded.manifest_hash,
      published_at = excluded.published_at
    WHERE context_runway_heads.generation = ?
      AND context_runway_heads.runway_id = ?
      AND context_runway_heads.tenant_id = excluded.tenant_id`,
  INVALIDATE_RUNWAY: `/* continuity:invalidate-runway */
    UPDATE context_runways
       SET state = 'invalidated', invalidated_at = ?, invalidation_reason = ?
     WHERE tenant_id = ? AND runway_id = ?`,
  INSERT_INVALIDATION: `/* continuity:insert-invalidation */
    INSERT INTO context_runway_invalidations (
      invalidation_id, tenant_id, runway_id, invalidated_by_credential_id, reason,
      previous_head_runway_id, restored_head_runway_id, created_at, receipt_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  LIST_RUNWAY_RECORDS: `/* continuity:list-runway-records */
    SELECT * FROM context_runway_records
     WHERE tenant_id = ? AND runway_id = ? ORDER BY ordinal ASC, record_id ASC`,
  UPDATE_RETRIEVAL_RECEIPT: `/* continuity:update-retrieval-receipt */
    UPDATE context_retrieval_receipts
       SET supplemental_search_used = ?, supplemental_result_count = ?,
           omissions_json = ?, requested_domains_json = ?,
           permitted_domains_json = ?, receipt_hash = ?
     WHERE tenant_id = ? AND receipt_id = ?`,
  LIST_HISTORY: `/* continuity:list-history */
    SELECT * FROM context_runways
     WHERE tenant_id = ? AND identity_id = ? AND project_id = ? AND scope_key = ?
     ORDER BY generation DESC, created_at DESC`,
  LIST_VALIDATIONS: `/* continuity:list-validations */
    SELECT * FROM context_runway_validations
     WHERE tenant_id = ? AND runway_id = ? ORDER BY created_at DESC`,
  LIST_PUBLICATION_ATTEMPTS: `/* continuity:list-publication-attempts */
    SELECT * FROM context_publication_attempts
     WHERE tenant_id = ? AND runway_id = ? ORDER BY created_at DESC`,
  LIST_INVALIDATIONS: `/* continuity:list-invalidations */
    SELECT * FROM context_runway_invalidations
     WHERE tenant_id = ? AND runway_id = ? ORDER BY created_at DESC`,
  GET_RETRIEVAL_RECEIPT: `/* continuity:get-retrieval-receipt */
    SELECT * FROM context_retrieval_receipts
     WHERE tenant_id = ? AND receipt_id = ?`,
  INSERT_INVOCATION: `/* continuity:insert-invocation */
    INSERT OR IGNORE INTO context_invocations (
      invocation_id, tenant_id, identity_id, project_id, scope_key, credential_id,
      resolved_runway_id, retrieval_receipt_id, state, continuity_outcome,
      started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  SET_INVOCATION_REHYDRATED: `/* continuity:set-invocation-rehydrated */
    UPDATE context_invocations
       SET resolved_runway_id = ?, retrieval_receipt_id = ?, state = 'rehydrated'
     WHERE tenant_id = ? AND invocation_id = ?`,
  GET_INVOCATION: `/* continuity:get-invocation */
    SELECT * FROM context_invocations
     WHERE tenant_id = ? AND invocation_id = ?`,
  COMPLETE_INVOCATION: `/* continuity:complete-invocation */
    UPDATE context_invocations
       SET state = ?, continuity_outcome = ?, completed_at = ?
     WHERE tenant_id = ? AND invocation_id = ? AND credential_id = ?`,
  LIST_HEADS: `/* continuity:list-heads */
    SELECT * FROM context_runway_heads
     WHERE tenant_id = ? ORDER BY identity_id, project_id, scope_key`,
  LIST_CONTINUITY_HEALTH: `/* continuity:list-continuity-health */
    SELECT runway_id, identity_id, project_id, scope_key, generation, state,
           integrity_state, indexing_state, created_at, published_at
      FROM context_runways
     WHERE tenant_id = ?
       AND state IN ('candidate', 'publication_failed', 'published')`
});
