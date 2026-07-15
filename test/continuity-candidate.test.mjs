import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker
} from "./helpers/worker-harness.mjs";
import { ContinuityMemoryD1 } from "./helpers/d1-continuity-memory.mjs";

function basePayload(overrides = {}) {
  return {
    objective: "Continue Ariadne architecture work",
    operational_state: "A deterministic implementation card is active",
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

function candidateBody(overrides = {}) {
  return {
    identity_id: "ariadne",
    project_id: "project-infinitum",
    scope_key: "architecture",
    predecessor_runway_id: null,
    source_invocation_id: "inv_00000000-0000-4000-8000-000000000001",
    payload: basePayload(),
    source_hashes: [],
    idempotency_key: "candidate-key-0001",
    ...overrides
  };
}

function request(path, body, key = "specialist-key") {
  return new Request(`https://worker.invalid${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": key
    },
    body: JSON.stringify(body)
  });
}

function environment(db = new ContinuityMemoryD1(), overrides = {}) {
  return {
    DB: db,
    CONTINUITY_WRITE_ENABLED: "true",
    MATRIX_PRINCIPAL_KEYS: {
      "specialist-key": {
        credential_id: "ariadne",
        principal_id: "specialist",
        project_ids: ["project-infinitum"]
      },
      "other-specialist-key": {
        credential_id: "hearken",
        principal_id: "specialist",
        project_ids: ["project-infinitum"]
      },
      "publisher-key": {
        credential_id: "mnemosyne-orchestrator",
        principal_id: "orchestrator",
        project_ids: ["project-infinitum"]
      }
    },
    ...overrides
  };
}

test("candidate route requires authentication, feature enablement, and continuity.write", async () => {
  const worker = await loadWorker();
  const body = candidateBody();
  const unauthenticated = await worker.fetch(
    new Request("https://worker.invalid/v1/continuity/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    environment()
  );
  const disabled = await worker.fetch(
    request("/v1/continuity/checkpoints", body),
    environment(new ContinuityMemoryD1(), { CONTINUITY_WRITE_ENABLED: "false" })
  );
  const readOnly = await worker.fetch(
    request("/v1/continuity/checkpoints", body, "portal-key"),
    environment(new ContinuityMemoryD1(), {
      MATRIX_PRINCIPAL_KEYS: {
        "portal-key": {
          credential_id: "portal-reader",
          principal_id: "portal",
          project_ids: ["project-infinitum"]
        }
      }
    })
  );

  assert.equal(unauthenticated.status, 401);
  assert.equal(disabled.status, 503);
  assert.equal(readOnly.status, 403);
});

test("specialist writes are limited to their exact identity and explicit project", async () => {
  const worker = await loadWorker();
  const identityMismatch = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody(), "other-specialist-key"),
    environment()
  );
  const projectMismatch = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody({ project_id: "other-project" })),
    environment()
  );

  assert.equal(identityMismatch.status, 403);
  assert.equal((await identityMismatch.json()).error, "continuity_identity_forbidden");
  assert.equal(projectMismatch.status, 403);
  assert.equal((await projectMismatch.json()).error, "continuity_project_forbidden");
});

test("valid candidate receives server-owned identity, generation, hash, and immutable persistence", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  const response = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody()),
    environment(db)
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  assert.match(payload.runway_id, /^rwy_[0-9a-f-]{36}$/);
  assert.equal(payload.state, "candidate");
  assert.equal(payload.generation, 1);
  assert.match(payload.manifest_hash, /^[a-f0-9]{64}$/);
  assert.equal(db.runways.size, 1);

  const stored = db.runways.get(payload.runway_id);
  const storedPayload = JSON.parse(stored.payload_json);
  assert.equal(storedPayload.identity_id, "ariadne");
  assert.equal(storedPayload.project_id, "project-infinitum");
  assert.equal(storedPayload.scope_key, "architecture");
  assert.equal(storedPayload.generation, 1);
  assert.equal(storedPayload.runway_id, payload.runway_id);
  assert.equal(stored.state, "candidate");
});

test("predecessor mismatch and secret-bearing state are rejected without persistence", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  const predecessor = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody({
      predecessor_runway_id: "rwy_00000000-0000-4000-8000-000000000099"
    })),
    environment(db)
  );
  const secret = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody({
      payload: basePayload({
        operational_state: "Bearer this-secret-must-not-be-stored-123456789"
      }),
      idempotency_key: "candidate-key-secret"
    })),
    environment(db)
  );

  assert.equal(predecessor.status, 409);
  assert.equal(secret.status, 422);
  assert.equal(JSON.stringify(await secret.json()).includes("this-secret"), false);
  assert.equal(db.runways.size, 0);
});

test("idempotent replay returns the original candidate without creating another row", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  const env = environment(db);
  const first = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody()),
    env
  );
  const second = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody()),
    env
  );
  const firstPayload = await first.json();
  const secondPayload = await second.json();

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(secondPayload.idempotent_replay, true);
  assert.equal(secondPayload.runway_id, firstPayload.runway_id);
  assert.equal(db.runways.size, 1);
});

test("validation writes a separate receipt and never mutates candidate content", async () => {
  const worker = await loadWorker();
  const db = new ContinuityMemoryD1();
  const env = environment(db);
  const created = await worker.fetch(
    request("/v1/continuity/checkpoints", candidateBody()),
    env
  );
  const runwayId = (await created.json()).runway_id;
  const before = db.runways.get(runwayId).payload_json;
  const validation = await worker.fetch(
    request(`/v1/continuity/checkpoints/${runwayId}/validate`, {}, "publisher-key"),
    env
  );
  const validationPayload = await validation.json();

  assert.equal(validation.status, 200);
  assert.equal(validationPayload.status, "passed");
  assert.match(validationPayload.validation_id, /^val_[0-9a-f-]{36}$/);
  assert.match(validationPayload.receipt_hash, /^[a-f0-9]{64}$/);
  assert.equal(db.validations.size, 1);
  assert.equal(db.runways.get(runwayId).state, "validated");
  assert.equal(db.runways.get(runwayId).payload_json, before);

  const denied = await worker.fetch(
    request(`/v1/continuity/checkpoints/${runwayId}/validate`, {}, "specialist-key"),
    env
  );
  assert.equal(denied.status, 403);
});
