export function handoffEnvelope(handoffId, {
  tenantId = "tenant-a",
  projectId = "project.a",
  parentHandoffId = null,
  supersedes = [],
  epochId = null,
  event = "task_complete",
  compactionLevel = "handoff",
  generation = 0,
  progressState = "ready_for_handoff",
  revision = "79a0dec8b2f86f448455dc0f56485f84caf9fd4e",
  remaining = ["Continue the next bounded action"]
} = {}) {
  return {
    schema_version: "handoff.v1",
    handoff_id: handoffId,
    scope: { tenant_id: tenantId, project_id: projectId },
    boundary: {
      event,
      occurred_at: "2026-08-08T00:00:00.000Z",
      parent_handoff_id: parentHandoffId,
      supersedes,
      epoch_id: epochId,
      compaction_level: compactionLevel
    },
    progress: {
      state: progressState,
      checkpoint: `checkpoint-${handoffId}`,
      completed: [`Completed ${handoffId}`],
      remaining
    },
    project: {
      objective: "Preserve handoff continuity",
      success_criteria: ["The next agent can resume from accepted state"]
    },
    source_of_truth: {
      repository: "Anazeez/Mnemosyne-Worker",
      revision,
      worktree: "codex/handoff-lineage-foundation",
      designated_files: [{
        path: "src/handoff/contracts.js",
        purpose: "Validate handoff payloads",
        status: "changed",
        last_verified: "2026-08-08T00:00:00.000Z"
      }]
    },
    decisions: [],
    changes: [{
      path: "src/handoff/contracts.js",
      operation: "modify",
      summary: "Keep the handoff schema bounded",
      diff_ref: "local:handoff-fixture",
      diff_hash: "a".repeat(64),
      verification_refs: ["handoff tests"]
    }],
    verification: [{
      name: "handoff tests",
      status: "passed",
      command: "node --test test/handoff-contracts.test.mjs",
      reproduction_step: null,
      expected: "The handoff tests pass",
      evidence: "local"
    }],
    blockers: [],
    rejected_hypotheses: [],
    next_action: "Read the latest accepted handoff",
    do_not_repeat: [],
    authority: {
      allowed_effects: ["read", "edit", "test"],
      denied_effects: ["deploy", "publish", "memory_acceptance"]
    },
    provenance: {
      agent_family: "codex",
      agent_id: "codex-fixture",
      session_id: "fixture-session",
      observed_at: "2026-08-08T00:00:00.000Z",
      source_refs: ["local-test"],
      content_hash: null
    },
    memory: {
      accepted_generation: generation,
      idempotency_key: `handoff-${handoffId}`,
      retention_class: "project",
      ttl_seconds: null,
      expires_at: null,
      sensitivity: "non-secret"
    }
  };
}

export function shadowDelta(sequence, {
  scope = { tenant_id: "tenant-a", project_id: "project.a" },
  previousDeltaHash = null,
  checkpointState = "complete",
  progressState = "in_progress",
  recordedAt = "2026-08-08T00:00:00.000Z",
  nextAction = "Continue from the latest checkpoint"
} = {}) {
  return {
    schema_version: "shadow_delta.v1",
    scope,
    sequence,
    parent_revision: "79a0dec8b2f86f448455dc0f56485f84caf9fd4e",
    changed_fields: [{
      field: "progress.checkpoint",
      summary: `Checkpoint ${sequence} is recorded`
    }],
    changes: [{
      path: "src/handoff/shadow.js",
      operation: "modify",
      summary: `Record shadow checkpoint ${sequence}`,
      diff_ref: `local:shadow-${sequence}`,
      diff_hash: "b".repeat(64),
      verification_refs: ["shadow tests"]
    }],
    designated_files: [{
      path: "src/handoff/shadow.js",
      purpose: "Maintain local recovery checkpoints",
      status: "changed",
      last_verified: recordedAt
    }],
    verification: [{
      name: "shadow tests",
      status: "passed",
      command: "node --test test/handoff-shadow.test.mjs",
      reproduction_step: null,
      expected: "The shadow tests pass",
      evidence: "local"
    }],
    progress: {
      state: progressState,
      checkpoint: `shadow-checkpoint-${sequence}`,
      completed: [`Checkpoint ${sequence} recorded`],
      remaining: ["Continue the next bounded action"]
    },
    blockers: [],
    rejected_hypotheses: [],
    next_action: nextAction,
    do_not_repeat: [],
    checkpoint_state: checkpointState,
    boundary_event: "interruption",
    previous_delta_hash: previousDeltaHash,
    recorded_at: recordedAt
  };
}
