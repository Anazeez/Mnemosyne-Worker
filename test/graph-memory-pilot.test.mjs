import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { judgeGraphMemoryPilot } from "../scripts/graph-memory-pilot.mjs";

const fixture = new URL(
  "../migrations/fixtures/graph-memory-golden.jsonl",
  import.meta.url,
);

test("pilot judge accepts the golden set deterministically", async () => {
  const records = (await readFile(fixture, "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const first = await judgeGraphMemoryPilot(records);
  const second = await judgeGraphMemoryPilot(records);
  assert.deepEqual(first, second);
  assert.equal(first.passed, true);
  assert.equal(first.metrics.entity_precision >= 0.9, true);
  assert.equal(first.metrics.relation_precision >= 0.9, true);
  assert.equal(first.metrics.provenance_coverage, 1);
  assert.equal(first.metrics.ontology_validity, 1);
  assert.equal(first.replay_equal, true);
  assert.equal(first.rollback_equal, true);
  assert.deepEqual(first.quarantine_reason_codes, [
    "AMBIGUOUS_ENTITY_RESOLUTION",
    "PROJECT_SCOPE_DENIED",
    "UNTRUSTED_INSTRUCTION_CONTENT",
  ]);
});

test("pilot judge rejects a deliberately broken relation", async () => {
  const report = await judgeGraphMemoryPilot([
    {
      kind: "entity",
      tenant_id: "tenant-a",
      project_id: "alpha",
      entity_id: "one",
      ontology_type: "project",
      canonical_label: "One",
      expected: "accepted",
    },
    {
      kind: "relation",
      tenant_id: "tenant-a",
      project_id: "alpha",
      relation_id: "broken",
      source_entity_id: "one",
      relation_type: "uses_service",
      target_entity_id: "missing",
      expected: "accepted",
    },
  ]);
  assert.equal(report.passed, false);
  assert.equal(report.metrics.relation_precision, 0);
});
