import assert from "node:assert/strict";
import test from "node:test";

import { invokeMemoryTool } from "../src/mcp.js";
import {
  OPENAPI_DOCUMENT,
  handleOpenApiRequest,
} from "../src/openapi.js";

const principal = {
  tenant_id: "personal",
  credential_id: "assistant-one",
  assistant_id: "assistant-one",
  project_ids: ["project-one"],
  capabilities: ["memory.read", "memory.search", "memory.propose", "memory.candidate.read.own"],
};

test("MCP and Actions normalize search identically", async () => {
  const input = {
    tenant_id: "personal",
    project_id: "project-one",
    query: "architecture",
  };
  const expected = {
    tenant_id: "personal",
    project_id: "project-one",
    accepted_generation: 7,
    assertions: [],
    conflicts: [],
  };
  const services = { searchAcceptedMemory: async () => expected };
  const mcpResult = await invokeMemoryTool("memory_search", {
    env: {},
    principal,
    input,
    services,
  });
  const actionResponse = await handleOpenApiRequest(
    new Request("https://memory.example/v1/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    { env: {}, principal, services, requestId: () => "request-test" },
  );
  assert.equal(actionResponse.status, 200);
  assert.deepEqual(mcpResult.structuredContent, await actionResponse.json());
});

test("public OpenAPI schema exposes only retrieval, proposal, and own status", () => {
  assert.equal(OPENAPI_DOCUMENT.openapi, "3.1.0");
  assert.deepEqual(Object.keys(OPENAPI_DOCUMENT.paths).sort(), [
    "/v1/memory/candidates",
    "/v1/memory/candidates/{candidate_id}",
    "/v1/memory/rehydrate",
    "/v1/memory/search",
    "/v1/memory/traverse",
  ]);
  assert.equal(
    Object.keys(OPENAPI_DOCUMENT.paths).some(path =>
      /publish|validate|resolve|invalidate|delete/i.test(path)),
    false,
  );
  assert.deepEqual(
    OPENAPI_DOCUMENT.components.securitySchemes.oauth.flows.authorizationCode.scopes,
    {
      "memory:read": "Read accepted project memory and continuity",
      "memory:search": "Search accepted project memory",
      "memory:propose": "Submit an immutable memory candidate",
      "memory:candidate:read": "Read status of candidates submitted by this credential",
    },
  );
});

test("Actions normalize errors without reflecting secrets", async () => {
  const response = await handleOpenApiRequest(
    new Request("https://memory.example/v1/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "secret" }),
    }),
    {
      env: {},
      principal,
      services: {
        searchAcceptedMemory: async () => {
          throw Object.assign(new Error("access_token=secret-value"), {
            code: "SEARCH_FAILED",
            status: 400,
          });
        },
      },
      requestId: () => "request-test",
    },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "SEARCH_FAILED",
      message: "The memory operation could not be completed",
      request_id: "request-test",
    },
  });
});
