import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNWAY_SCHEMA,
  buildRunwayManifest,
  canonicalJson
} from "../src/continuity.js";
import { loadWorker } from "./helpers/worker-harness.mjs";
import { ContinuityMemoryD1 } from "./helpers/d1-continuity-memory.mjs";

async function seededDatabase({ publishedAt = "2026-07-15T10:00:00.000Z" } = {}) {
  const payload = {
    schema: RUNWAY_SCHEMA,
    runway_id: "rwy_current",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    generation: 8,
    predecessor_runway_id: "rwy_previous",
    source_invocation_id: "inv_current",
    objective: "Implement deterministic continuity",
    operational_state: "The current exact runway is generation eight",
    decisions_in_force: [{
      id: "decision_exact_first",
      summary: "Exact context precedes semantic search",
      source_ref: "card:MNEM-CONTINUITY-002"
    }],
    open_threads: [],
    next_actions: ["Verify rehydration"],
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
    created_at: "2026-07-15T09:00:00.000Z"
  };
  const manifest = await buildRunwayManifest({ payload, sourceHashes: [] });
  const row = {
    runway_id: payload.runway_id,
    schema_version: RUNWAY_SCHEMA,
    identity_id: payload.identity_id,
    project_id: payload.project_id,
    scope_key: payload.scope_key,
    predecessor_runway_id: payload.predecessor_runway_id,
    source_invocation_id: payload.source_invocation_id,
    generation: payload.generation,
    state: "published",
    context_status: "current",
    objective: payload.objective,
    summary: payload.operational_state,
    payload_json: canonicalJson(payload),
    manifest_hash: manifest.manifest_hash,
    source_hashes_json: "[]",
    integrity_state: "verified",
    completeness_score: 0.5,
    created_by_credential_id: "ariadne",
    idempotency_key: "rehydration-fixture",
    indexing_state: "complete",
    created_at: payload.created_at,
    published_at: publishedAt
  };
  const db = new ContinuityMemoryD1().seedRunway(row).seedHead({
    identity_id: row.identity_id,
    project_id: row.project_id,
    scope_key: row.scope_key,
    runway_id: row.runway_id,
    generation: row.generation,
    manifest_hash: row.manifest_hash,
    published_at: row.published_at
  });
  db.records.push(
    {
      runway_id: row.runway_id,
      record_id: "knowledge_current",
      domain: "knowledge",
      record_type: "decision",
      source_ref: "card:MNEM-CONTINUITY-002",
      source_hash: "a".repeat(64),
      relation: "decision_source",
      ordinal: 0,
      created_at: payload.created_at
    },
    {
      runway_id: row.runway_id,
      record_id: "file_private",
      domain: "files",
      record_type: "file",
      source_ref: "file:private.md",
      source_hash: "b".repeat(64),
      relation: "relevant_file",
      ordinal: 1,
      created_at: payload.created_at
    }
  );
  return db;
}

function environment(db, overrides = {}) {
  return {
    DB: db,
    CONTINUITY_READ_ENABLED: "true",
    MATRIX_PRINCIPAL_KEYS: {
      "specialist-key": {
        credential_id: "ariadne",
        principal_id: "specialist",
        project_ids: ["project-infinitum"],
        memory_domains: ["knowledge"]
      },
      "inspector-key": {
        credential_id: "continuity-inspector",
        principal_id: "inspector",
        project_ids: ["project-infinitum"],
        identity_ids: ["ariadne"]
      }
    },
    ...overrides
  };
}

function rehydrateRequest(body = {}, key = "specialist-key") {
  return new Request("https://worker.invalid/v1/continuity/rehydrate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": key
    },
    body: JSON.stringify({
      identity_id: "ariadne",
      project_id: "project-infinitum",
      scope_key: "architecture",
      ...body
    })
  });
}

