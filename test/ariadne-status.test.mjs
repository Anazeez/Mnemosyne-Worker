import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  scopedEnvironment
} from "./helpers/worker-harness.mjs";

test("status returns only the minimized review-mode contract", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    authenticatedRequest("/api/ariadne/core/status"),
    scopedEnvironment("specialist", {
      OPENAI_API_KEY: "must-not-be-reflected",
      OPENAI_MODEL: "must-not-be-reflected",
      DB: {},
      MATRIX_ARTIFACTS: {},
      MATRIX_EMAIL_QUEUE: {}
    })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    service: "ariadne.core",
    mode: "review-first",
    intakeEnabled: true,
    reviewEnabled: true,
    vaultMutationAllowed: false
  });

  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of [
    "model", "provider", "endpoint", "credential", "principal",
    "binding", "configured", "database", "queue", "artifact"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked status field: ${forbidden}`);
  }
});

test("status authentication and authorization failures are structured", async () => {
  const worker = await loadWorker();
  const unauthenticated = await worker.fetch(
    new Request("https://worker.invalid/api/ariadne/core/status"),
    {}
  );
  assert.equal(unauthenticated.status, 401);

  const denied = await worker.fetch(
    authenticatedRequest("/api/ariadne/core/status"),
    scopedEnvironment("portal")
  );
  assert.equal(denied.status, 403);
  assert.equal(
    (await denied.json()).error,
    "Role lacks capability: ariadne.core.openai_test"
  );
});
