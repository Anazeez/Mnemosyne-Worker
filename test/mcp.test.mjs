import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_RESOURCE_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
  handleMcpRequest,
  invokeHandoffTool,
  invokeMemoryTool,
} from "../src/mcp.js";

const principal = {
  tenant_id: "personal",
  credential_id: "assistant-one",
  assistant_id: "assistant-one",
  project_ids: ["project-one"],
  capabilities: ["memory.read", "memory.search", "memory.propose", "memory.candidate.read.own"],
};

test("MCP publishes eight bounded public tools", () => {
  assert.deepEqual(
    MCP_TOOL_DEFINITIONS.map(tool => tool.name),
    [
      "memory_rehydrate",
      "memory_search",
      "memory_traverse",
      "memory_propose",
      "memory_candidate_status",
      "handoff.compact",
      "handoff.propose",
      "handoff.accept",
    ],
  );
  assert.equal(
    MCP_TOOL_DEFINITIONS.some(tool =>
      /publish|validate|resolve|invalidate|delete/i.test(tool.name)),
    false,
  );
});

test("MCP annotations accurately isolate the proposal side effect", () => {
  for (const tool of MCP_TOOL_DEFINITIONS) {
    if (
      tool.name === "memory_propose" ||
      tool.name === "handoff.propose" ||
      tool.name === "handoff.accept"
    ) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    } else {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
    }
  }
});

test("MCP tool invocation returns structured service output", async () => {
  const input = {
    tenant_id: "personal",
    project_id: "project-one",
    query: "architecture",
  };
  const expected = { accepted_generation: 7, assertions: [] };
  const result = await invokeMemoryTool("memory_search", {
    env: {},
    principal,
    input,
    services: {
      searchAcceptedMemory: async arguments_ => {
        assert.deepEqual(arguments_.body, input);
        return expected;
      },
    },
  });
  assert.deepEqual(result.structuredContent, expected);
  assert.equal(JSON.parse(result.content[0].text).accepted_generation, 7);
});

test("Streamable HTTP advertises the same eight tools", async () => {
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
    { env: {}, principal, services: {} },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.result.tools.map(tool => tool.name),
    MCP_TOOL_DEFINITIONS.map(tool => tool.name),
  );
});

test("Streamable HTTP advertises the latest-handoff resource template", async () => {
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/templates/list",
        params: {},
      }),
    }),
    { env: {}, principal, services: {} },
  );
  const body = await response.json();
  assert.deepEqual(body.result.resourceTemplates, [{
    name: MCP_RESOURCE_DEFINITIONS[0].name,
    uriTemplate: MCP_RESOURCE_DEFINITIONS[0].uri_template,
    description: "Latest accepted Mnemosyne handoff package for a tenant/project scope.",
    mimeType: MCP_RESOURCE_DEFINITIONS[0].mime_type,
  }]);
});

test("Streamable HTTP reads the latest-handoff resource through the scoped service", async () => {
  const expected = {
    schema_version: "handoff.resource.v1",
    active_handoff: null,
  };
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: {
          uri: "mnemosyne://personal/project-one/handoff/latest",
        },
      }),
    }),
    {
      env: {},
      principal,
      services: {
        readLatestHandoffResource: async arguments_ => {
          assert.equal(arguments_.tenantId, "personal");
          assert.equal(arguments_.projectId, "project-one");
          return expected;
        },
      },
    },
  );
  const body = await response.json();
  assert.equal(body.result.contents[0].mimeType, "application/json");
  assert.deepEqual(JSON.parse(body.result.contents[0].text), expected);
});

test("MCP proposal schema exposes required assertion and evidence fields", async () => {
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
    { env: {}, principal, services: {} },
  );
  const body = await response.json();
  const proposal = body.result.tools.find(tool => tool.name === "memory_propose");
  const assertion = proposal.inputSchema.properties.assertions.items;
  const evidence = proposal.inputSchema.properties.evidence.items;

  assert.deepEqual(
    assertion.required,
    ["subject", "predicate", "object", "confidence"],
  );
  assert.deepEqual(Object.keys(assertion.properties), [
    "subject",
    "predicate",
    "object",
    "confidence",
  ]);
  assert.deepEqual(
    evidence.required,
    ["source_ref", "content_hash", "observed_at"],
  );
  assert.deepEqual(Object.keys(evidence.properties), [
    "source_ref",
    "content_hash",
    "source_excerpt",
    "observed_at",
  ]);
});

test("MCP handoff proposal schema requires a local draft object", async () => {
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
    { env: {}, principal, services: {} },
  );
  const body = await response.json();
  const proposal = body.result.tools.find(tool => tool.name === "handoff.propose");
  assert.deepEqual(proposal.inputSchema.required, [
    "tenant_id",
    "project_id",
    "local_draft",
  ]);
  assert.equal(proposal.inputSchema.properties.local_draft.type, "object");
});

test("MCP handoff compaction schema is read-only and returns a pending draft", async () => {
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
    { env: {}, principal, services: {} },
  );
  const body = await response.json();
  const compact = body.result.tools.find(tool => tool.name === "handoff.compact");
  assert.deepEqual(compact.inputSchema.required, ["tenant_id", "project_id"]);
  assert.equal(compact.annotations.readOnlyHint, true);
  assert.equal(compact.annotations.destructiveHint, false);

  const result = await invokeHandoffTool(
    "handoff.compact",
    {
      env: {},
      principal,
      input: { tenant_id: "personal", project_id: "project-one" },
      services: {
        proposeHandoffCompaction: async arguments_ => {
          assert.equal(arguments_.input.project_id, "project-one");
          return { status: "pending_confirmation", accepted: false };
        },
      },
    },
  );
  assert.deepEqual(result.structuredContent, {
    status: "pending_confirmation",
    accepted: false,
  });
});

test("MCP handoff acceptance schema binds approval to the proposed draft", async () => {
  const response = await handleMcpRequest(
    new Request("https://memory.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
    { env: {}, principal, services: {} },
  );
  const body = await response.json();
  const acceptance = body.result.tools.find(tool => tool.name === "handoff.accept");
  assert.deepEqual(acceptance.inputSchema.required, [
    "tenant_id",
    "project_id",
    "confirmation_id",
    "payload_hash",
    "local_draft",
    "approval",
  ]);
  assert.deepEqual(acceptance.inputSchema.properties.approval.required, [
    "approved",
    "approved_by_credential_id",
    "receipt_hash",
  ]);
});

test("handoff.accept dispatches only through the governed acceptance service", async () => {
  const expected = { status: "accepted", accepted: true };
  const result = await invokeHandoffTool("handoff.accept", {
    env: {},
    principal,
    input: { confirmation_id: "handoff_confirmation_test" },
    services: {
      acceptHandoffDraft: async arguments_ => {
        assert.equal(arguments_.input.confirmation_id, "handoff_confirmation_test");
        return expected;
      },
    },
  });
  assert.deepEqual(result.structuredContent, expected);
});

test("MCP errors are stable and do not reflect service secrets", async () => {
  const result = await invokeMemoryTool("memory_search", {
    env: {},
    principal,
    input: {},
    services: {
      searchAcceptedMemory: async () => {
        throw Object.assign(new Error("access_token=secret-value"), {
          code: "SEARCH_FAILED",
        });
      },
    },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "SEARCH_FAILED",
      message: "The memory operation could not be completed",
    },
  });
  assert.doesNotMatch(result.content[0].text, /secret-value/);
});
