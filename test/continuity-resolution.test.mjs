import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNWAY_SCHEMA,
  buildRunwayManifest,
  canonicalJson
} from "../src/continuity.js";
import { loadWorker, migrateTestPrincipalEnvironment } from "./helpers/worker-harness.mjs";
import { ContinuityMemoryD1 } from "./helpers/d1-continuity-memory.mjs";

function payload(overrides = {}) {
  return {
    schema: RUNWAY_SCHEMA,
    runway_id: "rwy_exact",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    generation: 3,
    predecessor_runway_id: "rwy_previous",
    source_invocation_id: "inv_exact",
    objective: "Continue exact work",
    operational_state: "The current implementation is deterministic",
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
    created_at: "2026-07-15T10:00:00.000Z",
    ...overrides
  };
}

async function publishedRunway(overrides = {}) {
  const runwayPayload = payload(overrides.payload || {});
  const manifest = await buildRunwayManifest({
    payload: runwayPayload,
    sourceHashes: runwayPayload.source_hashes
  });

  return {
    runway_id: runwayPayload.runway_id,
    schema_version: RUNWAY_SCHEMA,
    identity_id: runwayPayload.identity_id,
    project_id: runwayPayload.project_id,
    scope_key: runwayPayload.scope_key,
    predecessor_runway_id: runwayPayload.predecessor_runway_id,
    source_invocation_id: runwayPayload.source_invocation_id,
    generation: runwayPayload.generation,
    state: "published",
    context_status: "current",
    objective: runwayPayload.objective,
    summary: runwayPayload.operational_state,
    payload_json: canonicalJson(runwayPayload),
    manifest_hash: manifest.manifest_hash,
    source_hashes_json: canonicalJson(runwayPayload.source_hashes),
    integrity_state: "verified",
    completeness_score: 0.5,
    created_by_credential_id: "ariadne",
    idempotency_key: `key-${runwayPayload.runway_id}`,
    indexing_state: "complete",
    created_at: runwayPayload.created_at,
    published_at: "2026-07-15T10:00:00.000Z",
    ...overrides,
    payload_json: overrides.payload_json || canonicalJson(runwayPayload),
    manifest_hash: overrides.manifest_hash || manifest.manifest_hash,
    source_hashes_json: overrides.source_hashes_json || canonicalJson(runwayPayload.source_hashes)
  };
}

function headFrom(row, overrides = {}) {
  return {
    identity_id: row.identity_id,
    project_id: row.project_id,
    scope_key: row.scope_key,
    runway_id: row.runway_id,
    generation: row.generation,
    manifest_hash: row.manifest_hash,
    published_at: row.published_at,
    ...overrides
  };
}

function environment(db, overrides = {}) {
  let aiCalls = 0;
  let vectorCalls = 0;
  const env = {
    DB: db,
    CONTINUITY_READ_ENABLED: "true",
    CONTINUITY_FRESHNESS_SECONDS: "604800",
    MATRIX_PRINCIPAL_KEYS: {
      "specialist-key-with-entropy": {
        credential_id: "ariadne",
        principal_id: "specialist",
        project_ids: ["project-infinitum"]
      }
    },
    AI: {
      async run() {
        aiCalls += 1;
        throw new Error("AI must not run during exact resolution");
      }
    },
    MATRIX_KNOWLEDGE: {
      async query() {
        vectorCalls += 1;
        throw new Error("Vectorize must not run during exact resolution");
      }
    },
    ...overrides
  };

  return {
    env: migrateTestPrincipalEnvironment(env),
    calls: () => ({ ai: aiCalls, vector: vectorCalls })
  };
}

function latestRequest(scopeKey = "architecture") {
  const url = new URL("https://worker.invalid/v1/continuity/latest");
  url.searchParams.set("identity_id", "ariadne");
  url.searchParams.set("project_id", "project-infinitum");
  url.searchParams.set("scope_key", scopeKey);

  return new Request(url, {
    headers: { "X-Matrix-Key": "specialist-key-with-entropy" }
  });
}

