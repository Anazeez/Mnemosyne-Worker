import {
  canonicalJson,
  sha256Hex
} from "../continuity.js";

export const HANDOFF_SCHEMA = "handoff.v1";

export const HANDOFF_LIMITS = Object.freeze({
  payload_bytes: 128 * 1024,
  list_items: 100,
  designated_files: 200,
  scalar_chars: 4_000,
  path_chars: 512,
  source_ref_chars: 2_048,
  ttl_seconds: 365 * 24 * 60 * 60
});

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const HANDOFF_ID_PATTERN = /^handoff_[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

const BOUNDARY_EVENTS = new Set([
  "stop",
  "credit_warning",
  "credit_termination",
  "task_complete",
  "phase_complete",
  "project_complete",
  "interruption",
  "failure",
  "context_compaction"
]);
const COMPACTION_LEVELS = new Set([
  "checkpoint",
  "handoff",
  "epoch",
  "project_snapshot"
]);
const PROGRESS_STATES = new Set([
  "in_progress",
  "blocked",
  "ready_for_handoff",
  "completed",
  "archived"
]);
const FILE_STATUSES = new Set([
  "verified",
  "changed",
  "pending",
  "unavailable"
]);
const CHANGE_OPERATIONS = new Set([
  "add",
  "modify",
  "delete",
  "rename",
  "configure"
]);
const VERIFICATION_STATUSES = new Set([
  "passed",
  "failed",
  "skipped",
  "unavailable"
]);
const RETENTION_CLASSES = new Set(["project", "phase", "transient"]);
const AGENT_FAMILIES = new Set(["codex", "claude", "gemini", "other"]);

const SECRET_KEY_PATTERN =
  /(?:^|_)(?:api_?key|access_?token|auth_?token|password|private_?key|cookie|secret)(?:$|_)/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:gh[opusr]|sk|pk)_[A-Za-z0-9_-]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/i
]);
const INSTRUCTION_PATTERNS = Object.freeze([
  /ignore (?:all |any )?(?:previous|prior) instructions/i,
  /reveal (?:the )?(?:system|developer) prompt/i,
  /bypass (?:authorization|capability|policy)/i
]);

export class HandoffError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeHandoffEnvelope(input) {
  if (!isRecord(input)) {
    throw handoffError("INVALID_PAYLOAD", "Handoff envelope must be an object");
  }

  if (containsSecret(input)) {
    throw handoffError(
      "PROHIBITED_SECRET_CONTENT",
      "Handoff content contains prohibited secret-like material"
    );
  }

  if (containsUntrustedInstruction(input)) {
    throw handoffError(
      "UNTRUSTED_INSTRUCTION_CONTENT",
      "Handoff content contains instruction-like material"
    );
  }

  if (input.schema_version !== HANDOFF_SCHEMA) {
    throw handoffError(
      "INVALID_SCHEMA_VERSION",
      `schema_version must equal ${HANDOFF_SCHEMA}`
    );
  }

  const scope = normalizeScope(input.scope);
  const handoffId = normalizeHandoffId(input.handoff_id);
  const boundary = normalizeBoundary(input.boundary);
  const progress = normalizeProgress(input.progress);
  const project = normalizeProject(input.project);
  const sourceOfTruth = normalizeSourceOfTruth(input.source_of_truth);
  const decisions = normalizeDecisions(input.decisions);
  const changes = normalizeChanges(input.changes);
  const verification = normalizeVerification(input.verification);
  const blockers = normalizeStringList(input.blockers, "blockers");
  const rejectedHypotheses = normalizeStringList(
    input.rejected_hypotheses,
    "rejected_hypotheses"
  );
  const nextAction = normalizeString(input.next_action, "next_action");
  const doNotRepeat = normalizeStringList(input.do_not_repeat, "do_not_repeat");
  const authority = normalizeAuthority(input.authority);
  const provenance = normalizeProvenance(input.provenance);
  const memory = normalizeMemory(input.memory, boundary.occurred_at);

  const normalized = {
    schema_version: HANDOFF_SCHEMA,
    handoff_id: handoffId,
    scope,
    boundary,
    progress,
    project,
    source_of_truth: sourceOfTruth,
    decisions,
    changes,
    verification,
    blockers,
    rejected_hypotheses: rejectedHypotheses,
    next_action: nextAction,
    do_not_repeat: doNotRepeat,
    authority,
    provenance,
    memory
  };

