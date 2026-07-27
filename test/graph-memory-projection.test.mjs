import assert from "node:assert/strict";
import test from "node:test";

import {
  EMBEDDING_MODEL,
  enqueueAcceptedAssertionProjection,
  repairPendingProjections
} from "../src/graph-memory/projection.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

async function seedAcceptedAssertion(env) {
  const db = env.DB.database;
  db.prepare(`
    INSERT INTO memory_entities (
      entity_id, tenant_id, project_id, ontology_type, lifecycle_state,
      canonical_label, created_at, updated_at
    ) VALUES ('project-one', 'tenant-a', 'project.one', 'entity', 'accepted',
      'Project One', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO memory_assertions (
      assertion_id, tenant_id, project_id, subject_entity_id, predicate,
      object_json, confidence, lifecycle_state, observed_at, created_at,
      accepted_generation
    ) VALUES ('assertion-one', 'tenant-a', 'project.one', 'project-one',
      'response_style', '"conserve tokens"', 0.99, 'candidate',
      '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 3)
  `).run();
  db.prepare(`
    INSERT INTO memory_evidence (
      evidence_id, tenant_id, project_id, source_ref, content_hash,
      source_excerpt, observed_at, producer_credential_id,
      authorization_labels_json, citation_json, created_at
    ) VALUES ('evidence-one', 'tenant-a', 'project.one', 'conversation:one',
      ?, 'Keep answers concise and conserve tokens.',
      '2026-07-27T00:00:00.000Z', 'owner', '[]',
      '{"conversation_id":"one"}', '2026-07-27T00:00:00.000Z')
  `).run("a".repeat(64));
  db.prepare(`
    INSERT INTO memory_assertion_evidence
      (tenant_id, project_id, assertion_id, evidence_id)
    VALUES ('tenant-a', 'project.one', 'assertion-one', 'evidence-one')
  `).run();
  db.prepare(`
    INSERT INTO memory_decisions (
      decision_id, tenant_id, project_id, assertion_id, decision_type,
      outcome, receipt_hash, decided_by_credential_id, created_at
    ) VALUES ('decision-one', 'tenant-a', 'project.one', 'assertion-one',
      'review', 'accepted', ?, 'owner', '2026-07-27T00:00:00.000Z')
  `).run("b".repeat(64));
  db.prepare(`
    UPDATE memory_assertions SET lifecycle_state = 'accepted'
     WHERE assertion_id = 'assertion-one'
  `).run();
}

test("accepted projections populate FTS and Vectorize with provenance metadata", async () => {
  const upserts = [];
  const env = await migratedGraphMemoryEnvironment({
    AI: {
      async run(model, input) {
        assert.equal(model, EMBEDDING_MODEL);
        assert.equal(input.text.length, 1);
        return { data: [[0.1, 0.2, 0.3]] };
      }
    },
    MATRIX_KNOWLEDGE: {
      async upsert(records) {
        upserts.push(...records);
      }
    }
  });
  await seedAcceptedAssertion(env);
  await enqueueAcceptedAssertionProjection({
    env,
    assertionId: "assertion-one",
    now: () => new Date("2026-07-27T01:00:00.000Z")
  });

  const result = await repairPendingProjections({ env, limit: 10 });
  const search = env.DB.database.prepare(`
    SELECT assertion_id, document FROM memory_assertion_search
  `).get();
  const outbox = env.DB.database.prepare(`
    SELECT state FROM memory_projection_outbox
  `).get();

  assert.deepEqual(result, { repaired: 1, failed: 0 });
  assert.equal(search.assertion_id, "assertion-one");
  assert.match(search.document, /conserve tokens/i);
  assert.equal(outbox.state, "complete");
  assert.equal(upserts.length, 1);
  assert.deepEqual(
    Object.keys(upserts[0].metadata).sort(),
    [
      "accepted_generation",
      "assertion_id",
      "content_hash",
      "embedding_model",
      "project_id",
      "tenant_id"
    ]
  );
});

test("projection failures remain retryable without changing accepted truth", async () => {
  const env = await migratedGraphMemoryEnvironment({
    AI: {
      async run() {
        throw new Error("temporary embedding outage");
      }
    },
    MATRIX_KNOWLEDGE: { async upsert() {} }
  });
  await seedAcceptedAssertion(env);
  await enqueueAcceptedAssertionProjection({
    env,
    assertionId: "assertion-one"
  });

  const result = await repairPendingProjections({ env, limit: 10 });
  const outbox = env.DB.database.prepare(`
    SELECT state, attempt_count, last_reason_code
      FROM memory_projection_outbox
  `).get();
  const assertion = env.DB.database.prepare(`
    SELECT lifecycle_state FROM memory_assertions
     WHERE assertion_id = 'assertion-one'
  `).get();

  assert.deepEqual(result, { repaired: 0, failed: 1 });
  assert.equal(outbox.state, "repair_queued");
  assert.equal(outbox.attempt_count, 1);
  assert.equal(outbox.last_reason_code, "EMBEDDING_SERVICE_UNAVAILABLE");
  assert.equal(assertion.lifecycle_state, "accepted");
});
