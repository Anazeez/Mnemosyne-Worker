import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisualConsumerOperation,
  executeVisualConsumerOperation,
} from "../scripts/manage-visual-skill-consumers.mjs";

test("consumer manager defaults mutation to a deterministic dry plan", async () => {
  const operation = await buildVisualConsumerOperation([
    "approve",
    "--oauth-client-id", "ordinary-chatgpt-client",
  ]);
  assert.deepEqual(operation, {
    command: "plan",
    planned_command: "approve",
    apply: false,
    assistant_id: "oauth-e64b45601d22c495634370be5800fb40",
    consumer_id: "general-assistant",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    allowed_scopes: ["identity:read", "memory:read", "memory:search"],
  });
});

test("consumer manager requires explicit apply and sends no OAuth client secret", async () => {
  const operation = await buildVisualConsumerOperation([
    "approve",
    "--oauth-client-id", "ordinary-chatgpt-client",
    "--actor", "owner:277895262",
    "--reason", "approve ordinary ChatGPT visual retrieval",
    "--now", "2026-08-04T00:00:00.000Z",
    "--apply",
  ]);
  let observed;
  const result = await executeVisualConsumerOperation(operation, {
    baseUrl: "https://memory.example",
    adminKey: "owner-key-with-enough-entropy",
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return Response.json({ verification: "passed", command: "approve" });
    },
  });
  assert.equal(result.verification, "passed");
  assert.equal(observed.url, "https://memory.example/internal/admin/visual-skills/consumers");
  assert.equal(observed.init.headers["X-Matrix-Key"], "owner-key-with-enough-entropy");
  assert.doesNotMatch(observed.init.body, /ordinary-chatgpt-client|client_secret/u);
  assert.match(observed.init.body, /oauth-e64b45601d22c495634370be5800fb40/u);
});
