import assert from "node:assert/strict";
import test from "node:test";

import {
  HandoffError,
  handoffPayloadHash
} from "../src/handoff/contracts.js";
import {
  acceptHandoffCandidate,
  createHandoffCandidate,
  getHandoffLineage,
  rebuildHandoffLineage
} from "../src/handoff/lineage.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

function envelope(handoffId, {
  tenantId = "tenant-a",
  projectId = "project.a",
  parentHandoffId = null,
  supersedes = [],
  generation = 0
} = {}) {
  return {
    schema_version: "handoff.v1",
    handoff_id: handoffId,
    scope: { tenant_id: tenantId, project_id: projectId },
    boundary: {
      event: "task_complete",
      occurred_at: "2026-08-08T00:00:00.000Z",
      parent_handoff_id: parentHandoffId,
      supersedes,
      epoch_id: null,
      compaction_level: "handoff"
    },
    progress: {
      state: "ready_for_handoff",
      checkpoint: handoffId,
      completed: [`Completed ${handoffId}`],
      remaining: ["Continue the next bounded action"]
    },
    project: {
      objective: "Preserve handoff continuity",
      success_criteria: ["The next agent can resume from accepted state"]
    },
    source_of_truth: {
      repository: "Anazeez/Mnemosyne-Worker",
      revision: "79a0dec8b2f86f448455dc0f56485f84caf9fd4e",
      worktree: "codex/handoff-lineage-foundation",
      designated_files: [{
        path: "migrations/010_handoff_lineage.sql",
        purpose: "Store handoff lineage",
        status: "changed",
        last_verified: "2026-08-08T00:00:00.000Z"
      }]
    },
    decisions: [],
    changes: [{
      path: "migrations/010_handoff_lineage.sql",
      operation: "add",
      summary: "Add lineage schema",
      diff_ref: "local:handoff-lineage",
      diff_hash: "a".repeat(64),
      verification_refs: ["handoff lineage tests"]
    }],
    verification: [{
      name: "handoff lineage tests",
      status: "passed",
      command: "node --test test/handoff-lineage.test.mjs",
      reproduction_step: null,
      expected: "The lineage tests pass",
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
      agent_id: "codex-lineage-test",
      session_id: "lineage-test-session",
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

test("creates a root candidate and materializes its self lineage row", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const result = await createHandoffCandidate({
    env,
    envelope: envelope("handoff_root0001")
  });

  assert.equal(result.state, "candidate");
  assert.equal(result.idempotent_replay, false);
  assert.match(result.payload_hash, /^[a-f0-9]{64}$/);

  const rows = await getHandoffLineage({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: "handoff_root0001",
    direction: "ancestors"
  });
  assert.deepEqual(rows.map(row => ({
    ancestor_handoff_id: row.ancestor_handoff_id,
    descendant_handoff_id: row.descendant_handoff_id,
    depth: row.depth
  })), [{
    ancestor_handoff_id: "handoff_root0001",
    descendant_handoff_id: "handoff_root0001",
    depth: 0
  }]);
});

test("records parent and supersedes edges, exposes forks, and counts alternate paths", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await createHandoffCandidate({ env, envelope: envelope("handoff_root0001") });
  await createHandoffCandidate({
    env,
    envelope: envelope("handoff_branch0001", {
      parentHandoffId: "handoff_root0001"
    })
  });
  await createHandoffCandidate({
    env,
    envelope: envelope("handoff_branch0002", {
      parentHandoffId: "handoff_root0001"
    })
  });
  await createHandoffCandidate({
    env,
    envelope: envelope("handoff_join0001", {
      parentHandoffId: "handoff_root0001",
      supersedes: ["handoff_branch0001"]
    })
  });

  const descendants = await getHandoffLineage({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: "handoff_root0001",
    direction: "descendants"
  });
  const join = descendants.find(row => row.descendant_handoff_id === "handoff_join0001");
  assert.equal(join.depth, 1);
  assert.equal(join.path_count, 2);
  assert.equal(descendants.some(row => row.descendant_handoff_id === "handoff_branch0002"), true);

  const edges = await env.DB.prepare(`
    SELECT handoff_id, related_handoff_id, relation_type
      FROM handoff_edges
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY handoff_id, relation_type, related_handoff_id
  `).bind("tenant-a", "project.a").all();
  assert.deepEqual(edges.results.map(row => ({ ...row })), [
    {
      handoff_id: "handoff_branch0001",
      related_handoff_id: "handoff_root0001",
      relation_type: "parent"
    },
    {
      handoff_id: "handoff_branch0002",
      related_handoff_id: "handoff_root0001",
      relation_type: "parent"
    },
    {
      handoff_id: "handoff_join0001",
      related_handoff_id: "handoff_root0001",
      relation_type: "parent"
    },
    {
      handoff_id: "handoff_join0001",
      related_handoff_id: "handoff_branch0001",
      relation_type: "supersedes"
    }
  ]);
});

test("replays an identical candidate and rejects a payload mismatch", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const firstEnvelope = envelope("handoff_replay0001");
  const first = await createHandoffCandidate({ env, envelope: firstEnvelope });
  const replay = await createHandoffCandidate({ env, envelope: firstEnvelope });

  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.payload_hash, first.payload_hash);

  await assert.rejects(
    () => createHandoffCandidate({
      env,
      envelope: envelope("handoff_replay0001", { generation: 1 })
    }),
    error => error instanceof HandoffError && error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH"
  );
});

