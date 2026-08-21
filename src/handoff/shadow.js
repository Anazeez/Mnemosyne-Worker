import {
  HandoffError,
  handoffPayloadHash,
  normalizeHandoffEnvelope
} from "./contracts.js";
import { canonicalJson, sha256Hex } from "../continuity.js";

export const SHADOW_DELTA_SCHEMA = "shadow_delta.v1";

export const SHADOW_DELTA_LIMITS = Object.freeze({
  payload_bytes: 64 * 1024,
  max_entries: 256,
  list_items: 100,
  designated_files: 200,
  scalar_chars: 4_000,
  path_chars: 512
});

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CHANGE_OPERATIONS = new Set([
  "add",
  "modify",
  "delete",
  "rename",
  "configure"
]);
const FILE_STATUSES = new Set([
  "verified",
  "changed",
  "pending",
  "unavailable"
]);
const PROGRESS_STATES = new Set([
  "in_progress",
  "blocked",
  "ready_for_handoff",
  "completed",
  "archived"
]);
const VERIFICATION_STATUSES = new Set([
  "passed",
  "failed",
  "skipped",
  "unavailable"
]);
const CHECKPOINT_STATES = new Set(["partial", "complete"]);
const BOUNDARY_EVENTS = new Set([
  "stop",
  "credit_warning",
  "credit_termination",
  "interruption",
  "failure"
]);

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

export function normalizeShadowDelta(input) {
  if (!isRecord(input)) {
    throw shadowError("INVALID_SHADOW_DELTA", "Shadow delta must be an object");
  }
  if (containsSecret(input)) {
    throw shadowError(
      "PROHIBITED_SECRET_CONTENT",
      "Shadow delta contains prohibited secret-like material"
    );
  }
  if (containsUntrustedInstruction(input)) {
    throw shadowError(
      "UNTRUSTED_INSTRUCTION_CONTENT",
      "Shadow delta contains instruction-like material"
    );
  }
  if (input.schema_version !== SHADOW_DELTA_SCHEMA) {
    throw shadowError(
      "INVALID_SCHEMA_VERSION",
      `schema_version must equal ${SHADOW_DELTA_SCHEMA}`
    );
  }

  const normalized = {
    schema_version: SHADOW_DELTA_SCHEMA,
    scope: normalizeScope(input.scope),
    sequence: normalizeInteger(input.sequence, "sequence"),
    parent_revision: normalizeString(input.parent_revision, "parent_revision"),
    changed_fields: normalizeChangedFields(input.changed_fields),
    changes: normalizeChanges(input.changes),
    designated_files: normalizeDesignatedFiles(input.designated_files),
    verification: normalizeVerification(input.verification),
    progress: normalizeProgress(input.progress),
    blockers: normalizeStringList(input.blockers, "blockers"),
    rejected_hypotheses: normalizeStringList(
      input.rejected_hypotheses,
      "rejected_hypotheses"
    ),
    next_action: optionalString(input.next_action, "next_action"),
    do_not_repeat: normalizeStringList(input.do_not_repeat, "do_not_repeat"),
    checkpoint_state: normalizeEnum(
      input.checkpoint_state,
      CHECKPOINT_STATES,
      "checkpoint_state"
    ),
    boundary_event: input.boundary_event === undefined
      ? "interruption"
      : normalizeEnum(input.boundary_event, BOUNDARY_EVENTS, "boundary_event"),
    previous_delta_hash: input.previous_delta_hash === null || input.previous_delta_hash === undefined
      ? null
      : normalizeHash(input.previous_delta_hash, "previous_delta_hash"),
    recorded_at: normalizeTimestamp(input.recorded_at, "recorded_at")
  };

  if (input.delta_hash !== undefined) {
    normalized.delta_hash = normalizeHash(input.delta_hash, "delta_hash");
  }

  const payloadBytes = new TextEncoder().encode(canonicalJson(normalized)).byteLength;
  if (payloadBytes > SHADOW_DELTA_LIMITS.payload_bytes) {
    throw shadowError(
      "PAYLOAD_TOO_LARGE",
      "Shadow delta exceeds 64 KiB"
    );
  }
  return normalized;
}

