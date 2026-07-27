import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryCandidate } from "../src/graph-memory/candidates.js";
import * as ownerReview from "../src/graph-memory/human-review.js";
import {
  resolveMemoryCandidate,
  validateMemoryCandidate
} from "../src/graph-memory/review.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

const target = {
  tenant_id: "tenant-a",
  project_id: "project.one"
};

function principal(role, capabilities) {
  return {
    tenant_id: target.tenant_id,
    credential_id: `${role}-credential`,
    assistant_id: `${role}-assistant`,
    principal_id: role,
    role,
    project_ids: [target.project_id],
    identity_ids: [],
    capabilities
  };
}

const portal = () => principal("portal", ["memory.propose"]);
const validator = () => principal("owner", ["memory.validate"]);
const resolver = () => principal("owner", ["memory.resolve"]);
const reviewer = () => principal("owner", ["memory.review"]);

async function candidateAt(env, stage, suffix = "owner-review") {
  const candidate = await createMemoryCandidate({
    env,
    principal: portal(),
    body: {
      ...target,
      idempotency_key: `proposal-${suffix}`,
      assertions: [{
        subject: "Athar",
        predicate: "is_a",
        object: "lineage framework persona",
        confidence: 1
      }],
      evidence: [{
        source_ref: `conversation:${suffix}`,
        content_hash: "d".repeat(64),
        source_excerpt: "Athar is a lineage framework persona.",
        observed_at: "2026-07-27T00:00:00.000Z"
      }]
    },
    randomUUID: () => `candidate-${suffix}`
  });
  if (stage === "proposed") return candidate;
  await validateMemoryCandidate({
    env,
    principal: validator(),
    candidateId: candidate.candidate_id,
    randomUUID: () => `validation-${suffix}`
  });
  if (stage === "validated") return candidate;
  await resolveMemoryCandidate({
    env,
    principal: resolver(),
    candidateId: candidate.candidate_id,
    randomUUID: () => `resolution-${suffix}`
  });
  return candidate;
}

test("owner review detail binds exact payload evidence and resolution receipt", async () => {
  assert.equal(typeof ownerReview.getOwnerReviewCandidate, "function");
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await candidateAt(env, "resolved", "detail");

  const detail = await ownerReview.getOwnerReviewCandidate({
    env,
    principal: reviewer(),
    target,
    candidateId: candidate.candidate_id
  });

  assert.equal(detail.candidate.payload.assertions[0].subject, "Athar");
  assert.equal(
    detail.evidence[0].source_excerpt,
    "Athar is a lineage framework persona."
  );
  assert.equal(
    detail.resolution.resolutions[0].outcome,
    "new_entity"
  );
});

test("approve for commit records one replay-safe receipt without accepted writes", async () => {
  assert.equal(typeof ownerReview.reviewMemoryCandidate, "function");
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await candidateAt(env, "resolved", "approve");
  const input = {
    env,
    principal: reviewer(),
    target,
    candidateId: candidate.candidate_id,
    decision: "approve_for_commit",
    now: () => new Date("2026-07-27T17:00:00.000Z"),
    randomUUID: () => "approve-receipt"
  };

  const first = await ownerReview.reviewMemoryCandidate(input);
  const replay = await ownerReview.reviewMemoryCandidate(input);

  assert.deepEqual(replay, first);
  assert.equal(first.state, "pending_review");
  assert.equal(first.decision, "approve_for_commit");
  assert.equal(first.review_receipt_id, "owner_review_approve-receipt");
  assert.equal(await env.DB.count("memory_owner_review_receipts"), 1);
  assert.equal(await env.DB.count("memory_assertions"), 0);
  assert.equal(await env.DB.count("memory_entities"), 0);
  assert.equal(await env.DB.count("memory_snapshots"), 0);
});

test("owner rejection records a stable reason and rejects the candidate", async () => {
  assert.equal(typeof ownerReview.reviewMemoryCandidate, "function");
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await candidateAt(env, "resolved", "reject");
  const result = await ownerReview.reviewMemoryCandidate({
    env,
    principal: reviewer(),
    target,
    candidateId: candidate.candidate_id,
    decision: "reject",
    randomUUID: () => "reject-receipt"
  });

  assert.equal(result.state, "rejected");
  assert.equal(result.reason_code, "OWNER_REJECTED");
  assert.equal(await env.DB.count("memory_assertions"), 0);
});

test("owner quarantine records a stable reason and quarantines the candidate", async () => {
  assert.equal(typeof ownerReview.reviewMemoryCandidate, "function");
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await candidateAt(env, "resolved", "quarantine");
  const result = await ownerReview.reviewMemoryCandidate({
    env,
    principal: reviewer(),
    target,
    candidateId: candidate.candidate_id,
    decision: "quarantine",
    randomUUID: () => "quarantine-receipt"
  });

  assert.equal(result.state, "quarantined");
  assert.equal(result.reason_code, "OWNER_QUARANTINED");
  assert.equal(await env.DB.count("memory_assertions"), 0);
});

test("owner review fails closed until entity resolution has a receipt", async () => {
  assert.equal(typeof ownerReview.reviewMemoryCandidate, "function");
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await candidateAt(env, "validated", "unresolved");

  await assert.rejects(
    ownerReview.reviewMemoryCandidate({
      env,
      principal: reviewer(),
      target,
      candidateId: candidate.candidate_id,
      decision: "approve_for_commit"
    }),
    error => error.code === "RESOLUTION_REQUIRED"
  );
});

test("assistant cannot review even when claiming the review capability", async () => {
  assert.equal(typeof ownerReview.reviewMemoryCandidate, "function");
  const env = await migratedGraphMemoryEnvironment();
  const candidate = await candidateAt(env, "resolved", "assistant-denied");

  await assert.rejects(
    ownerReview.reviewMemoryCandidate({
      env,
      principal: principal("portal", ["memory.review"]),
      target,
      candidateId: candidate.candidate_id,
      decision: "approve_for_commit"
    }),
    error => error.code === "HUMAN_REVIEW_REQUIRED"
  );
});