test("rehydration returns exact runway and authorized references without probabilistic calls", async () => {
  const worker = await loadWorker();
  const db = await seededDatabase();
  let aiCalls = 0;
  const response = await worker.fetch(rehydrateRequest(), environment(db, {
    AI: { async run() { aiCalls += 1; } }
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.context.runway_id, "rwy_current");
  assert.equal(result.context.status, "CURRENT_CONTEXT");
  assert.equal(result.context.payload.objective, "Implement deterministic continuity");
  assert.deepEqual(result.context.authorized_references.map(item => item.record_id), [
    "knowledge_current"
  ]);
  assert.deepEqual(result.omissions, [{
    record_id: "file_private",
    domain: "files",
    reason: "domain_not_permitted"
  }]);
  assert.deepEqual(result.supplemental, { used: false, results: [], errors: [] });
  assert.equal(aiCalls, 0);
});

test("older higher-scoring semantic evidence remains supplemental and separate", async () => {
  const worker = await loadWorker();
  const db = await seededDatabase();
  let queryOptions;
  const response = await worker.fetch(rehydrateRequest({
    supplemental_query: "continuity architecture",
    supplemental_domains: ["knowledge", "files"],
    top_k: 5
  }), environment(db, {
    AI: { async run() { return { data: [[0.1, 0.2]] }; } },
    MATRIX_KNOWLEDGE: {
      async query(_vector, options) {
        queryOptions = options;
        return {
          matches: [{
            id: "old-high-score",
            score: 0.99,
            metadata: {
              file: "old.md",
              path: "History/old.md",
              sha256: "c".repeat(64),
              preview: "Older but highly similar context",
              project_id: "project-infinitum",
              scope_key: "architecture",
              created: "2025-01-01T00:00:00.000Z",
              source_ref: "file:old.md"
            }
          }]
        };
      }
    }
  }));
  const result = await response.json();

  assert.equal(result.context.runway_id, "rwy_current");
  assert.equal(result.context.payload.operational_state.includes("generation eight"), true);
  assert.equal(result.supplemental.used, true);
  assert.equal(result.supplemental.results[0].id, "old-high-score");
  assert.equal(result.supplemental.results[0].score, 0.99);
  assert.equal(result.supplemental.results[0].preview.includes("Older"), true);
  assert.equal(result.supplemental.results[0].runway_id ?? null, null);
  assert.equal(queryOptions.topK, 5);
  assert.deepEqual(result.requested_domains, ["knowledge", "files"]);
  assert.deepEqual(result.permitted_domains, ["knowledge"]);
});

test("supplemental failure is bounded and cannot erase exact context", async () => {
  const worker = await loadWorker();
  const db = await seededDatabase();
  const response = await worker.fetch(rehydrateRequest({
    supplemental_query: "continuity",
    supplemental_domains: ["knowledge"]
  }), environment(db, {
    AI: { async run() { throw new Error("private provider details"); } }
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.context.runway_id, "rwy_current");
  assert.equal(result.supplemental.used, true);
  assert.deepEqual(result.supplemental.results, []);
  assert.deepEqual(result.supplemental.errors, [{ code: "supplemental_search_unavailable" }]);
  assert.equal(JSON.stringify(result).includes("private provider"), false);
});

test("stale and missing exact context remain explicit during rehydration", async () => {
  const worker = await loadWorker();
  const staleDb = await seededDatabase({ publishedAt: "2026-01-01T00:00:00.000Z" });
  const stale = await worker.fetch(rehydrateRequest(), environment(staleDb));
  const missing = await worker.fetch(rehydrateRequest(), environment(new ContinuityMemoryD1()));

  assert.equal((await stale.json()).context.status, "STALE_CONTEXT");
  assert.equal((await missing.json()).context.status, "NO_CONTEXT");
});

test("audit routes require continuity.audit and preserve bounded lineage", async () => {
  const worker = await loadWorker();
  const db = await seededDatabase();
  const denied = await worker.fetch(new Request(
    "https://worker.invalid/v1/continuity/history?identity_id=ariadne&project_id=project-infinitum&scope_key=architecture",
    { headers: { "X-Matrix-Key": "specialist-key" } }
  ), environment(db));
  const allowed = await worker.fetch(new Request(
    "https://worker.invalid/v1/continuity/history?identity_id=ariadne&project_id=project-infinitum&scope_key=architecture",
    { headers: { "X-Matrix-Key": "inspector-key" } }
  ), environment(db));
  const history = await allowed.json();

  assert.equal(denied.status, 403);
  assert.equal(allowed.status, 200);
  assert.equal(history.runways.length, 1);
  assert.equal(history.runways[0].runway_id, "rwy_current");
  assert.equal(Object.hasOwn(history.runways[0], "payload_json"), false);
});
