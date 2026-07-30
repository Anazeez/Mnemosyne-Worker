import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextPackage,
  estimateTokens
} from "../src/graph-memory/context-package.js";

function assertion(id, object = "concise") {
  return {
    assertion_id: id,
    subject_entity_id: "user",
    canonical_label: "User",
    predicate: "response_style",
    object,
    confidence: 0.99,
    state: "accepted",
    accepted_generation: 3,
    evidence: [{
      evidence_id: `evidence-${id}`,
      source_ref: "conversation:one",
      content_hash: "a".repeat(64),
      observed_at: "2026-07-27T00:00:00.000Z",
      citation: { conversation_id: "one" }
    }]
  };
}

test("context package stays within budget and preserves evidence identities", () => {
  const assertions = Array.from(
    { length: 20 },
    (_, index) => assertion(`a${index}`, "x".repeat(220))
  );
  const result = buildContextPackage({
    assertions,
    conflicts: [],
    budgetTokens: 500
  });

  assert.ok(result.estimated_tokens <= 500);
  assert.equal(result.assertions.every(item => item.state === "accepted"), true);
  assert.equal(result.assertions[0].evidence[0].content_hash, "a".repeat(64));
  assert.equal(result.truncated, true);
  assert.equal(result.insufficient, false);
});

test("context package explicitly reports when one evidenced assertion cannot fit", () => {
  const result = buildContextPackage({
    assertions: [assertion("oversized", "x".repeat(8_000))],
    conflicts: [],
    budgetTokens: 30
  });

  assert.equal(result.insufficient, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.assertions, []);
  assert.ok(result.estimated_tokens <= 30);
});

test("token estimation is deterministic compact-json byte accounting", () => {
  const value = { text: "12345678" };
  assert.equal(estimateTokens(value), Math.ceil(
    Buffer.byteLength(JSON.stringify(value), "utf8") / 4
  ));
});