test("rejects self edges and cross-scope parent references", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await assert.rejects(
    () => createHandoffCandidate({
      env,
      envelope: envelope("handoff_self0001", {
        parentHandoffId: "handoff_self0001"
      })
    }),
    error => error instanceof HandoffError && error.code === "HANDOFF_LINEAGE_SELF_EDGE"
  );

  await createHandoffCandidate({ env, envelope: envelope("handoff_tenant0001") });
  await assert.rejects(
    () => createHandoffCandidate({
      env,
      envelope: envelope("handoff_other0001", {
        tenantId: "tenant-b",
        parentHandoffId: "handoff_tenant0001"
      })
    }),
    error => error instanceof HandoffError && error.code === "CROSS_SCOPE_LINEAGE"
  );
});

test("acceptance requires a verified approval receipt and preserves the candidate payload", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await createHandoffCandidate({
    env,
    envelope: envelope("handoff_accept0001")
  });

  await assert.rejects(
    () => acceptHandoffCandidate({
      env,
      tenantId: "tenant-a",
      projectId: "project.a",
      handoffId: "handoff_accept0001",
      approval: null
    }),
    error => error instanceof HandoffError && error.code === "APPROVAL_REQUIRED"
  );

  const accepted = await acceptHandoffCandidate({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: "handoff_accept0001",
    approval: {
      approved: true,
      approved_by_credential_id: "owner-credential",
      receipt_hash: "b".repeat(64)
    },
    now: () => new Date("2026-08-08T01:00:00.000Z")
  });

  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.payload_hash, candidate.payload_hash);
  const row = await env.DB.prepare(`
    SELECT state, approved_by_credential_id, approval_receipt_hash
      FROM handoffs
     WHERE tenant_id = ? AND project_id = ? AND handoff_id = ?
  `).bind("tenant-a", "project.a", "handoff_accept0001").first();
  assert.deepEqual({ ...row }, {
    state: "accepted",
    approved_by_credential_id: "owner-credential",
    approval_receipt_hash: "b".repeat(64)
  });
});

test("rebuilds closure deterministically for rollback traversal", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await createHandoffCandidate({ env, envelope: envelope("handoff_rebuild0001") });
  await createHandoffCandidate({
    env,
    envelope: envelope("handoff_rebuild0002", {
      parentHandoffId: "handoff_rebuild0001"
    })
  });

  const before = await getHandoffLineage({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: "handoff_rebuild0002",
    direction: "ancestors"
  });
  const result = await rebuildHandoffLineage({
    env,
    tenantId: "tenant-a",
    projectId: "project.a"
  });
  const after = await getHandoffLineage({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: "handoff_rebuild0002",
    direction: "ancestors"
  });

  assert.equal(result.row_count, 3);
  assert.deepEqual(after.map(row => ({ ...row })), before.map(row => ({ ...row })));
});

test("hashes the normalized payload used for candidate storage", async () => {
  const normalized = envelope("handoff_hash0001");
  const expected = await handoffPayloadHash(normalized);
  const env = await migratedGraphMemoryEnvironment();
  const result = await createHandoffCandidate({ env, envelope: normalized });
  assert.equal(result.payload_hash, expected);
});
