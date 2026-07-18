import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  providerChatResponse,
  scopedEnvironment,
  withStubbedFetch
} from "./helpers/worker-harness.mjs";

const validIntake = Object.freeze({
  title: "Clean baseline",
  content: "Review the reconstructed interface.",
  source: "obsidian-plugin",
  metadata: {
    vaultPath: "Inbox/clean-baseline.md",
    originalLocation: "Inbox"
  },
  reviewFirst: true
});

const validProposal = Object.freeze({
  classification: "implementation-review",
  summary: "Reviewable reconstruction.",
  proposedDestination: "Projects/Mnemosyne",
  proposedTags: ["mnemosyne"],
  proposedLinks: ["Clean baseline"],
  warnings: []
});

const intakeResponseFormat = Object.freeze({
  type: "json_schema",
  json_schema: {
    name: "ariadne_intake",
    strict: true,
    schema: {
      type: "object",
      properties: {
        classification: { type: "string" },
        summary: { type: "string" },
        proposedDestination: { type: "string" },
        proposedTags: { type: "array", items: { type: "string" } },
        proposedLinks: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } }
      },
      required: [
        "classification",
        "summary",
        "proposedDestination",
        "proposedTags",
        "proposedLinks",
        "warnings"
      ],
      additionalProperties: false
    }
  }
});

function intakeRequest(body = validIntake, authenticated = true) {
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
  return authenticated
    ? authenticatedRequest("/api/ariadne/core/intake", options)
    : new Request("https://worker.invalid/api/ariadne/core/intake", options);
}

function ariadneEnvironment(role = "specialist") {
  return scopedEnvironment(role, {
    OPENAI_API_KEY: "test-provider-key",
    OPENAI_MODEL: "test-model"
  });
}

test("observed intake envelope returns a review-first non-mutating proposal", async () => {
  const worker = await loadWorker();
  const response = await withStubbedFetch(async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(Object.hasOwn(payload, "temperature"), false);
    assert.deepEqual(payload.response_format, intakeResponseFormat);
    assert.match(payload.messages[1].content, /"source":"obsidian-plugin"/);
    assert.match(payload.messages[1].content, /"reviewFirst":true/);
    return providerChatResponse(validProposal);
  }, () => worker.fetch(intakeRequest(), ariadneEnvironment()));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    reviewFirst: true,
    mutated: false,
    proposal: validProposal
  });
});

test("intake authentication and authorization failures are structured", async () => {
  const worker = await loadWorker();
  const unauthenticated = await worker.fetch(intakeRequest(validIntake, false), {});
  assert.equal(unauthenticated.status, 401);

  let providerCalled = false;
  const denied = await withStubbedFetch(async () => {
    providerCalled = true;
    throw new Error("unexpected provider call");
  }, () => worker.fetch(intakeRequest(), scopedEnvironment("portal")));

  assert.equal(denied.status, 403);
  assert.equal(
    (await denied.json()).error,
    "Role lacks capability: ariadne.core.openai_test"
  );
  assert.equal(providerCalled, false);
});

test("intake rejects mutation-oriented envelopes before provider access", async () => {
  const worker = await loadWorker();
  let providerCalled = false;
  const response = await withStubbedFetch(async () => {
    providerCalled = true;
    throw new Error("unexpected provider call");
  }, () => worker.fetch(
    intakeRequest({ ...validIntake, reviewFirst: false }),
    ariadneEnvironment()
  ));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "review_first_required");
  assert.equal(providerCalled, false);
});

test("intake contains provider failures without reflecting upstream content", async () => {
  const worker = await loadWorker();
  const sensitiveMarker = "provider-private-diagnostic-marker";
  const response = await withStubbedFetch(
    async () => new Response(JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: sensitiveMarker
      }
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    }),
    () => worker.fetch(intakeRequest(), ariadneEnvironment())
  );

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes(sensitiveMarker), false);
  assert.deepEqual(JSON.parse(body), {
    error: "provider_request_failed",
    details: {
      upstreamStatus: 429,
      upstreamCode: "rate_limit_error"
    }
  });
});

test("intake rejects malformed provider output without reflecting it", async () => {
  const worker = await loadWorker();
  const response = await withStubbedFetch(
    async () => providerChatResponse({ summary: "incomplete" }),
    () => worker.fetch(intakeRequest(), ariadneEnvironment())
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "invalid_provider_output" });
});
