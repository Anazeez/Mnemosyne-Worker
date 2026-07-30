import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryCandidate } from "../src/graph-memory/candidates.js";
import {
  publishMemoryCandidate,
  rollbackMemoryDecision,
  validateMemoryCandidate
} from "../src/graph-memory/review.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

const base = {
  tenant_id: "tenant-a",
  project_ids: ["project.one"],
  identity_ids: ["*"]
};

test("rollback restores the verified pre-publication accepted view", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await createMemoryCandidate({
    env,
    principal: {
      ...base,
      credential_id: "portal-a",
      assistant_id: "portal-assistant",
      capabilities: ["memory.propose"]
    },
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      idempotency_key: "rollback-proposal",
      assertions: [{
        subject: "entity-one",
        predicate: "status",
        object: "active",
        confidence: 0.96
      }],
      evidence: [{
        source_ref: "https://example.invalid/source",
        content_hash: "a".repeat(64),
        observed_at: "2026-07-27T00:00:00.000Z"
      }]
    },
    randomUUID: () => "rollback-candidate"
  });
  await validateMemoryCandidate({
    env,
    principal: {
      ...base,
      credential_id: "reviewer-a",
      capabilities: ["memory.validate"]
    },
    candidateId: candidate.candidate_id,
    randomUUID: () => "rollback-validation"
  });
  const publication = await publishMemoryCandidate({
    env,
    principal: {
      ...base,
      credential_id: "publisher-a",
      capabilities: ["memory.publish"]
    },
    candidateId: candidate.candidate_id,
    randomUUID: () => "rollback-publication"
  });
  const result = await rollbackMemoryDecision({
    env,
    principal: {
      ...base,
      credential_id: "publisher-a",
      capabilities: ["memory.rollback"]
    },
    decisionId: publication.decision_id,
    randomUUID: () => "rollback-decision"
  });

  assert.equal(result.restored_snapshot_hash, publication.pre_snapshot_hash);
  assert.equal(await env.DB.count("memory_assertions", "lifecycle_state = 'accepted'"), 0);
  assert.equal(await env.DB.count("memory_assertions", "lifecycle_state = 'superseded'"), 1);
  assert.equal(await env.DB.count("memory_decisions", "decision_type = 'rollback'"), 1);
  assert.equal(
    await env.DB.count(
      "memory_projection_outbox",
      "operation = 'delete' AND state = 'pending'"
    ),
    1
  );
});