test("exact current head is verified without AI or Vectorize", async t => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-07-16T10:00:00.000Z")
  });
  const worker = await loadWorker();
  const row = await publishedRunway();
  const db = new ContinuityMemoryD1().seedRunway(row).seedHead(headFrom(row));
  const { env, calls } = environment(db);
  const response = await worker.fetch(latestRequest(), env);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.context.status, "CURRENT_CONTEXT");
  assert.equal(result.context.runway_id, "rwy_exact");
  assert.equal(result.context.generation, 3);
  assert.equal(result.context.payload.objective, "Continue exact work");
  assert.deepEqual(result.fallback_path, ["exact:hit"]);
  assert.match(result.retrieval_receipt_id, /^receipt_[0-9a-f-]{36}$/);
  assert.equal(db.receipts.size, 1);
  assert.deepEqual(calls(), { ai: 0, vector: 0 });
});

test("missing exact context is explicit and receipt-backed", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  const { env, calls } = environment(db);
  const response = await worker.fetch(latestRequest(), env);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.context.status, "NO_CONTEXT");
  assert.equal(result.context.runway_id, null);
  assert.deepEqual(result.fallback_path, [
    "exact:miss",
    "default:miss",
    "genesis:miss",
    "global:not_permitted",
    "backfill:miss",
    "no_context"
  ]);
  assert.equal(db.receipts.size, 1);
  assert.deepEqual(calls(), { ai: 0, vector: 0 });
});

test("default scope fallback is exact, visible, and degraded", async () => {
  const worker = await loadWorker();
  const row = await publishedRunway({
    payload: { scope_key: "default", runway_id: "rwy_default" },
    scope_key: "default",
    runway_id: "rwy_default"
  });
  const db = new ContinuityMemoryD1().seedRunway(row).seedHead(headFrom(row));
  const { env } = environment(db);
  const response = await worker.fetch(latestRequest("architecture"), env);
  const result = await response.json();

  assert.equal(result.context.runway_id, "rwy_default");
  assert.equal(result.context.status, "DEGRADED_CONTEXT");
  assert.equal(result.context.resolution, "default_scope_fallback");
  assert.deepEqual(result.fallback_path, ["exact:miss", "default:hit"]);
});

test("stale published head remains valid but is never represented as current", async () => {
  const worker = await loadWorker();
  const row = await publishedRunway({
    published_at: "2026-06-01T00:00:00.000Z"
  });
  const db = new ContinuityMemoryD1().seedRunway(row).seedHead(headFrom(row));
  const { env } = environment(db, {
    CONTINUITY_NOW: "2026-07-15T12:00:00.000Z"
  });
  const response = await worker.fetch(latestRequest(), env);
  const result = await response.json();

  assert.equal(result.context.status, "STALE_CONTEXT");
  assert.equal(result.context.reason, "No newer published checkpoint exists");
  assert.equal(result.context.age_seconds > result.context.freshness_limit_seconds, true);
});

test("invalidated, corrupt, missing, or mismatched head targets are quarantined", async () => {
  const worker = await loadWorker();
  const cases = [
    {
      name: "invalidated",
      mutateRow: row => ({ ...row, state: "invalidated" }),
      mutateHead: head => head
    },
    {
      name: "hash",
      mutateRow: row => ({ ...row, manifest_hash: "f".repeat(64) }),
      mutateHead: head => ({ ...head, manifest_hash: "f".repeat(64) })
    },
    {
      name: "generation",
      mutateRow: row => row,
      mutateHead: head => ({ ...head, generation: 99 })
    },
    {
      name: "tuple",
      mutateRow: row => ({ ...row, scope_key: "other" }),
      mutateHead: head => head
    }
  ];

  for (const currentCase of cases) {
    const original = await publishedRunway();
    const row = currentCase.mutateRow(original);
    const head = currentCase.mutateHead(headFrom(original));
    const db = new ContinuityMemoryD1().seedRunway(row).seedHead(head);
    const response = await worker.fetch(latestRequest(), environment(db).env);
    const result = await response.json();
    assert.equal(result.context.status, "QUARANTINED_CONTEXT", currentCase.name);
  }

  const missingDb = new ContinuityMemoryD1().seedHead({
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    runway_id: "rwy_missing",
    generation: 1,
    manifest_hash: "a".repeat(64),
    published_at: "2026-07-15T10:00:00.000Z"
  });
  const missing = await worker.fetch(latestRequest(), environment(missingDb).env);
  assert.equal((await missing.json()).context.status, "QUARANTINED_CONTEXT");
});
