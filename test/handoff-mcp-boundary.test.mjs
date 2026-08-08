import assert from "node:assert/strict";
import test from "node:test";

import { GraphMemoryError } from "../src/graph-memory/contracts.js";
import {
  acceptHandoffDraft,
  proposeHandoffDraft,
  readLatestHandoffResource
} from "../src/handoff/mcp.js";
import {
  acceptHandoffCandidate,
  createHandoffCandidate
} from "../src/handoff/lineage.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";
import { handoffEnvelope } from "./helpers/handoff-fixture.mjs";

const principal = {
  tenant_id: "tenant-a",
  credential_id: "assistant-one",
  assistant_id: "assistant-one",
  role: "portal",
  project_ids: ["project.a"],
  capabilities: ["memory.read", "memory.propose"]
};

const ownerPrincipal = {
  tenant_id: "tenant-a",
  credential_id: "owner-one",
  assistant_id: "human-review-console",
  role: "owner",
  project_ids: ["project.a"],
  capabilities: ["memory.read", "memory.propose", "memory.handoff.accept"]
};

test("handoff.propose returns a deterministic confirmation receipt without a database", async () => {
  const input = {
    tenant_id: "tenant-a",
    project_id: "project.a",
    local_draft: handoffEnvelope("handoff_draft0001")
  };
  const first = await proposeHandoffDraft({ principal, input });
  const second = await proposeHandoffDraft({ principal, input });

  assert.equal(first.status, "pending_confirmation");
  assert.equal(first.confirmation_required, true);
  assert.equal(first.accepted, false);
  assert.equal(first.approval.accepted_memory_write, false);
  assert.equal(first.confirmation_id, second.confirmation_id);
  assert.equal(first.payload_hash, second.payload_hash);
  assert.equal(first.local_draft.handoff_id, "handoff_draft0001");
});

test("handoff.propose rejects a local draft from another scope", async () => {
  await assert.rejects(
    () => proposeHandoffDraft({
      principal,
      input: {
        tenant_id: "tenant-a",
        project_id: "project.a",
        local_draft: handoffEnvelope("handoff_draft0002", {
          tenantId: "tenant-b"
        })
      }
    }),
    error => error.code === "HANDOFF_SCOPE_MISMATCH"
  );
});

test("handoff.accept requires the exact proposal receipt and records one owner approval", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const input = {
    tenant_id: "tenant-a",
    project_id: "project.a",
    local_draft: handoffEnvelope("handoff_approved0001")
  };
  const proposal = await proposeHandoffDraft({
    principal: ownerPrincipal,
    input
  });
  const accepted = await acceptHandoffDraft({
    env,
    principal: ownerPrincipal,
    input: {
      ...input,
      confirmation_id: proposal.confirmation_id,
      payload_hash: proposal.payload_hash,
      approval: {
        approved: true,
        approved_by_credential_id: "owner-one",
        receipt_hash: "e".repeat(64)
      }
    }
  });

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.accepted_memory_write, true);
  assert.equal(accepted.acceptance.state, "accepted");
  const row = await env.DB.prepare(`
    SELECT state, approved_by_credential_id
      FROM handoffs
     WHERE tenant_id = ? AND project_id = ? AND handoff_id = ?
  `).bind("tenant-a", "project.a", "handoff_approved0001").first();
  assert.deepEqual({ ...row }, {
    state: "accepted",
    approved_by_credential_id: "owner-one"
  });

  await assert.rejects(
    () => acceptHandoffDraft({
      env,
      principal,
      input: {
        ...input,
        confirmation_id: proposal.confirmation_id,
        payload_hash: proposal.payload_hash,
        approval: {
          approved: true,
          approved_by_credential_id: "assistant-one",
          receipt_hash: "f".repeat(64)
        }
      }
    }),
    error => error.code === "CAPABILITY_DENIED"
  );
});