export async function shadowDeltaHash(delta) {
  const normalized = normalizeShadowDelta(delta);
  delete normalized.delta_hash;
  return sha256Hex(canonicalJson(normalized));
}

export async function verifyShadowLog({ shadowLog = [] }) {
  if (!Array.isArray(shadowLog) || shadowLog.length > SHADOW_DELTA_LIMITS.max_entries) {
    throw shadowError(
      "INVALID_SHADOW_LOG",
      "Shadow log must be a bounded array"
    );
  }

  const verified = [];
  let previous = null;
  for (const entry of shadowLog) {
    const normalized = normalizeShadowDelta(entry);
    if (normalized.sequence !== (previous ? previous.sequence + 1 : 1)) {
      throw shadowError(
        "SHADOW_SEQUENCE_GAP",
        "Shadow delta sequence must be contiguous"
      );
    }
    if (
      previous &&
      (normalized.scope.tenant_id !== previous.scope.tenant_id ||
        normalized.scope.project_id !== previous.scope.project_id)
    ) {
      throw shadowError(
        "SHADOW_SCOPE_MISMATCH",
        "Shadow deltas must remain in one tenant/project scope"
      );
    }
    if (normalized.previous_delta_hash !== (previous?.delta_hash || null)) {
      throw shadowError(
        "SHADOW_CHAIN_BREAK",
        "Shadow delta does not link to the previous checkpoint"
      );
    }
    if (!normalized.delta_hash) {
      throw shadowError(
        "SHADOW_HASH_REQUIRED",
        "Persisted shadow deltas require their derived hash"
      );
    }
    const expectedHash = await shadowDeltaHash(normalized);
    if (normalized.delta_hash !== expectedHash) {
      throw shadowError(
        "SHADOW_HASH_MISMATCH",
        "Shadow delta hash does not match its content"
      );
    }
    verified.push(normalized);
    previous = normalized;
  }
  return verified;
}

export async function appendShadowDelta({ shadowLog = [], delta }) {
  if (!Array.isArray(shadowLog) || shadowLog.length > SHADOW_DELTA_LIMITS.max_entries) {
    throw shadowError(
      "INVALID_SHADOW_LOG",
      "Shadow log must be a bounded array"
    );
  }
  if (shadowLog.length >= SHADOW_DELTA_LIMITS.max_entries) {
    throw shadowError(
      "SHADOW_LOG_FULL",
      "Shadow log reached its bounded checkpoint limit"
    );
  }
  const previous = shadowLog.at(-1)
    ? normalizeShadowDelta(shadowLog.at(-1))
    : null;
  if (previous) {
    if (!previous.delta_hash) {
      throw shadowError(
        "SHADOW_HASH_REQUIRED",
        "The latest persisted shadow delta requires its derived hash"
      );
    }
    const expectedPreviousHash = await shadowDeltaHash(previous);
    if (previous.delta_hash !== expectedPreviousHash) {
      throw shadowError(
        "SHADOW_HASH_MISMATCH",
        "The latest persisted shadow delta hash does not match its content"
      );
    }
  }
  const normalized = normalizeShadowDelta(delta);
  if (normalized.sequence !== (previous?.sequence || 0) + 1) {
    throw shadowError(
      "SHADOW_SEQUENCE_GAP",
      "New shadow delta must continue the existing sequence"
    );
  }
  if (normalized.scope.tenant_id !== (previous?.scope.tenant_id || normalized.scope.tenant_id) ||
      normalized.scope.project_id !== (previous?.scope.project_id || normalized.scope.project_id)) {
    throw shadowError(
      "SHADOW_SCOPE_MISMATCH",
      "Shadow delta must remain in one tenant/project scope"
    );
  }
  if (normalized.previous_delta_hash !== (previous?.delta_hash || null)) {
    throw shadowError(
      "SHADOW_CHAIN_BREAK",
      "New shadow delta does not link to the latest checkpoint"
    );
  }
  const deltaHash = await shadowDeltaHash(normalized);
  if (normalized.delta_hash && normalized.delta_hash !== deltaHash) {
    throw shadowError(
      "SHADOW_HASH_MISMATCH",
      "Provided shadow delta hash does not match its content"
    );
  }
  const appended = { ...normalized, delta_hash: deltaHash };
  return {
    shadow_log: [...shadowLog, appended],
    latest: appended,
    delta_hash: deltaHash
  };
}

