import assert from "node:assert/strict";
import test from "node:test";

import {
  intakeRequest,
  loadWorker,
  openAIResponse,
  scopedEnvironment,
  validIntake,
  validProposal
} from "./helpers/load-worker.mjs";

async function withStubbedFetch(stub, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("accepts the observed consumer envelope and returns a non-mutating review proposal", async () => {
  const worker = await loadWorker();
  let upstreamCalls = 0;

  const response = await withStubbedFetch(async (url, options) => {
    upstreamCalls += 1;
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(options.method, "POST");

    const request = JSON.parse(options.body);
    assert.match(request.messages[1].content, /"source":"obsidian-plugin"/);
    assert.match(request.messages[1].content, /"reviewFirst":true/);
    return openAIResponse(validProposal);
  }, () => worker.fetch(
    intakeRequest(validIntake),
    scopedEnvironment("specialist")
  ));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    reviewFirst: true,
    mutated: false,
    proposal: validProposal
  });
  assert.equal(upstreamCalls, 1);
});

test("rejects unauthenticated intake without calling the upstream service", async () => {
  const worker = await loadWorker();
  let upstreamCalled = false;

  const response = await withStubbedFetch(async () => {
    upstreamCalled = true;
    throw new Error("unexpected upstream call");
  }, () => worker.fetch(
    intakeRequest(validIntake, false),
    scopedEnvironment("specialist")
  ));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Missing action key");
  assert.equal(upstreamCalled, false);
});

test("rejects mutation-oriented intake before calling the upstream service", async () => {
  const worker = await loadWorker();
  let upstreamCalled = false;

  const response = await withStubbedFetch(async () => {
    upstreamCalled = true;
    throw new Error("unexpected upstream call");
  }, () => worker.fetch(
    intakeRequest({ ...validIntake, reviewFirst: false }),
    scopedEnvironment("specialist")
  ));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "review_first_required");
  assert.equal(upstreamCalled, false);
});

for (const role of ["portal", "dashboard", "inspector"]) {
  test(`preserves the ${role} denial as a structured 403 response`, async () => {
    const worker = await loadWorker();

    const response = await worker.fetch(
      intakeRequest(validIntake),
      scopedEnvironment(role)
    );

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(
      payload.error,
      "Role lacks capability: ariadne.core.openai_test"
    );
  });
}

for (const role of ["specialist", "orchestrator"]) {
  test(`preserves the ${role} intake grant`, async () => {
    const worker = await loadWorker();

    const response = await withStubbedFetch(
      async () => openAIResponse(validProposal),
      () => worker.fetch(intakeRequest(validIntake), scopedEnvironment(role))
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).mutated, false);
  });
}

test("maps an upstream rejection to the established 502 contract", async () => {
  const worker = await loadWorker();

  const response = await withStubbedFetch(
    async () => new Response(JSON.stringify({ error: "upstream" }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    }),
    () => worker.fetch(
      intakeRequest(validIntake),
      scopedEnvironment("specialist")
    )
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "openai_request_failed");
});

test("rejects malformed proposal output without reporting a mutation", async () => {
  const worker = await loadWorker();

  const response = await withStubbedFetch(
    async () => openAIResponse({ summary: "incomplete" }),
    () => worker.fetch(
      intakeRequest(validIntake),
      scopedEnvironment("specialist")
    )
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "invalid_openai_output");
});
