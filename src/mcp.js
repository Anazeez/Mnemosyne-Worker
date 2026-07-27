import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import {
  createMemoryCandidate,
  getOwnCandidate,
} from "./graph-memory/candidates.js";
import {
  rehydrateAcceptedMemory,
  searchAcceptedMemory,
  traverseAcceptedMemory,
} from "./graph-memory/retrieval.js";

const targetShape = {
  tenant_id: z.string().min(2).max(64),
  project_id: z.string().min(2).max(64),
};

const retrievalAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const MCP_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "memory_rehydrate",
    description: "Load accepted, evidence-backed project memory and record a retrieval receipt.",
    inputSchema: z.object({
      ...targetShape,
      query: z.string().min(1).max(1_000),
      top_k: z.number().int().min(1).max(25).optional(),
      invocation_id: z.string().min(8).max(128),
    }).strict(),
    annotations: retrievalAnnotations,
  }),
  Object.freeze({
    name: "memory_search",
    description: "Search only accepted project memory with citations and conflicts.",
    inputSchema: z.object({
      ...targetShape,
      query: z.string().min(1).max(1_000),
      top_k: z.number().int().min(1).max(25).optional(),
    }).strict(),
    annotations: retrievalAnnotations,
  }),
  Object.freeze({
    name: "memory_traverse",
    description: "Traverse a bounded accepted-memory subgraph from one canonical entity.",
    inputSchema: z.object({
      ...targetShape,
      start_entity_id: z.string().min(2).max(128),
      max_depth: z.number().int().min(0).max(4).optional(),
      max_nodes: z.number().int().min(1).max(200).optional(),
      max_edges: z.number().int().min(1).max(500).optional(),
      time_budget_ms: z.number().int().min(1).max(3_000).optional(),
    }).strict(),
    annotations: retrievalAnnotations,
  }),
  Object.freeze({
    name: "memory_propose",
    description: "Submit an immutable candidate for governed validation and human review.",
    inputSchema: z.object({
      ...targetShape,
      idempotency_key: z.string().min(8).max(128),
      assertions: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      evidence: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    }).strict(),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "memory_candidate_status",
    description: "Read only the status of a candidate submitted by this credential.",
    inputSchema: z.object({
      candidate_id: z.string().min(18).max(138),
    }).strict(),
    annotations: retrievalAnnotations,
  }),
]);

const DEFAULT_SERVICES = Object.freeze({
  rehydrateAcceptedMemory,
  searchAcceptedMemory,
  traverseAcceptedMemory,
  createMemoryCandidate,
  getOwnCandidate,
});

export async function invokeMemoryTool(name, {
  env,
  principal,
  input,
  services = DEFAULT_SERVICES,
}) {
  try {
    const output = await executeMemoryOperation(name, {
      env,
      principal,
      input,
      services,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const normalized = {
      error: {
        code: error?.code || "MEMORY_OPERATION_FAILED",
        message: "The memory operation could not be completed",
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(normalized) }],
      structuredContent: normalized,
      isError: true,
    };
  }
}

export async function executeMemoryOperation(name, {
  env,
  principal,
  input,
  services = DEFAULT_SERVICES,
}) {
  const operations = {
    memory_rehydrate: () => services.rehydrateAcceptedMemory({
      env,
      principal,
      body: input,
    }),
    memory_search: () => services.searchAcceptedMemory({
      env,
      principal,
      body: input,
    }),
    memory_traverse: () => services.traverseAcceptedMemory({
      env,
      principal,
      body: input,
    }),
    memory_propose: () => services.createMemoryCandidate({
      env,
      principal,
      body: input,
    }),
    memory_candidate_status: () => services.getOwnCandidate({
      env,
      principal,
      candidateId: input.candidate_id,
    }),
  };
  if (!operations[name]) throw Object.assign(new Error("unknown_memory_tool"), {
    code: "UNKNOWN_MEMORY_TOOL",
    status: 404,
  });
  return operations[name]();
}

export async function handleMcpRequest(request, {
  env,
  principal,
  services = DEFAULT_SERVICES,
}) {
  const server = new McpServer({
    name: "mnemosyne-shared-memory",
    version: "1.0.0",
  });
  for (const definition of MCP_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      input => invokeMemoryTool(definition.name, {
        env,
        principal,
        input,
        services,
      }),
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