export async function recoverHandoffDraft({
  shadowLog = [],
  baseEnvelope,
  now = () => new Date()
}) {
  const verified = await verifyShadowLog({ shadowLog });
  const checkpoint = [...verified]
    .reverse()
    .find(entry => entry.checkpoint_state === "complete");
  if (!checkpoint) {
    throw shadowError(
      "SHADOW_CHECKPOINT_UNAVAILABLE",
      "No complete shadow checkpoint is available for recovery"
    );
  }

  const base = normalizeHandoffEnvelope(baseEnvelope);
  if (
    base.scope.tenant_id !== checkpoint.scope.tenant_id ||
    base.scope.project_id !== checkpoint.scope.project_id
  ) {
    throw shadowError(
      "SHADOW_SCOPE_MISMATCH",
      "Base envelope and shadow checkpoint must share a scope"
    );
  }

  const recoveredHandoffId = `handoff_shadow_${checkpoint.delta_hash.slice(0, 32)}`;
  const recoveredIdempotencyKey = `shadow-recovery-${checkpoint.delta_hash.slice(0, 32)}`;
  const recoveryTime = normalizeTimestamp(
    now instanceof Function ? now() : now,
    "recovery_time"
  );
  const epochId = ["epoch", "project_snapshot"].includes(base.boundary.compaction_level)
    ? base.handoff_id
    : base.boundary.epoch_id;
  const recovered = structuredClone(base);
  recovered.handoff_id = recoveredHandoffId;
  recovered.boundary = {
    ...recovered.boundary,
    event: checkpoint.boundary_event,
    occurred_at: checkpoint.recorded_at,
    parent_handoff_id: base.handoff_id,
    supersedes: [],
    epoch_id: epochId,
    compaction_level: "handoff"
  };
  recovered.progress = checkpoint.progress;
  recovered.source_of_truth = {
    ...recovered.source_of_truth,
    revision: checkpoint.parent_revision,
    designated_files: checkpoint.designated_files.length > 0
      ? checkpoint.designated_files
      : recovered.source_of_truth.designated_files
  };
  recovered.changes = mergeByKey(recovered.changes, checkpoint.changes, changeKey);
  recovered.verification = checkpoint.verification.length > 0
    ? checkpoint.verification
    : recovered.verification;
  recovered.blockers = checkpoint.blockers;
  recovered.rejected_hypotheses = checkpoint.rejected_hypotheses;
  if (checkpoint.next_action) recovered.next_action = checkpoint.next_action;
  recovered.do_not_repeat = mergeStrings(
    recovered.do_not_repeat,
    checkpoint.do_not_repeat
  );
  recovered.provenance = {
    ...recovered.provenance,
    observed_at: recoveryTime,
    content_hash: null
  };
  recovered.memory = {
    ...recovered.memory,
    idempotency_key: recoveredIdempotencyKey
  };

  const envelope = normalizeHandoffEnvelope(recovered);
  return {
    envelope,
    payload_hash: await handoffPayloadHash(envelope),
    recovery: {
      source_sequence: checkpoint.sequence,
      source_delta_hash: checkpoint.delta_hash,
      recovered_at: recoveryTime,
      accepted: false,
      confirmation_required: true
    }
  };
}

