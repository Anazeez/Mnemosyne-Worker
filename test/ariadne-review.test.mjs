import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  providerChatResponse,
  scopedEnvironment,
  withStubbedFetch
} from "./helpers/worker-harness.mjs";

const validReviewRequest = Object.freeze({
  title: "Existing note",
  content: "Review this note without changing it.",
  currentLocation: "Inbox/existing-note.md",
  metadata: { source: "obsidian-plugin" },
  reviewFirst: true
});

const validReview = Object.freeze({
  summary: "A bounded review.",
  quality: "clear",
  ambiguities: [],
  missingInformation: [],
  duplicateRisk: "low",
  suggestedTags: ["reviewed"],
  suggestedLinks: [],
  suggestedDestination: "Notes",
  confidence: 0.9,
  warnings: []
});

const reviewResponseFormat = Object.freeze({
  type: "json_schema",
  json_schema: {
    name: "ariadne_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        quality: { type: "string" },
        ambiguities: { type: "array", items: { type: "string" } },
        missingInformation: { type: "array", items: { type: "string" } },
        duplicateRisk: { type: "string" },
        suggestedTags: { type: "array", items: { type: "string" } },
        suggestedLinks: { type: "array", items: { type: "string" } },
        suggestedDestination: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        warnings: { type: "array", items: { type: "string" } }
      },
      required: [
        "summary",
        "quality",
        "ambiguities",
        "missingInformation",
        "duplicateRisk",
        "suggestedTags",
        "suggestedLinks",
        "suggestedDestination",
        "confidence",
        "warnings"
      ],
      additionalProperties: false
    }
  }
});

function reviewRequest(body = validReviewRequest) {
  return authenticatedRequest("/api/ariadne/core/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function environment(role = "specialist") {
  return scopedEnvironment(role, {
    OPENAI_API_KEY: "test-provider-key",
    OPENAI_MODEL: "test-model"
  });
}

test("review returns a validated non-mutating result", async () => {
  const worker = await loadWorker();
  const response = await withStubbedFetch(
    async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(Object.hasOwn(payload, "temperature"), false);
      assert.deepEqual(payload.response_format, reviewResponseFormat);
      return providerChatResponse(validReview);
    },
    () => worker.fetch(reviewRequest(), environment())
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    reviewFirst: true,
    mutated: false,
    review: validReview
  });
});

test("review authorization denial is structured and precedes provider access", async () => {
  const worker = await loadWorker();
  let providerCalled = false;
  const response = await withStubbedFetch(async () => {
    providerCalled = true;
    throw new Error("unexpected provider call");
  }, () => worker.fetch(reviewRequest(), scopedEnvironment("inspector")));

  assert.equal(response.status, 403);
  assert.equal(
    (await response.json()).error,
    "Role lacks capability: ariadne.core.openai_test"
  );
  assert.equal(providerCalled, false);
});

test("review requires review-first input before provider access", async () => {
  const worker = await loadWorker();
  let providerCalled = false;
  const response = await withStubbedFetch(async () => {
    providerCalled = true;
    throw new Error("unexpected provider call");
  }, () => worker.fetch(
    reviewRequest({ ...validReviewRequest, reviewFirst: false }),
    environment()
  ));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "review_first_required");
  assert.equal(providerCalled, false);
});

test("review does not reflect provider failure bodies", async () => {
  const worker = await loadWorker();
  const sensitiveMarker = "private-provider-review-detail";
  const response = await withStubbedFetch(
    async () => new Response(JSON.stringify({
      error: {
        code: "unsupported_value",
        message: sensitiveMarker
      }
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    }),
    () => worker.fetch(reviewRequest(), environment())
  );

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes(sensitiveMarker), false);
  assert.deepEqual(JSON.parse(body), {
    error: "provider_request_failed",
    details: {
      upstreamStatus: 400,
      upstreamCode: "unsupported_value"
    }
  });
});
