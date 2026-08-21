import assert from "node:assert/strict";
import test from "node:test";

import { acceptHandoffDraft } from "../src/handoff/mcp.js";
import {
  buildEpochEnvelope,
  compactAcceptedHandoffs
} from "../src/handoff/compaction.js";
import {
  acceptHandoffCandidate,
  createHandoffCandidate,
  getHandoffLineage
} from "../src/handoff/lineage.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";
import { handoffEnvelope } from "./helpers/handoff-fixture.mjs";

function approval(credential, receipt) {
  return {
    approved: true,
    approved_by_credential_id: credential,
    receipt_hash: receipt.repeat(64)
  };
}

async function accept(env, handoffId, credential, receipt) {
  return acceptHandoffCandidate({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId,
    approval: approval(credential, receipt)
  });
}

const ownerPrincipal = {
  tenant_id: "tenant-a",
  credential_id: "owner-one",
  assistant_id: "human-review-console",
  role: "owner",
  project_ids: ["project.a"],
  capabilities: ["memory.read", "memory.handoff.accept"]
};

test("epoch compiler preserves source IDs, summaries, provenance, and bounded conflict markers", async () => {
  const sourceRows = [1, 2].map(sequence => ({
    handoff_id: `handoff_source${String(sequence).padStart(4, "0")}`,
    payload_hash: "a".repeat(64),
    envelope: handoffEnvelope(
      `handoff_source${String(sequence).padStart(4, "0")}`
    )
  }));
  sourceRows[1].envelope.project.objective = "A changed objective";

  const epoch = await buildEpochEnvelope({
    sourceRows,
    occurredAt: "2026-08-08T02:00:00.000Z",
    agentFamily: "codex",
    agentId: "codex-compactor",
    sessionId: "compaction-session"
  });

  assert.equal(epoch.boundary.compaction_level, "epoch");
  assert.deepEqual(epoch.boundary.supersedes, [
    "handoff_source0001",
    "handoff_source0002"
  ]);
  assert.equal(epoch.boundary.parent_handoff_id, "handoff_source0002");
  assert.equal(epoch.provenance.agent_family, "codex");
  assert.equal(epoch.provenance.agent_id, "codex-compactor");
  assert.match(epoch.decisions[0].statement, /handoff_source0001/);
  assert.match(epoch.decisions[0].statement, /handoff_source0002/);
  assert.equal(epoch.verification[0].status, "passed");
  assert.equal(
    epoch.blockers.some(blocker => /objective/.test(blocker)),
    true
  );
});

test("accepted epoch compaction archives covered sources without deleting lineage and replays idempotently", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await createHandoffCandidate({
    env,
    envelope: handoffEnvelope("handoff_compact0001", { generation: 1 })
  });
  await accept(env, "handoff_compact0001", "owner-one", "b");
  await createHandoffCandidate({
    env,
    envelope: handoffEnvelope("handoff_compact0002", {
      parentHandoffId: "handoff_compact0001",
      generation: 2
    })
  });
  await accept(env, "handoff_compact0002", "owner-one", "c");

  const proposal = await compactAcceptedHandoffs({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    occurredAt: "2026-08-08T03:00:00.000Z",
    agentFamily: "codex",
    agentId: "codex-compactor",
    sessionId: "compaction-session"
  });
  assert.equal(proposal.status, "pending_confirmation");
  assert.equal(await env.DB.count("handoffs"), 2);
  assert.deepEqual(proposal.covered_handoff_ids, [
    "handoff_compact0001",
    "handoff_compact0002"
  ]);

  const accepted = await acceptHandoffDraft({
    env,
    principal: ownerPrincipal,
    input: {
      tenant_id: proposal.tenant_id,
      project_id: proposal.project_id,
      confirmation_id: proposal.confirmation_id,
      payload_hash: proposal.payload_hash,
      local_draft: proposal.local_draft,
      approval: approval("owner-one", "d")
    }
  });
  assert.equal(accepted.acceptance.state, "accepted");
  assert.deepEqual(accepted.acceptance.archived_handoff_ids, [
    "handoff_compact0001",
    "handoff_compact0002"
  ]);

  const states = await env.DB.prepare(`
    SELECT handoff_id, state, superseded_at
      FROM handoffs
     WHERE tenant_id = ? AND project_id = ?
     ORDER BY handoff_id
  `).bind("tenant-a", "project.a").all();
  assert.equal(states.results.length, 3);
  assert.deepEqual(
    states.results.filter(row => row.handoff_id !== proposal.handoff_id)
      .map(row => row.state),
    ["archived", "archived"]
  );
  assert.equal(
    states.results.filter(row => row.handoff_id !== proposal.handoff_id)
      .every(row => Boolean(row.superseded_at)),
    true
  );

  const lineage = await getHandoffLineage({
    env,
    tenantId: "tenant-a",
    projectId: "project.a",
    handoffId: proposal.handoff_id,
    direction: "ancestors"
  });
  assert.equal(
    lineage.some(row => row.ancestor_handoff_id === "handoff_compact0001"),
    true
  );
  const replay = await acceptHandoffDraft({
    env,
    principal: ownerPrincipal,
    input: {
      tenant_id: proposal.tenant_id,
      project_id: proposal.project_id,
      confirmation_id: proposal.confirmation_id,
      payload_hash: proposal.payload_hash,
      local_draft: proposal.local_draft,
      approval: approval("owner-one", "d")
    }
  });
  assert.equal(replay.idempotent_replay, true);
});

test("epoch compaction fails closed when its source set exceeds the bounded envelope", async () => {
  const sourceRows = Array.from({ length: 101 }, (_, index) => {
    const id = `handoff_source${String(index).padStart(4, "0")}`;
    return {
      handoff_id: id,
      payload_hash: "a".repeat(64),
      envelope: handoffEnvelope(id)
    };
  });

  await assert.rejects(
    () => buildEpochEnvelope({
      sourceRows,
      occurredAt: "2026-08-08T02:00:00.000Z"
    }),
    error => error.code === "COMPACTION_SOURCE_LIMIT"
  );
});