function normalizeScope(value) {
  if (!isRecord(value)) {
    throw shadowError("INVALID_SCOPE", "scope must be an object");
  }
  return {
    tenant_id: normalizePatternId(
      value.tenant_id,
      "scope.tenant_id",
      TENANT_ID_PATTERN,
      "INVALID_TENANT_ID"
    ),
    project_id: normalizePatternId(
      value.project_id,
      "scope.project_id",
      PROJECT_ID_PATTERN,
      "INVALID_PROJECT_ID"
    )
  };
}

function normalizeChangedFields(value) {
  if (!Array.isArray(value) || value.length > SHADOW_DELTA_LIMITS.list_items) {
    throw shadowError("INVALID_CHANGED_FIELDS", "changed_fields must be a bounded array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw shadowError("INVALID_CHANGED_FIELDS", `changed_fields[${index}] must be an object`);
    }
    return {
      field: normalizeString(item.field, `changed_fields[${index}].field`),
      summary: normalizeString(item.summary, `changed_fields[${index}].summary`),
      ...(item.value_hash === undefined
        ? {}
        : { value_hash: normalizeHash(item.value_hash, `changed_fields[${index}].value_hash`) })
    };
  });
}

function normalizeChanges(value) {
  if (!Array.isArray(value) || value.length > SHADOW_DELTA_LIMITS.list_items) {
    throw shadowError("INVALID_CHANGES", "changes must be a bounded array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw shadowError("INVALID_CHANGES", `changes[${index}] must be an object`);
    }
    const diffRef = optionalString(item.diff_ref, `changes[${index}].diff_ref`);
    const diffHash = item.diff_hash === undefined
      ? null
      : normalizeHash(item.diff_hash, `changes[${index}].diff_hash`);
    const astPatch = item.ast_patch === undefined
      ? null
      : normalizeAstPatch(item.ast_patch, index);
    if (!diffRef && !astPatch) {
      throw shadowError(
        "INVALID_CHANGE",
        `changes[${index}] requires diff_ref or ast_patch`
      );
    }
    return {
      path: normalizePath(item.path, `changes[${index}].path`),
      operation: normalizeEnum(item.operation, CHANGE_OPERATIONS, `changes[${index}].operation`),
      ...(item.symbol === undefined
        ? {}
        : { symbol: normalizeString(item.symbol, `changes[${index}].symbol`) }),
      summary: normalizeString(item.summary, `changes[${index}].summary`),
      ...(diffRef ? { diff_ref: diffRef } : {}),
      ...(diffHash ? { diff_hash: diffHash } : {}),
      ...(astPatch ? { ast_patch: astPatch } : {}),
      verification_refs: normalizeStringList(
        item.verification_refs,
        `changes[${index}].verification_refs`
      )
    };
  });
}

function normalizeAstPatch(value, index) {
  if (!isRecord(value)) {
    throw shadowError("INVALID_CHANGE", `changes[${index}].ast_patch must be an object`);
  }
  const before = value.before === undefined || value.before === null
    ? null
    : normalizeString(value.before, `changes[${index}].ast_patch.before`);
  const after = value.after === undefined || value.after === null
    ? null
    : normalizeString(value.after, `changes[${index}].ast_patch.after`);
  if (before === null && after === null) {
    throw shadowError(
      "INVALID_CHANGE",
      `changes[${index}].ast_patch requires before or after`
    );
  }
  return {
    operation: normalizeString(value.operation, `changes[${index}].ast_patch.operation`),
    target: normalizeString(value.target, `changes[${index}].ast_patch.target`),
    before,
    after
  };
}

function normalizeDesignatedFiles(value) {
  if (!Array.isArray(value) || value.length > SHADOW_DELTA_LIMITS.designated_files) {
    throw shadowError(
      "INVALID_DESIGNATED_FILES",
      "designated_files must be a bounded array"
    );
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw shadowError(
        "INVALID_DESIGNATED_FILE",
        `designated_files[${index}] must be an object`
      );
    }
    return {
      path: normalizePath(item.path, `designated_files[${index}].path`),
      purpose: normalizeString(item.purpose, `designated_files[${index}].purpose`),
      status: normalizeEnum(item.status, FILE_STATUSES, `designated_files[${index}].status`),
      last_verified: normalizeTimestamp(
        item.last_verified,
        `designated_files[${index}].last_verified`
      )
    };
  });
}