  const payloadBytes = new TextEncoder().encode(canonicalJson(normalized)).byteLength;
  if (payloadBytes > HANDOFF_LIMITS.payload_bytes) {
    throw handoffError(
      "PAYLOAD_TOO_LARGE",
      "Handoff payload exceeds 128 KiB"
    );
  }

  return normalized;
}

export async function handoffPayloadHash(envelope) {
  const normalized = normalizeHandoffEnvelope(envelope);
  const hashable = structuredClone(normalized);
  hashable.provenance.content_hash = null;
  return sha256Hex(canonicalJson(hashable));
}

function normalizeScope(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_SCOPE", "scope must be an object");
  }

  return {
    tenant_id: normalizePatternId(
      value.tenant_id,
      "tenant_id",
      TENANT_ID_PATTERN,
      "INVALID_TENANT_ID"
    ),
    project_id: normalizePatternId(
      value.project_id,
      "project_id",
      PROJECT_ID_PATTERN,
      "INVALID_PROJECT_ID"
    )
  };
}

function normalizeBoundary(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_BOUNDARY", "boundary must be an object");
  }

  const event = normalizeString(value.event, "boundary.event");
  if (!BOUNDARY_EVENTS.has(event)) {
    throw handoffError("INVALID_BOUNDARY", "boundary.event is not supported");
  }

  const compactionLevel = normalizeString(
    value.compaction_level,
    "boundary.compaction_level"
  );
  if (!COMPACTION_LEVELS.has(compactionLevel)) {
    throw handoffError(
      "INVALID_COMPACTION_LEVEL",
      "boundary.compaction_level is not supported"
    );
  }

  return {
    event,
    occurred_at: normalizeTimestamp(value.occurred_at, "boundary.occurred_at"),
    parent_handoff_id: optionalHandoffId(value.parent_handoff_id),
    supersedes: normalizeIdList(value.supersedes, "boundary.supersedes"),
    epoch_id: optionalHandoffId(value.epoch_id),
    compaction_level: compactionLevel
  };
}

function normalizeProgress(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_PROGRESS", "progress must be an object");
  }

  const state = normalizeString(value.state, "progress.state");
  if (!PROGRESS_STATES.has(state)) {
    throw handoffError("INVALID_PROGRESS", "progress.state is not supported");
  }

  return {
    state,
    checkpoint: normalizeString(value.checkpoint, "progress.checkpoint"),
    completed: normalizeStringList(value.completed, "progress.completed"),
    remaining: normalizeStringList(value.remaining, "progress.remaining")
  };
}

function normalizeProject(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_PROJECT", "project must be an object");
  }

  return {
    objective: normalizeString(value.objective, "project.objective"),
    success_criteria: normalizeStringList(
      value.success_criteria,
      "project.success_criteria",
      { required: true }
    )
  };
}

function normalizeSourceOfTruth(value) {
  if (!isRecord(value)) {
    throw handoffError(
      "INVALID_SOURCE_OF_TRUTH",
      "source_of_truth must be an object"
    );
  }

  if (!Array.isArray(value.designated_files) || value.designated_files.length > HANDOFF_LIMITS.designated_files) {
    throw handoffError(
      "INVALID_DESIGNATED_FILES",
      "source_of_truth.designated_files must be a bounded array"
    );
  }

  return {
    repository: normalizeString(value.repository, "source_of_truth.repository"),
    revision: normalizeString(value.revision, "source_of_truth.revision"),
    worktree: optionalString(value.worktree, "source_of_truth.worktree"),
    designated_files: value.designated_files.map(normalizeDesignatedFile)
  };
}

function normalizeDesignatedFile(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_DESIGNATED_FILE", "designated file must be an object");
  }

  const path = normalizePath(value.path, "designated_file.path");
  return {
    path,
    purpose: normalizeString(value.purpose, "designated_file.purpose"),
    status: normalizeEnum(value.status, FILE_STATUSES, "designated_file.status"),
    last_verified: normalizeTimestamp(
      value.last_verified,
      "designated_file.last_verified"
    )
  };
}

function normalizeDecisions(value) {
  return normalizeObjectList(value, "decisions", value => ({
    statement: normalizeString(value.statement, "decision.statement"),
    source_ref: normalizeString(value.source_ref, "decision.source_ref", HANDOFF_LIMITS.source_ref_chars),
    observed_at: normalizeTimestamp(value.observed_at, "decision.observed_at")
  }));
}

