import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import {
  deleteMemoryScope,
  exportMemoryScope,
  rebuildMemoryProjection,
} from "../src/graph-memory/privacy.js";
import {
  migratedGraphMemoryEnvironment,
} from "./helpers/d1-graph-memory.mjs";

const root = {
  tenant_id: "personal",
  credential_id: "architectus",
  role: "root",
  project_ids: ["*"],
  capabilities: ["memory.export", "memory.delete", "memory.projection.rebuild"],
};

test("tenant deletion removes authoritative and retrieval projections", async () => {
  const vector = vectorHarness();
  const env = await seededEnvironment({ MATRIX_KNOWLEDGE: vector });
  const receipt = await deleteMemoryScope({
    env,
    principal: root,
    scope: { tenant_id: "tenant-a" },
    randomUUID: () => "receipt-test",
    now: () => new Date("2026-07-27T00:00:00.000Z"),
  });
  assert.equal(receipt.status, "deleted");
  assert.equal(
    await env.DB.count("memory_entities", "tenant_id = 'tenant-a'"),
    0,
  );
  assert.equal(
    await env.DB.count("memory_entities", "tenant_id = 'tenant-b'"),
    1,
  );
  assert.deepEqual(vector.deletedIds, [
    "entity:tenant-a:project-one:entity-a",
  ]);
  assert.equal(await env.DB.count("memory_deletion_receipts"), 1);
});

test("portal cannot call privacy administration", async () => {
  const portal = {
    tenant_id: "tenant-a",
    credential_id: "portal",
    project_ids: ["project-one"],
    capabilities: ["memory.read", "memory.search"],
  };
  await assert.rejects(
    deleteMemoryScope({
      env: {},
      principal: portal,
      scope: { tenant_id: "tenant-a" },
    }),
    error => error.code === "CAPABILITY_DENIED",
  );
});

test("identity and candidate deletion never erase a neighboring candidate", async () => {
  const env = await seededEnvironment();
  const created = "2026-07-26T00:00:00.000Z";
  for (const [candidateId, assistantId] of [
    ["candidate_identity_a", "assistant-a"],
    ["candidate_identity_b", "assistant-b"],
  ]) {
    await env.DB.prepare(`
      INSERT INTO memory_candidates (
        candidate_id, tenant_id, project_id, submitted_by_credential_id,
        assistant_id, idempotency_key, payload_json, payload_hash, confidence,
        state, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      candidateId, "tenant-a", "project-one", assistantId, assistantId,
      `idempotency-${assistantId}`, "{}", assistantId.padEnd(64, "0"), 0.8,
      "pending_validation", created, created,
    ).run();
  }
  await deleteMemoryScope({
    env,
    principal: root,
    scope: { tenant_id: "tenant-a", identity_id: "assistant-a" },
  });
  assert.equal(
    await env.DB.count("memory_candidates", "candidate_id = 'candidate_identity_a'"),
    0,
  );
  assert.equal(
    await env.DB.count("memory_candidates", "candidate_id = 'candidate_identity_b'"),
    1,
  );
  await deleteMemoryScope({
    env,
    principal: root,
    scope: { tenant_id: "tenant-a", candidate_id: "candidate_identity_b" },
  });
  assert.equal(
    await env.DB.count("memory_candidates", "candidate_id = 'candidate_identity_b'"),
    0,
  );
});

test("privacy export includes accepted provenance but excludes credential and raw excerpts", async () => {
  const env = await seededEnvironment();
  const exported = await exportMemoryScope({
    env,
    principal: { ...root, tenant_id: "tenant-a" },
    scope: { tenant_id: "tenant-a", project_id: "project-one" },
  });
  assert.equal(exported.entities.length, 1);
  assert.equal(exported.evidence.length, 1);
  assert.deepEqual(exported.evidence[0], {
    evidence_id: "evidence-a",
    source_ref: "source://a",
    content_hash: "a".repeat(64),
    observed_at: "2026-07-26T00:00:00.000Z",
    citation: { title: "Source A" },
  });
  assert.doesNotMatch(JSON.stringify(exported), /credential-secret|raw excerpt/);
});

test("projection repair rebuilds only accepted canonical records", async () => {
  const vector = vectorHarness();
  const env = await seededEnvironment({
    MATRIX_KNOWLEDGE: vector,
    AI: {
      run: async (_model, { text }) => ({
        data: text.map((_, index) => [index + 0.25, index + 0.75]),
      }),
    },
  });
  const result = await rebuildMemoryProjection({
    env,
    principal: { ...root, tenant_id: "tenant-a" },
    scope: { tenant_id: "tenant-a", project_id: "project-one" },
  });
  assert.equal(result.status, "rebuilt");
  assert.equal(result.upserted, 1);
  assert.equal(vector.upserted[0].id, "entity:tenant-a:project-one:entity-a");
  assert.deepEqual(vector.upserted[0].metadata, {
    tenant_id: "tenant-a",
    project_id: "project-one",
    record_type: "entity",
  });
});

test("internal export route is root-key authenticated and absent from public adapters", async () => {
  const env = await seededEnvironment({ MATRIX_AUTH_KEY: "root-test-key" });
  const response = await worker.fetch(
    new Request(
      "https://memory.example/v1/admin/memory/export?tenant_id=tenant-a&project_id=project-one",
      { headers: { "X-Matrix-Key": "root-test-key" } },
    ),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).entities.length, 1);
});

async function seededEnvironment(overrides = {}) {
  const env = await migratedGraphMemoryEnvironment(overrides);
  const created = "2026-07-26T00:00:00.000Z";
  await env.DB.prepare(`
    INSERT INTO memory_entities (
      entity_id, tenant_id, project_id, ontology_type, lifecycle_state,
      canonical_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    "entity-a", "tenant-a", "project-one", "component", "accepted",
    "Component A", created, created,
  ).run();
  await env.DB.prepare(`
    INSERT INTO memory_entities (
      entity_id, tenant_id, project_id, ontology_type, lifecycle_state,
      canonical_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    "entity-b", "tenant-b", "project-one", "component", "accepted",
    "Component B", created, created,
  ).run();
  await env.DB.prepare(`
    INSERT INTO memory_evidence (
      evidence_id, tenant_id, project_id, source_ref, content_hash,
      source_excerpt, observed_at, producer_credential_id,
      authorization_labels_json, citation_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    "evidence-a", "tenant-a", "project-one", "source://a", "a".repeat(64),
    "raw excerpt", created, "credential-secret", '["tenant"]',
    '{"title":"Source A"}', created,
  ).run();
  return env;
}

function vectorHarness() {
  return {
    deletedIds: [],
    upserted: [],
    async deleteByIds(ids) {
      this.deletedIds.push(...ids);
    },
    async upsert(records) {
      this.upserted.push(...records);
    },
  };
}
