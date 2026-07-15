import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNWAY_SCHEMA,
  buildRunwayManifest,
  canonicalJson
} from "../src/continuity.js";
import { loadWorker } from "./helpers/worker-harness.mjs";
import { ContinuityMemoryD1 } from "./helpers/d1-continuity-memory.mjs";

function proposal(overrides = {}) {
  return {
    objective: "Publish exact continuity",
    operational_state: "A validated candidate is ready",
    decisions_in_force: [],
    open_threads: [],
    next_actions: [],
    mounted_skills: [],
    relevant_agents: [],
    relevant_files: [],
    knowledge_references: [],
    library_references: [],
    pending_handoffs: [],
    constraints: [],
    prohibited_assumptions: [],
    integrity_warnings: [],
    ...overrides
  };
}

function env(db, overrides = {}) {
  return {
    DB: db,
    CONTINUITY_READ_ENABLED: "true",
    CONTINUITY_WRITE_ENABLED: "true",
    CONTINUITY_PUBLICATION_ENABLED: "true",
    MATRIX_PRINCIPAL_KEYS: {
      "specialist-key": {
        credential_id: "ariadne",
        principal_id: "specialist",
        project_ids: ["project-infinitum"]
      },
      "publisher-key": {
        credential_id: "mnemosyne-orchestrator",
        principal_id: "orchestrator",
        project_ids: ["project-infinitum"]
      },
      "root-key": {
        credential_id: "root-scoped",
        principal_id: "root",
        project_ids: ["project-infinitum"]
      }
    },
    ...overrides
  };
}

function post(path, body, key = "publisher-key") {
  return new Request(`https://worker.invalid${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": key
    },
    body: JSON.stringify(body)
  });
}

async function seedPublishedBase(db) {
  const payload = {
    schema: RUNWAY_SCHEMA,
    runway_id: "rwy_base",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    generation: 1,
    predecessor_runway_id: null,
    source_invocation_id: "inv_base",
    objective: "Base continuity",
    operational_state: "Published base",
    decisions_in_force: [],
    open_threads: [],
    next_actions: [],
    mounted_skills: [],
    relevant_agents: [],
    relevant_files: [],
    knowledge_references: [],
    library_references: [],
    pending_handoffs: [],
    constraints: [],
    prohibited_assumptions: [],
    integrity_warnings: [],
    source_hashes: [],
    created_at: "2026-07-15T00:00:00.000Z"
  };
  const manifest = await buildRunwayManifest({ payload, sourceHashes: [] });
  const row = {
    runway_id: "rwy_base",
    schema_version: RUNWAY_SCHEMA,
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    predecessor_runway_id: null,
    source_invocation_id: "inv_base",
    generation: 1,
    state: "published",
    context_status: "current",
    objective: payload.objective,
    summary: payload.operational_state,
    payload_json: canonicalJson(payload),
    manifest_hash: manifest.manifest_hash,
    source_hashes_json: "[]",
    integrity_state: "verified",
    completeness_score: 0.25,
    created_by_credential_id: "ariadne",
    idempotency_key: "base-idempotency",
    indexing_state: "complete",
    created_at: payload.created_at,
    published_at: payload.created_at
  };
  db.seedRunway(row).seedHead({
    identity_id: row.identity_id,
    project_id: row.project_id,
    scope_key: row.scope_key,
    runway_id: row.runway_id,
    generation: row.generation,
    manifest_hash: row.manifest_hash,
    published_at: row.published_at
  });
  return row;
}

async function createAndValidate(worker, environment, idempotencyKey = "candidate-publish-1") {
  const created = await worker.fetch(post("/v1/continuity/checkpoints", {
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    predecessor_runway_id: "rwy_base",
    source_invocation_id: `inv_${idempotencyKey}`,
    payload: proposal(),
    source_hashes: [],
    idempotency_key: idempotencyKey
  }, "specialist-key"), environment);
  assert.equal(created.status, 201);
  const runwayId = (await created.json()).runway_id;
  const validated = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/validate`,
    {}
  ), environment);
  assert.equal(validated.status, 200);
  return runwayId;
}

test("validated candidate publishes with compare-and-swap and duplicate delivery is idempotent", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  await seedPublishedBase(db);
  const environment = env(db);
  const runwayId = await createAndValidate(worker, environment);
  const body = {
    expected_generation: 1,
    expected_predecessor_runway_id: "rwy_base"
  };
  const first = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/publish`,
    body
  ), environment);
  const firstPayload = await first.json();
  const second = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/publish`,
    body
  ), environment);
  const secondPayload = await second.json();

  assert.equal(first.status, 200);
  assert.equal(firstPayload.state, "published");
  assert.equal(firstPayload.generation, 2);
  assert.equal(db.runways.get(runwayId).state, "published");
  assert.equal(db.runways.get("rwy_base").state, "superseded");
  assert.equal(second.status, 200);
  assert.equal(secondPayload.idempotent_replay, true);
  assert.equal([...db.heads.values()][0].runway_id, runwayId);
});

