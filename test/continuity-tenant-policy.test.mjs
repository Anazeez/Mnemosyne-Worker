import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNWAY_SCHEMA,
  buildRunwayManifest,
  canonicalJson
} from "../src/continuity.js";
import { loadWorker } from "./helpers/worker-harness.mjs";
import { ContinuityMemoryD1 } from "./helpers/d1-continuity-memory.mjs";

async function runway(tenantId) {
  const payload = {
    schema: RUNWAY_SCHEMA,
    runway_id: `${tenantId}-runway`,
    identity_id: "assistant",
    project_id: "shared",
    scope_key: "project",
    generation: 1,
    predecessor_runway_id: null,
    source_invocation_id: null,
    objective: tenantId,
    operational_state: `${tenantId} exact context`,
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
    created_at: "2026-07-27T00:00:00.000Z"
  };
  const manifest = await buildRunwayManifest({ payload, sourceHashes: [] });
  return {
    tenant_id: tenantId,
    runway_id: payload.runway_id,
    schema_version: RUNWAY_SCHEMA,
    identity_id: payload.identity_id,
    project_id: payload.project_id,
    scope_key: payload.scope_key,
    predecessor_runway_id: null,
    source_invocation_id: null,
    generation: 1,
    state: "published",
    context_status: "current",
    objective: tenantId,
    summary: payload.operational_state,
    payload_json: canonicalJson(payload),
    manifest_hash: manifest.manifest_hash,
    source_hashes_json: "[]",
    integrity_state: "verified",
    completeness_score: 0.5,
    created_by_credential_id: `${tenantId}-portal`,
    idempotency_key: `${tenantId}-runway-key`,
    indexing_state: "complete",
    created_at: payload.created_at,
    published_at: payload.created_at
  };
}

function head(row) {
  return {
    tenant_id: row.tenant_id,
    identity_id: row.identity_id,
    project_id: row.project_id,
    scope_key: row.scope_key,
    runway_id: row.runway_id,
    generation: row.generation,
    manifest_hash: row.manifest_hash,
    published_at: row.published_at
  };
}

function request(key) {
  const url = new URL("https://worker.invalid/v1/continuity/latest");
  url.searchParams.set("identity_id", "assistant");
  url.searchParams.set("project_id", "shared");
  url.searchParams.set("scope_key", "project");
  return new Request(url, { headers: { "X-Matrix-Key": key } });
}

test("continuity resolution is isolated by authenticated tenant", async t => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-07-27T12:00:00.000Z")
  });
  const worker = await loadWorker();
  const tenantA = await runway("tenant-a");
  const tenantB = await runway("tenant-b");
  const db = new ContinuityMemoryD1()
    .seedRunway(tenantA)
    .seedHead(head(tenantA))
    .seedRunway(tenantB)
    .seedHead(head(tenantB));
  const env = {
    DB: db,
    CONTINUITY_READ_ENABLED: "true",
    MATRIX_PRINCIPAL_KEYS: {
      "tenant-a-key": {
        tenant_id: "tenant-a",
        credential_id: "tenant-a-portal",
        principal_id: "portal",
        project_ids: ["shared"],
        identity_ids: ["assistant"]
      },
      "tenant-b-key": {
        tenant_id: "tenant-b",
        credential_id: "tenant-b-portal",
        principal_id: "portal",
        project_ids: ["shared"],
        identity_ids: ["assistant"]
      }
    }
  };

  const responseA = await worker.fetch(request("tenant-a-key"), env);
  const responseB = await worker.fetch(request("tenant-b-key"), env);
  const resultA = await responseA.json();
  const resultB = await responseB.json();

  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.equal(resultA.context.runway_id, "tenant-a-runway");
  assert.equal(resultB.context.runway_id, "tenant-b-runway");
  assert.equal(resultA.context.tenant_id, "tenant-a");
  assert.equal(resultB.context.tenant_id, "tenant-b");
});
