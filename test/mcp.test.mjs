import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_TOOL_DEFINITIONS,
  handleMcpRequest,
  invokeMemoryTool,
} from "../src/mcp.js";

const principal = {
  tenant_id: "personal",
  credential_id: "assistant-one",
  assistant_id: "assistant-one",
  project_ids: ["project-one"],
  capabilities: ["memory.read", "memory.search", "memory.propose", "memory.candidate.read.own"],
};

test("MCP publishes exactly five bounded public tools", () => {
  assert.deepEqual(
    MCP_TOOL_DEFINITIONS.map(tool => tool.name),
    [
      "memory_rehydrate",
      "memory_search",
      "memory_traverse",
      "memory_propose",
      "memory_candidate_status",
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
    if (tool.name === "memory_propose") {
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

test("Streamable HTTP advertises the same five tools", async () => {
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
