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

const specialistPrincipal = {
  tenant_id: "personal",
  credential_id: "github-277895262",
  assistant_id: "oauth-11111111111111111111111111111111",
  principal_id: "synn",
  role: "specialist",
  specialist_id: "synn",
  project_ids: ["project-infinitum"],
  identity_ids: ["synn"],
  domain_ids: ["security-compliance-preflight"],
  memory_domains: ["agents", "files", "knowledge", "library", "skills"],
  lane_permissions: ["root-local", "savae-routed"],
  scopes: ["identity:read", "mesh:inbox"],
  capabilities: ["identity.read", "exchanges.inbox", "security.preflight"],
  grant_version: "a".repeat(64),
  package_version: "2026-08-03.2",
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
    "/ping",
    "/v1/identity",
    "/v1/memory/candidates",
    "/v1/memory/candidates/{candidate_id}",
    "/v1/memory/rehydrate",
    "/v1/memory/search",
    "/v1/memory/traverse",
    "/v1/mesh/inbox",
    "/v1/session",
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
      "identity:read": "Verify the authenticated specialist identity and bounded grants",
      "mesh:inbox": "Read the authenticated specialist's private mesh inbox",
    },
  );
  assert.equal(
    OPENAPI_DOCUMENT.paths["/ping"].get.responses[200].content["application/json"].schema.additionalProperties,
    false,
  );
  assert.equal(
    OPENAPI_DOCUMENT.paths["/v1/session"].get.responses[200].content["application/json"].schema.additionalProperties,
    false,
  );
  assert.deepEqual(
    OPENAPI_DOCUMENT.paths["/v1/identity"].get.security,
    [{ matrixKey: [] }],
  );
  assert.deepEqual(OPENAPI_DOCUMENT.components.securitySchemes.matrixKey, {
    type: "apiKey",
    in: "header",
    name: "X-Matrix-Key",
  });
});

test("verifyPrincipal returns bounded authenticated specialist grants", async () => {
  const response = await handleOpenApiRequest(
    new Request("https://memory.example/v1/session"),
    { env: {}, principal: specialistPrincipal, requestId: () => "request-test" },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, {
    authenticated: true,
    tenant_id: "personal",
    principal_id: "synn",
    role: "specialist",
    specialist_id: "synn",
    project_ids: ["project-infinitum"],
    domain_ids: ["security-compliance-preflight"],
    memory_domains: ["agents", "files", "knowledge", "library", "skills"],
    lane_permissions: ["root-local", "savae-routed"],
    oauth_scopes: ["identity:read", "mesh:inbox"],
    capabilities: ["exchanges.inbox", "identity.read", "security.preflight"],
    package_version: "2026-08-03.2",
    grant_version: "a".repeat(64),
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /assistant|credential|github|token|secret|client/i,
  );
});

test("verifyPrincipal rejects a non-specialist OAuth principal", async () => {
  const response = await handleOpenApiRequest(
    new Request("https://memory.example/v1/session"),
    {
      env: {},
      principal: { ...principal, role: "portal", capabilities: ["identity.read"] },
      requestId: () => "request-test",
    },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "IDENTITY_SCOPE_DENIED");
});

test("verifyPrincipal rejects a specialist without identity read scope", async () => {
  const response = await handleOpenApiRequest(
    new Request("https://memory.example/v1/session"),
    {
      env: {},
      principal: {
        ...specialistPrincipal,
        scopes: ["mesh:inbox"],
        capabilities: ["exchanges.inbox", "security.preflight"],
      },
      requestId: () => "request-test",
    },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "IDENTITY_SCOPE_DENIED");
});

test("public OpenAPI exposes truthful checkHealth without OAuth", async () => {
  const operation = OPENAPI_DOCUMENT.paths["/ping"].get;
  assert.equal(operation.operationId, "checkHealth");
  assert.deepEqual(operation.security, []);

  const response = await handleOpenApiRequest(
    new Request("https://memory.example/ping"),
    {
      env: {
        DB: {},
        OAUTH_KV: {},
        MESH_GATEWAY_SECRET: "s".repeat(32),
        GRAPH_MEMORY_READ_ENABLED: "true",
      },
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, {
    status: "ok",
    worker: "ready",
    d1: "available",
    oauth: "available",
    graph_memory: {
      actions: false,
      mcp: false,
      owner_commit: false,
      owner_review: false,
      propose: false,
      publication: false,
      read: true,
      resolution: false,
      review: false,
      validation: false,
    },
    specialist_policy_version: "2026-08-02.1",
    mesh_ingress: "ready",
  });
  assert.doesNotMatch(JSON.stringify(payload), /secret|principal|credential|binding/i);
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