function normalizeChanges(value) {
  return normalizeObjectList(value, "changes", value => {
    const diffRef = optionalString(value.diff_ref, "change.diff_ref");
    const diffHash = optionalHash(value.diff_hash, "change.diff_hash");
    const astPatch = value.ast_patch === undefined
      ? null
      : normalizeAstPatch(value.ast_patch);
    if (!diffRef && !astPatch) {
      throw handoffError(
        "INVALID_CHANGE",
        "change requires diff_ref or structured ast_patch"
      );
    }

    return {
      path: normalizePath(value.path, "change.path"),
      operation: normalizeEnum(value.operation, CHANGE_OPERATIONS, "change.operation"),
      ...(value.symbol === undefined
        ? {}
        : { symbol: normalizeString(value.symbol, "change.symbol") }),
      summary: normalizeString(value.summary, "change.summary"),
      ...(diffRef ? { diff_ref: diffRef } : {}),
      ...(diffHash ? { diff_hash: diffHash } : {}),
      ...(astPatch ? { ast_patch: astPatch } : {}),
      verification_refs: normalizeStringList(
        value.verification_refs,
        "change.verification_refs"
      )
    };
  });
}

function normalizeAstPatch(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_CHANGE", "ast_patch must be an object");
  }

  const operation = normalizeString(value.operation, "ast_patch.operation");
  const target = normalizeString(value.target, "ast_patch.target");
  const before = value.before === undefined ? null : normalizeString(value.before, "ast_patch.before");
  const after = value.after === undefined ? null : normalizeString(value.after, "ast_patch.after");
  if (before === null && after === null) {
    throw handoffError("INVALID_CHANGE", "ast_patch must contain before or after");
  }
  return { operation, target, before, after };
}

function normalizeVerification(value) {
  return normalizeObjectList(value, "verification", value => {
    const command = optionalString(value.command, "verification.command");
    const reproductionStep = optionalString(
      value.reproduction_step,
      "verification.reproduction_step"
    );
    if (!command && !reproductionStep) {
      throw handoffError(
        "INVALID_VERIFICATION",
        "verification requires command or reproduction_step"
      );
    }

    return {
      name: normalizeString(value.name, "verification.name"),
      status: normalizeEnum(value.status, VERIFICATION_STATUSES, "verification.status"),
      command,
      reproduction_step: reproductionStep,
      expected: value.expected === null || value.expected === undefined
        ? null
        : normalizeString(value.expected, "verification.expected"),
      evidence: normalizeString(value.evidence, "verification.evidence")
    };
  }, { required: true });
}

function normalizeAuthority(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_AUTHORITY", "authority must be an object");
  }
  return {
    allowed_effects: normalizeStringList(value.allowed_effects, "authority.allowed_effects"),
    denied_effects: normalizeStringList(value.denied_effects, "authority.denied_effects")
  };
}

function normalizeProvenance(value) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_PROVENANCE", "provenance must be an object");
  }

  return {
    agent_family: normalizeEnum(value.agent_family, AGENT_FAMILIES, "provenance.agent_family"),
    agent_id: normalizeString(value.agent_id, "provenance.agent_id"),
    session_id: normalizeString(value.session_id, "provenance.session_id"),
    observed_at: normalizeTimestamp(value.observed_at, "provenance.observed_at"),
    source_refs: normalizeStringList(value.source_refs, "provenance.source_refs", { required: true }),
    content_hash: optionalHash(value.content_hash, "provenance.content_hash")
  };
}

function normalizeMemory(value, occurredAt) {
  if (!isRecord(value)) {
    throw handoffError("INVALID_MEMORY", "memory must be an object");
  }

  const retentionClass = normalizeEnum(
    value.retention_class,
    RETENTION_CLASSES,
    "memory.retention_class"
  );
  const ttlSeconds = value.ttl_seconds === null || value.ttl_seconds === undefined
    ? null
    : normalizePositiveInteger(value.ttl_seconds, "memory.ttl_seconds", HANDOFF_LIMITS.ttl_seconds);
  const expiresAt = value.expires_at === null || value.expires_at === undefined
    ? (ttlSeconds === null
      ? null
      : new Date(Date.parse(occurredAt) + ttlSeconds * 1000).toISOString())
    : normalizeTimestamp(value.expires_at, "memory.expires_at");

  if (retentionClass === "transient" && !ttlSeconds && !expiresAt) {
    throw handoffError(
      "INVALID_RETENTION",
      "transient handoffs require ttl_seconds or expires_at"
    );
  }

  const acceptedGeneration = value.accepted_generation === null || value.accepted_generation === undefined
    ? null
    : normalizePositiveInteger(value.accepted_generation, "memory.accepted_generation");

  return {
    accepted_generation: acceptedGeneration,
    idempotency_key: normalizePatternId(
      value.idempotency_key,
      "memory.idempotency_key",
      IDEMPOTENCY_PATTERN,
      "INVALID_IDEMPOTENCY_KEY"
    ),
    retention_class: retentionClass,
    ttl_seconds: ttlSeconds,
    expires_at: expiresAt,
    sensitivity: normalizeExactString(value.sensitivity, "memory.sensitivity", "non-secret")
  };
}

