import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryCandidate } from "../src/graph-memory/candidates.js";
import {
  decideReviewCandidate,
  getReviewCandidate,
  handleHumanReviewRequest,
  listReviewCandidates
} from "../src/graph-memory/human-review.js";
import { validateMemoryCandidate } from "../src/graph-memory/review.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

const target = {
  tenant_id: "tenant-a",
  project_id: "project.one"
};

function owner() {
  return {
    ...target,
    credential_id: "github-42",
    assistant_id: "human-review-console",
    principal_id: "owner",
    role: "owner",
    project_ids: ["project.one"],
    identity_ids: ["*"],
    capabilities: [
      "memory.review",
      "memory.validate",
      "memory.resolve",
      "memory.publish"
    ]
  };
}

function assistant() {
  return {
    ...owner(),
    credential_id: "assistant-one",
    assistant_id: "assistant-one",
    role: "portal",
    principal_id: "portal"
  };
}

async function proposedCandidate(env, suffix = "one") {
  const candidate = await createMemoryCandidate({
    env,
    principal: {
      ...target,
      credential_id: "assistant-one",
      assistant_id: "assistant-one",
      project_ids: ["project.one"],
      identity_ids: ["assistant-one"],
      capabilities: ["memory.propose"]
    },
    body: {
      ...target,
      idempotency_key: `proposal-${suffix}`,
      assertions: [{
        subject: "User",
        predicate: "response_style",
        object: "verbose",
        confidence: 0.95
      }],
      evidence: [{
        source_ref: `conversation:${suffix}`,
        content_hash: "a".repeat(64),
        source_excerpt: "Please keep the response concise.",
        observed_at: "2026-07-27T00:00:00.000Z"
      }]
    },
    randomUUID: () => `candidate-${suffix}`
  });
  await validateMemoryCandidate({
    env,
    principal: owner(),
    candidateId: candidate.candidate_id,
    randomUUID: () => `validation-${suffix}`
  });
  return candidate;
}

test("review queue is human-only even if an assistant claims the capability", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await proposedCandidate(env);

  await assert.rejects(
    listReviewCandidates({ env, principal: assistant(), target }),
    error => error.code === "HUMAN_REVIEW_REQUIRED"
  );
  const result = await listReviewCandidates({
    env,
    principal: owner(),
    target
  });
  assert.equal(result.candidates.length, 1);
});

test("review detail contains exact evidence and origin metadata", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await proposedCandidate(env);
  const result = await getReviewCandidate({
    env,
    principal: owner(),
    target,
    candidateId: candidate.candidate_id
  });

  assert.equal(result.evidence[0].source_excerpt, "Please keep the response concise.");
  assert.equal(result.candidate.submitted_by_credential_id, "assistant-one");
  assert.equal(result.candidate.assistant_id, "assistant-one");
});

test("edit-and-accept is idempotent and publishes the edited canonical form", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await proposedCandidate(env, "edit");
  const input = {
    env,
    principal: owner(),
    target,
    candidateId: candidate.candidate_id,
    decision: "edit_accept",
    editedAssertions: [{
      subject: "User",
      predicate: "response_style",
      object: "concise",
      confidence: 0.99
    }],
    idempotencyKey: "review-action-edit-0001"
  };
  const first = await decideReviewCandidate(input);
  const replay = await decideReviewCandidate(input);
  const assertion = env.DB.database.prepare(`
    SELECT object_json FROM memory_assertions
     WHERE candidate_id = ? AND lifecycle_state = 'accepted'
  `).get(candidate.candidate_id);

  assert.equal(first.decision_id, replay.decision_id);
  assert.equal(assertion.object_json, '"concise"');
  assert.equal(await env.DB.count("memory_candidate_edits"), 1);
  assert.equal(await env.DB.count("memory_review_actions"), 1);
});

test("admin HTTP routes reject assistants and return no-store owner responses", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await proposedCandidate(env, "http");
  const request = new Request(
    "https://memory.example/admin/memory/candidates" +
      "?tenant_id=tenant-a&project_id=project.one"
  );

  const denied = await handleHumanReviewRequest(request, {
    env,
    principal: assistant()
  });
  const allowed = await handleHumanReviewRequest(request, {
    env,
    principal: owner()
  });

  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "HUMAN_REVIEW_REQUIRED");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await allowed.json()).candidates.length, 1);
});
