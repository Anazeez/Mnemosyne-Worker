import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCases } from "../scripts/evaluate-graph-memory-retrieval.mjs";

const knownGood = Array.from({ length: 20 }, (_, index) => ({
  case_id: `case-${index}`,
  kind: index < 10 ? "paraphrase" : "literal",
  expected_assertion_ids: [`expected-${index}`],
  retrieved_assertion_ids: [`expected-${index}`],
  forbidden_assertion_ids: [`foreign-${index}`],
  context_tokens: 500
}));

test("machine judge accepts a known-good retrieval result", () => {
  const result = evaluateCases(knownGood);
  assert.equal(result.passed, true);
  assert.equal(result.recall_at_10, 1);
  assert.equal(result.paraphrase_recall_at_10, 1);
  assert.equal(result.authorization_leaks, 0);
  assert.equal(result.budget_violations, 0);
});

test("machine judge rejects a deliberately broken retrieval result", () => {
  const broken = structuredClone(knownGood);
  broken[0].retrieved_assertion_ids = ["foreign-0"];
  broken[1].context_tokens = 2_001;

  const result = evaluateCases(broken);
  assert.equal(result.passed, false);
  assert.ok(result.paraphrase_recall_at_10 < 0.95);
  assert.equal(result.authorization_leaks, 1);
  assert.equal(result.budget_violations, 1);
});