function normalizeObjectList(value, field, normalizeItem, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.list_items || (required && value.length < 1)) {
    throw handoffError("INVALID_" + field.toUpperCase(), `${field} must be a bounded array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw handoffError(
        "INVALID_" + field.toUpperCase(),
        `${field}[${index}] must be an object`
      );
    }
    return normalizeItem(item);
  });
}

function normalizeStringList(value, field, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.list_items || (required && value.length < 1)) {
    throw handoffError("INVALID_" + field.toUpperCase(), `${field} must be a bounded array`);
  }
  return value.map(item => normalizeString(item, field));
}

function normalizeIdList(value, field, required = false) {
  if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.list_items || (required && value.length < 1)) {
    throw handoffError("INVALID_IDS", `${field} must be a bounded array`);
  }
  const ids = value.map(item => normalizeHandoffId(item));
  if (new Set(ids).size !== ids.length) {
    throw handoffError("INVALID_IDS", `${field} must not contain duplicates`);
  }
  return ids;
}

function normalizePatternId(value, field, pattern, code) {
  const normalized = String(value ?? "").trim();
  if (!pattern.test(normalized)) {
    throw handoffError(code, `${field} has an invalid bounded identifier format`);
  }
  return normalized.toLowerCase();
}

function normalizeHandoffId(value) {
  const normalized = String(value ?? "").trim();
  if (!HANDOFF_ID_PATTERN.test(normalized)) {
    throw handoffError("INVALID_HANDOFF_ID", "handoff_id has an invalid format");
  }
  return normalized;
}

function optionalHandoffId(value) {
  return value === null || value === undefined ? null : normalizeHandoffId(value);
}

function normalizeEnum(value, allowed, field) {
  const normalized = normalizeString(value, field);
  if (!allowed.has(normalized)) {
    throw handoffError("INVALID_ENUM", `${field} is not supported`);
  }
  return normalized;
}

function normalizeExactString(value, field, expected) {
  const normalized = normalizeString(value, field);
  if (normalized !== expected) {
    throw handoffError("INVALID_VALUE", `${field} must equal ${expected}`);
  }
  return normalized;
}

function normalizeString(value, field, maximum = HANDOFF_LIMITS.scalar_chars) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw handoffError("INVALID_STRING", `${field} must be a bounded non-empty string`);
  }
  return normalized;
}

function optionalString(value, field) {
  return value === null || value === undefined
    ? null
    : normalizeString(value, field);
}

function normalizePath(value, field) {
  const path = normalizeString(value, field, HANDOFF_LIMITS.path_chars);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw handoffError("INVALID_PATH", `${field} must be project-relative`);
  }
  return path;
}

function normalizeTimestamp(value, field) {
  const timestamp = normalizeString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw handoffError("INVALID_TIMESTAMP", `${field} must be an ISO-8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function normalizePositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw handoffError("INVALID_INTEGER", `${field} must be a bounded non-negative integer`);
  }
  return number;
}

function optionalHash(value, field) {
  if (value === null || value === undefined) return null;
  const hash = String(value).trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw handoffError("INVALID_HASH", `${field} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function containsSecret(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value));
  }
  if (Array.isArray(value)) return value.some(item => containsSecret(item));
  if (isRecord(value)) {
    return Object.entries(value).some(([childKey, child]) => containsSecret(child, childKey));
  }
  return false;
}

function containsUntrustedInstruction(value) {
  if (typeof value === "string") {
    return INSTRUCTION_PATTERNS.some(pattern => pattern.test(value));
  }
  if (Array.isArray(value)) return value.some(containsUntrustedInstruction);
  if (isRecord(value)) return Object.values(value).some(containsUntrustedInstruction);
  return false;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function handoffError(code, message, status = 400, details = undefined) {
  return new HandoffError(code, message, status, details);
}