test("handoff.accept fails closed on confirmation or owner credential mismatch", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const input = {
    tenant_id: "tenant-a",
    project_id: "project.a",
    local_draft: handoffEnvelope("handoff_approved0002")
  };
  const proposal = await proposeHandoffDraft({
    principal: ownerPrincipal,
    input
  });

  await assert.rejects(
    () => acceptHandoffDraft({
      env,
      principal: ownerPrincipal,
      input: {
        ...input,
        confirmation_id: proposal.confirmation_id,
        payload_hash: "a".repeat(64),
        approval: {
          approved: true,
          approved_by_credential_id: "owner-one",
          receipt_hash: "a".repeat(64)
        }
      }
    }),
    error => error.code === "CONFIRMATION_PAYLOAD_MISMATCH"
  );
  await assert.rejects(
    () => acceptHandoffDraft({
      env,
      principal: { ...ownerPrincipal, credential_id: "owner-two" },
      input: {
        ...input,
        confirmation_id: proposal.confirmation_id,
        payload_hash: proposal.payload_hash,
        approval: {
          approved: true,
          approved_by_credential_id: "owner-one",
          receipt_hash: "a".repeat(64)
        }
      }
    }),
    error => error.code === "APPROVAL_CREDENTIAL_MISMATCH"
  );
  assert.equal(await env.DB.count("handoffs"), 0);
});

test("latest resource returns the accepted epoch, active handoff, and scoped lineage", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const root = await createHandoffCandidate({
    env,
    envelope: handoffEnvelope("handoff_root0001", { generation: 1 })
  });
  await acceptHandoffCandidate({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: root.handoff_id,
    approval: {
      approved: true,
      approved_by_credential_id: "owner-one",
      receipt_hash: "c".repeat(64)
    }
  });
  const epoch = await createHandoffCandidate({
    env,
    envelope: handoffEnvelope("handoff_epoch0001", {
      parentHandoffId: "handoff_root0001",
      supersedes: ["handoff_root0001"],
      epochId: "handoff_root0001",
      event: "phase_complete",
      compactionLevel: "epoch",
      generation: 2
    })
  });
  await acceptHandoffCandidate({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: epoch.handoff_id,
    approval: {
      approved: true,
      approved_by_credential_id: "owner-one",
      receipt_hash: "d".repeat(64)
    }
  });

  const resource = await readLatestHandoffResource({
    env,
    principal,
    tenantId: "tenant-a",
    projectId: "project.a",
    now: () => new Date("2026-08-09T00:00:00.000Z")
  });

  assert.equal(resource.schema_version, "handoff.resource.v1");
  assert.equal(resource.accepted_generation, 2);
  assert.equal(resource.active_handoff.handoff_id, "handoff_epoch0001");
  assert.equal(resource.latest_epoch_or_snapshot.handoff_id, "handoff_epoch0001");
  assert.equal(resource.lineage.active_handoff_id, "handoff_epoch0001");
  assert.equal(
    resource.lineage.ancestors.some(row => row.ancestor_handoff_id === "handoff_root0001"),
    true
  );
  assert.equal(resource.truncation.applied, false);
  assert.deepEqual(resource.conflicts, []);
});

test("latest resource is empty but well-shaped when no handoff is accepted", async () => {
  const resource = await readLatestHandoffResource({
    env: await migratedGraphMemoryEnvironment(),
    principal,
    tenantId: "tenant-a",
    projectId: "project.a"
  });

  assert.equal(resource.active_handoff, null);
  assert.equal(resource.latest_epoch_or_snapshot, null);
  assert.equal(resource.accepted_generation, 0);
  assert.equal(resource.lineage.active_handoff_id, null);
  assert.deepEqual(resource.conflicts, []);
});

test("handoff boundaries preserve capability and tenant authorization", async () => {
  await assert.rejects(
    () => proposeHandoffDraft({
      principal: { ...principal, capabilities: [] },
      input: {
        tenant_id: "tenant-a",
        project_id: "project.a",
        local_draft: handoffEnvelope("handoff_auth0001")
      }
    }),
    error => error instanceof GraphMemoryError && error.code === "CAPABILITY_DENIED"
  );
  await assert.rejects(
    () => readLatestHandoffResource({
      env: {},
      principal: { ...principal, project_ids: ["other.project"] },
      tenantId: "tenant-a",
      projectId: "project.a"
    }),
    error => error instanceof GraphMemoryError && error.code === "PROJECT_SCOPE_DENIED"
  );
});