function normalizeVerification(value) {
  if (!Array.isArray(value) || value.length > SHADOW_DELTA_LIMITS.list_items) {
    throw shadowError("INVALID_VERIFICATION", "verification must be a bounded array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw shadowError("INVALID_VERIFICATION", `verification[${index}] must be an object`);
    }
    const command = optionalString(item.command, `verification[${index}].command`);
    const reproductionStep = optionalString(
      item.reproduction_step,
      `verification[${index}].reproduction_step`
    );
    if (!command && !reproductionStep) {
      throw shadowError(
        "INVALID_VERIFICATION",
        `verification[${index}] requires command or reproduction_step`
      );
    }
    return {
      name: normalizeString(item.name, `verification[${index}].name`),
      status: normalizeEnum(item.status, VERIFICATION_STATUSES, `verification[${index}].status`),
      command,
      reproduction_step: reproductionStep,
      expected: item.expected === undefined || item.expected === null
        ? null
        : normalizeString(item.expected, `verification[${index}].expected`),
      evidence: normalizeString(item.evidence, `verification[${index}].evidence`)
    };
  });
}

function normalizeProgress(value) {
  if (!isRecord(value)) {
    throw shadowError("INVALID_PROGRESS", "progress must be an object");
  }
  return {
    state: normalizeEnum(value.state, PROGRESS_STATES, "progress.state"),
    checkpoint: normalizeString(value.checkpoint, "progress.checkpoint"),
    completed: normalizeStringList(value.completed, "progress.completed"),
    remaining: normalizeStringList(value.remaining, "progress.remaining")
  };
}

function normalizeStringList(value, field) {
  if (!Array.isArray(value) || value.length > SHADOW_DELTA_LIMITS.list_items) {
    throw shadowError("INVALID_LIST", `${field} must be a bounded array`);
  }
  return value.map(item => normalizeString(item, field));
}

function normalizePatternId(value, field, pattern, code) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!pattern.test(normalized)) {
    throw shadowError(code, `${field} has an invalid bounded identifier format`);
  }
  return normalized;
}

function normalizeEnum(value, allowed, field) {
  const normalized = normalizeString(value, field);
  if (!allowed.has(normalized)) {
    throw shadowError("INVALID_ENUM", `${field} is not supported`);
  }
  return normalized;
}

function normalizeString(value, field, maximum = SHADOW_DELTA_LIMITS.scalar_chars) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw shadowError("INVALID_STRING", `${field} must be a bounded non-empty string`);
  }
  return normalized;
}

function optionalString(value, field) {
  return value === undefined || value === null
    ? null
    : normalizeString(value, field);
}

function normalizePath(value, field) {
  const path = normalizeString(value, field, SHADOW_DELTA_LIMITS.path_chars);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw shadowError("INVALID_PATH", `${field} must be project-relative`);
  }
  return path;
}

function normalizeTimestamp(value, field) {
  const timestamp = normalizeString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw shadowError("INVALID_TIMESTAMP", `${field} must be an ISO-8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw shadowError("INVALID_INTEGER", `${field} must be a positive safe integer`);
  }
  return number;
}

function normalizeHash(value, field) {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw shadowError("INVALID_HASH", `${field} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function mergeByKey(left, right, key) {
  const merged = new Map();
  for (const item of [...left, ...right]) merged.set(key(item), item);
  return [...merged.values()];
}

function mergeStrings(left, right) {
  return [...new Set([...left, ...right])];
}

function changeKey(change) {
  return [change.path, change.operation, change.symbol || "", change.summary].join("|");
}

function containsSecret(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  if (typeof value === "string") {
    if (SECRET_KEY_PATTERN.test(value)) return true;
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

function shadowError(code, message, status = 400, details = undefined) {
  return new HandoffError(code, message, status, details);
}
