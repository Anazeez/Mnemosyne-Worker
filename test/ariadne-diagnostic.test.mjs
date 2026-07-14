import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  scopedEnvironment,
  withStubbedFetch
} from "./helpers/worker-harness.mjs";

function environment(overrides = {}) {
  return scopedEnvironment("specialist", {
    OPENAI_API_KEY: "private-test-key",
    OPENAI_MODEL: "private-test-model",
    ...overrides
  });
}

test("diagnostic reports reachability without returning provider output", async () => {
  const worker = await loadWorker();
  const response = await withStubbedFetch(
    async () => Response.json({ output_text: "private-provider-output" }),
    () => worker.fetch(
      authenticatedRequest("/api/ariadne/core/openai-test"),
      environment()
    )
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    code: "provider_reachable"
  });
});

test("diagnostic never reflects upstream failure bodies or local configuration", async () => {
  const worker = await loadWorker();
  const sensitive = "private-upstream-body private-test-key private-test-model";
  const response = await withStubbedFetch(
    async () => new Response(sensitive, { status: 500 }),
    () => worker.fetch(
      authenticatedRequest("/api/ariadne/core/openai-test"),
      environment()
    )
  );

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes("private"), false);
  assert.deepEqual(JSON.parse(body), {
    ok: false,
    error: "provider_unavailable"
  });
});

test("diagnostic contains missing configuration behind one bounded code", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    authenticatedRequest("/api/ariadne/core/openai-test"),
    scopedEnvironment("specialist")
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "diagnostic_unavailable"
  });
});

test("diagnostic rejects malformed success payloads without reflecting them", async () => {
  const worker = await loadWorker();
  const response = await withStubbedFetch(
    async () => Response.json({ internal: "private-malformed-payload" }),
    () => worker.fetch(
      authenticatedRequest("/api/ariadne/core/openai-test"),
      environment()
    )
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "provider_invalid_response"
  });
});

test("diagnostic authorization denial is structured and precedes provider access", async () => {
  const worker = await loadWorker();
  let providerCalled = false;
  const response = await withStubbedFetch(async () => {
    providerCalled = true;
    throw new Error("unexpected provider call");
  }, () => worker.fetch(
    authenticatedRequest("/api/ariadne/core/openai-test"),
    scopedEnvironment("inspector")
  ));

  assert.equal(response.status, 403);
  assert.equal(providerCalled, false);
});