test("publication requires a passed validation and an explicit publication flag", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  await seedPublishedBase(db);
  const environment = env(db);
  const created = await worker.fetch(post("/v1/continuity/checkpoints", {
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    predecessor_runway_id: "rwy_base",
    source_invocation_id: "inv_unvalidated",
    payload: proposal(),
    source_hashes: [],
    idempotency_key: "candidate-unvalidated"
  }, "specialist-key"), environment);
  const runwayId = (await created.json()).runway_id;
  const unvalidated = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/publish`,
    { expected_generation: 1, expected_predecessor_runway_id: "rwy_base" }
  ), environment);
  const disabled = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/publish`,
    { expected_generation: 1, expected_predecessor_runway_id: "rwy_base" }
  ), env(db, { CONTINUITY_PUBLICATION_ENABLED: "false" }));

  assert.equal(unvalidated.status, 422);
  assert.equal(disabled.status, 503);
  assert.equal([...db.heads.values()][0].runway_id, "rwy_base");
});

test("required artifact or indexing failure cannot advance the head", async () => {
  const worker = await loadWorker();

  for (const failure of ["artifact", "indexing"]) {
    const db = new ContinuityMemoryD1();
    await seedPublishedBase(db);
    const overrides = failure === "artifact"
      ? {
          CONTINUITY_ARTIFACT_REQUIRED: "true",
          CONTINUITY_ARTIFACTS: {
            async put() { throw new Error("private artifact failure"); }
          }
        }
      : {
          CONTINUITY_INDEX_REQUIRED: "true",
          AI: { async run() { throw new Error("private provider failure"); } },
          MATRIX_KNOWLEDGE: { async upsert() {} }
        };
    const environment = env(db, overrides);
    const runwayId = await createAndValidate(worker, environment, `candidate-${failure}`);
    const response = await worker.fetch(post(
      `/v1/continuity/checkpoints/${runwayId}/publish`,
      { expected_generation: 1, expected_predecessor_runway_id: "rwy_base" }
    ), environment);
    const result = await response.json();

    assert.equal(response.status, 502, failure);
    assert.equal(result.error, failure === "artifact"
      ? "portable_artifact_failed"
      : "continuity_indexing_failed");
    assert.equal([...db.heads.values()][0].runway_id, "rwy_base");
    assert.equal(db.runways.get(runwayId).state, "publication_failed");
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("concurrent successors are retained and last-write-wins is rejected", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  await seedPublishedBase(db);
  const environment = env(db);
  const firstId = await createAndValidate(worker, environment, "candidate-concurrent-a");
  const secondId = await createAndValidate(worker, environment, "candidate-concurrent-b");
  const expected = {
    expected_generation: 1,
    expected_predecessor_runway_id: "rwy_base"
  };
  const first = await worker.fetch(post(
    `/v1/continuity/checkpoints/${firstId}/publish`, expected
  ), environment);
  const second = await worker.fetch(post(
    `/v1/continuity/checkpoints/${secondId}/publish`, expected
  ), environment);

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "publication_conflict");
  assert.equal(db.runways.has(firstId), true);
  assert.equal(db.runways.has(secondId), true);
  assert.equal([...db.heads.values()][0].runway_id, firstId);
  assert.equal([...db.attempts.values()].some(row => row.status === "conflict"), true);
});

test("D1 compare-and-swap failure preserves the predecessor head and records failure", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  await seedPublishedBase(db);
  const environment = env(db);
  const runwayId = await createAndValidate(worker, environment, "candidate-d1-failure");
  db.failNext("publish-head-cas");
  const response = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/publish`,
    { expected_generation: 1, expected_predecessor_runway_id: "rwy_base" }
  ), environment);

  assert.equal(response.status, 503);
  assert.equal([...db.heads.values()][0].runway_id, "rwy_base");
  assert.equal(db.runways.get(runwayId).state, "publication_failed");
  assert.equal([...db.attempts.values()].some(row => row.status === "failed"), true);
});

test("invalidation preserves history and atomically restores the predecessor", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  await seedPublishedBase(db);
  const environment = env(db);
  const runwayId = await createAndValidate(worker, environment, "candidate-invalidate");
  await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/publish`,
    { expected_generation: 1, expected_predecessor_runway_id: "rwy_base" }
  ), environment);

  const invalidated = await worker.fetch(post(
    `/v1/continuity/checkpoints/${runwayId}/invalidate`,
    { reason: "Verified source integrity failure" },
    "root-key"
  ), environment);
  const result = await invalidated.json();

  assert.equal(invalidated.status, 200);
  assert.equal(result.state, "invalidated");
  assert.equal(result.restored_head_runway_id, "rwy_base");
  assert.equal(db.runways.get(runwayId).state, "invalidated");
  assert.equal(db.runways.get("rwy_base").state, "published");
  assert.equal([...db.heads.values()][0].runway_id, "rwy_base");
  assert.equal(db.invalidations.size, 1);
});
