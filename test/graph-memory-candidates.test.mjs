import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryCandidate,
  getOwnCandidate
} from "../src/graph-memory/candidates.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

const evidenceHash = "a".repeat(64);

function portal(overrides = {}) {
  return {
    tenant_id: "tenant-a",
    credential_id: "portal-a",
    assistant_id: "chatgpt-work",
    principal_id: "portal",
    role: "portal",
    project_ids: ["project.one"],
    identity_ids: ["assistant-a"],
    capabilities: [
      "memory.read",
      "memory.search",
      "memory.propose",
      "memory.candidate.read.own",
      "continuity.read"
    ],
    ...overrides
  };
}

function proposal(overrides = {}) {
  return {
    tenant_id: "tenant-a",
    project_id: "project.one",
    idempotency_key: "proposal-001",
    assertions: [{
      subject: "entity:one",
      predicate: "status",
      object: "active",
      confidence: 0.95
    }],
    evidence: [{
      source_ref: "https://example.invalid/source",
      content_hash: evidenceHash,
      observed_at: "2026-07-27T00:00:00.000Z"
    }],
    ...overrides
  };
}

test("proposal creates pending validation without accepted writes", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const result = await createMemoryCandidate({
    env,
    principal: portal(),
    body: proposal(),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    randomUUID: () => "candidate-uuid"
  });

  assert.deepEqual(result, {
    candidate_id: "candidate_candidate-uuid",
    state: "pending_validation",
    submitted_at: "2026-07-27T12:00:00.000Z",
    payload_hash: result.payload_hash,
    idempotent_replay: false
  });
  assert.match(result.payload_hash, /^[a-f0-9]{64}$/);
  assert.equal(await env.DB.count("memory_candidates"), 1);
  assert.equal(
    await env.DB.count("memory_assertions", "lifecycle_state = 'accepted'"),
    0
  );
});

test("identical proposal replays while changed payload conflicts", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const input = {
    env,
    principal: portal(),
    body: proposal(),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    randomUUID: () => "candidate-uuid"
  };
  const created = await createMemoryCandidate(input);
  const replayed = await createMemoryCandidate({
    ...input,
    randomUUID: () => "unused-uuid"
  });

  assert.equal(replayed.candidate_id, created.candidate_id);
  assert.equal(replayed.idempotent_replay, true);
  await assert.rejects(
    createMemoryCandidate({
      ...input,
      body: proposal({
        assertions: [{
          subject: "entity:one",
          predicate: "status",
          object: "paused",
          confidence: 0.95
        }]
      })
    }),
    error => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH"
  );
});

test("candidate status is visible only to its submitting credential", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const created = await createMemoryCandidate({
    env,
    principal: portal(),
    body: proposal(),
    randomUUID: () => "candidate-uuid"
  });
  const own = await getOwnCandidate({
    env,
    principal: portal(),
    candidateId: created.candidate_id
  });

  assert.equal(own.candidate_id, created.candidate_id);
  assert.equal(own.state, "pending_validation");
  await assert.rejects(
    getOwnCandidate({
      env,
      principal: portal({ credential_id: "portal-b" }),
      candidateId: created.candidate_id
    }),
    error => error.code === "CANDIDATE_NOT_FOUND"
  );
});

test("cross-tenant proposal fails before database access", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await assert.rejects(
    createMemoryCandidate({
      env,
      principal: portal(),
      body: proposal({ tenant_id: "tenant-b" })
    }),
    error => error.code === "TENANT_SCOPE_DENIED"
  );
  assert.equal(await env.DB.count("memory_candidates"), 0);
});
