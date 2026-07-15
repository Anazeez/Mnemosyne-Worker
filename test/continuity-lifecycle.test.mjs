import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RUNWAY_SCHEMA,
  buildRunwayManifest,
  canonicalJson
} from "../src/continuity.js";
import { buildBackfillRequests } from "../scripts/backfill-context-runways.mjs";
import { loadWorker } from "./helpers/worker-harness.mjs";
import { ContinuityMemoryD1 } from "./helpers/d1-continuity-memory.mjs";

async function databaseWithHead() {
  const payload = {
    schema: RUNWAY_SCHEMA,
    runway_id: "rwy_lifecycle",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    generation: 4,
    predecessor_runway_id: "rwy_lifecycle_previous",
    source_invocation_id: "inv_previous",
    objective: "Continue lifecycle work",
    operational_state: "Exact context is available",
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
    created_at: "2026-07-15T10:00:00.000Z"
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
    completeness_score: 0.25,
    created_by_credential_id: "ariadne",
    idempotency_key: "lifecycle-head",
    indexing_state: "complete",
    created_at: payload.created_at,
    published_at: payload.created_at
  };
  return new ContinuityMemoryD1().seedRunway(row).seedHead({
    identity_id: row.identity_id,
    project_id: row.project_id,
    scope_key: row.scope_key,
    runway_id: row.runway_id,
    generation: row.generation,
    manifest_hash: row.manifest_hash,
    published_at: row.published_at
  });
}

function environment(db, overrides = {}) {
  return {
    DB: db,
    CONTINUITY_READ_ENABLED: "true",
    CONTINUITY_WRITE_ENABLED: "true",
    MATRIX_PRINCIPAL_KEYS: {
      "specialist-key": {
        credential_id: "ariadne",
        principal_id: "specialist",
        project_ids: ["project-infinitum"]
      }
    },
    CONTINUITY_SERVICE_PRINCIPAL: {
      credential_id: "continuity-service",
      principal_id: "orchestrator",
      project_ids: ["project-infinitum"]
    },
    ...overrides
  };
}

function post(path, body) {
  return new Request(`https://worker.invalid${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": "specialist-key"
    },
    body: JSON.stringify(body)
  });
}

test("rehydration records invocation acknowledgment and unchanged completion", async () => {
  const worker = await loadWorker();
  const db = await databaseWithHead();
  const env = environment(db);
  const rehydrated = await worker.fetch(post("/v1/continuity/rehydrate", {
    invocation_id: "inv_lifecycle_1",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture"
  }), env);
  const rehydration = await rehydrated.json();

  assert.equal(rehydrated.status, 200);
  assert.deepEqual(rehydration.invocation, {
    invocation_id: "inv_lifecycle_1",
    runway_acknowledged: true,
    runway_id: "rwy_lifecycle",
    generation: 4,
    context_status: "CURRENT_CONTEXT"
  });
  assert.equal(db.invocations.get("inv_lifecycle_1").state, "rehydrated");

  const completed = await worker.fetch(post(
    "/v1/continuity/invocations/inv_lifecycle_1/complete",
    { continuity_changed: false }
  ), env);
  const completion = await completed.json();
  assert.equal(completed.status, 200);
  assert.equal(completion.continuity_outcome, "unchanged");
  assert.equal(db.invocations.get("inv_lifecycle_1").state, "completed");
});

test("changed completion creates a successor candidate while failure remains explicit", async () => {
  const worker = await loadWorker();
  const db = await databaseWithHead();
  const env = environment(db);

  for (const invocationId of ["inv_changed", "inv_failed"]) {
    await worker.fetch(post("/v1/continuity/rehydrate", {
      invocation_id: invocationId,
      identity_id: "ariadne",
      project_id: "project-infinitum",
      scope_key: "architecture"
    }), env);
  }

  const changed = await worker.fetch(post(
    "/v1/continuity/invocations/inv_changed/complete",
    {
      continuity_changed: true,
      predecessor_runway_id: "rwy_lifecycle",
      checkpoint_payload: {
        objective: "Continue lifecycle work",
        operational_state: "A successor candidate was requested",
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
        integrity_warnings: []
      },
      source_hashes: [],
      idempotency_key: "completion-inv-changed"
    }
  ), env);
  const failed = await worker.fetch(post(
    "/v1/continuity/invocations/inv_failed/complete",
    { checkpoint_failed: true }
  ), env);

  assert.equal(changed.status, 200);
  assert.match((await changed.json()).candidate_runway_id, /^rwy_/);
  assert.equal(db.invocations.get("inv_changed").continuity_outcome, "changed");
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).continuity_outcome, "checkpoint_failed");
  assert.equal(db.invocations.get("inv_failed").state, "failed");
});

test("shadow mode compares exact continuity with supplemental evidence without replacing it", async () => {
  const worker = await loadWorker();
  const db = await databaseWithHead();
  const response = await worker.fetch(post("/v1/continuity/rehydrate", {
    invocation_id: "inv_shadow",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    shadow_query: "older context",
    supplemental_domains: ["knowledge"]
  }), environment(db, {
    CONTINUITY_SHADOW_MODE: "true",
    AI: { async run() { return { data: [[0.1]] }; } },
    MATRIX_KNOWLEDGE: {
      async query() {
        return { matches: [{
          id: "old-result",
          score: 0.98,
          metadata: { preview: "older context", created: "2025-01-01" }
        }] };
      }
    }
  }));
  const result = await response.json();

  assert.equal(result.context.runway_id, "rwy_lifecycle");
  assert.equal(result.shadow.enabled, true);
  assert.equal(result.shadow.exact_runway_id, "rwy_lifecycle");
  assert.equal(result.shadow.legacy_top_result_id, "old-result");
  assert.equal(result.shadow.behavior_changed, false);
});

test("continuity queue validation and scheduled verification are flag-gated and idempotent", async () => {
  const worker = await loadWorker();
  const db = await databaseWithHead();
  const env = environment(db, { CONTINUITY_SCHEDULED_VERIFICATION: "true" });
  const head = [...db.heads.values()][0];
  const row = db.runways.get(head.runway_id);
  row.state = "candidate";
  db.heads.clear();
  const acknowledgments = [];
  const message = {
    id: "queue-continuity-1",
    body: { type: "continuity.validate", runway_id: row.runway_id },
    ack() { acknowledgments.push("ack"); },
    retry() { acknowledgments.push("retry"); }
  };
  await worker.queue({ messages: [message] }, env);
  assert.deepEqual(acknowledgments, ["ack"]);
  assert.equal(db.validations.size, 1);

  const waits = [];
  worker.scheduled({}, env, { waitUntil(promise) { waits.push(promise); } });
  await Promise.all(waits);
  assert.equal(waits.length, 1);

  const disabledWaits = [];
  worker.scheduled({}, environment(db), {
    waitUntil(promise) { disabledWaits.push(promise); }
  });
  assert.equal(disabledWaits.length, 0);
});

test("telemetry is bounded and never includes checkpoint bodies", async () => {
  const worker = await loadWorker();
  const db = await databaseWithHead();
  const points = [];
  await worker.fetch(post("/v1/continuity/rehydrate", {
    invocation_id: "inv_metrics",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture"
  }), environment(db, {
    CONTINUITY_TELEMETRY: {
      writeDataPoint(point) { points.push(point); }
    }
  }));

  assert.equal(points.some(point => point.metric === "continuity.resolve.success"), true);
  assert.equal(points.some(point => point.metric === "continuity.rehydrate.duration_ms"), true);
  assert.equal(JSON.stringify(points).includes("Exact context is available"), false);
  assert.equal(points.every(point => !Object.hasOwn(point, "payload")), true);
});

test("invocation enforcement requires an eligible exact-resolution receipt at Ariadne intake", async () => {
  const worker = await loadWorker();
  const db = await databaseWithHead();
  const env = environment(db, {
    CONTINUITY_INVOCATION_ENFORCEMENT: "true",
    OPENAI_API_KEY: "test-provider-key",
    OPENAI_MODEL: "test-model"
  });
  const intakeBody = {
    title: "Continuity review",
    content: "Review exact contextual continuity.",
    source: "obsidian-plugin",
    metadata: { vaultPath: "Inbox/continuity.md", originalLocation: "Inbox" },
    reviewFirst: true
  };
  const denied = await worker.fetch(post("/api/ariadne/core/intake", intakeBody), env);
  assert.equal(denied.status, 428);
  assert.equal((await denied.json()).error, "continuity_receipt_required");

  const rehydrated = await worker.fetch(post("/v1/continuity/rehydrate", {
    invocation_id: "inv_enforced",
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture"
  }), env);
  const receiptId = (await rehydrated.json()).retrieval_receipt_id;
  let providerCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalled = true;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      classification: "continuity-review",
      summary: "Receipt verified.",
      proposedDestination: "Projects/Mnemosyne",
      proposedTags: [],
      proposedLinks: [],
      warnings: []
    }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const allowed = await worker.fetch(new Request(
      "https://worker.invalid/api/ariadne/core/intake",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Matrix-Key": "specialist-key",
          "X-Continuity-Receipt": receiptId
        },
        body: JSON.stringify(intakeBody)
      }
    ), env);
    assert.equal(allowed.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerCalled, true);
});

test("Obsidian checkpoint submission remains separately feature-gated", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  const body = {
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    predecessor_runway_id: null,
    source_invocation_id: "inv_obsidian",
    source: "obsidian-plugin",
    payload: {
      objective: "Review an Obsidian checkpoint",
      operational_state: "User explicitly submitted a reviewed proposal",
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
      integrity_warnings: []
    },
    source_hashes: [],
    idempotency_key: "obsidian-reviewed-1"
  };
  const disabled = await worker.fetch(post("/v1/continuity/checkpoints", body), environment(db));
  const enabled = await worker.fetch(post("/v1/continuity/checkpoints", body), environment(db, {
    CONTINUITY_OBSIDIAN_ACTIONS: "true"
  }));

  assert.equal(disabled.status, 503);
  assert.equal(enabled.status, 201);
});

test("backfill compilation is deterministic, marked backfilled, and dry-run by default", () => {
  const manifest = [{
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    source_invocation_id: "inv_backfill",
    objective: "Backfill reliable context",
    operational_state: "Source history is incomplete",
    confidence: 0.6,
    missing_sources: ["earlier thread"]
  }];
  const first = buildBackfillRequests(manifest);
  const second = buildBackfillRequests(structuredClone(manifest));

  assert.deepEqual(first, second);
  assert.equal(first[0].payload.context_status, "backfilled");
  assert.equal(first[0].payload.integrity_warnings.includes("earlier thread"), true);
  assert.equal(first[0].apply, false);
});

test("all feature flags are documented and no Wrangler trigger activates them", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const wrangler = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  const flags = [
    "CONTINUITY_READ_ENABLED",
    "CONTINUITY_WRITE_ENABLED",
    "CONTINUITY_SHADOW_MODE",
    "CONTINUITY_PUBLICATION_ENABLED",
    "CONTINUITY_INVOCATION_ENFORCEMENT",
    "CONTINUITY_SCHEDULED_VERIFICATION",
    "CONTINUITY_OBSIDIAN_ACTIONS"
  ];

  for (const flag of flags) assert.equal(readme.includes(flag), true, flag);
  assert.doesNotMatch(wrangler, /\[triggers\]|crons\s*=/i);
});
