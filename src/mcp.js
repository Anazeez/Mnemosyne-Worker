import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
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
import {
  HANDOFF_RESOURCE_MIME_TYPE,
  HANDOFF_RESOURCE_URI_TEMPLATE,
  acceptHandoffDraft,
  proposeHandoffCompaction,
  proposeHandoffDraft,
  readLatestHandoffResource,
} from "./handoff/mcp.js";

const targetShape = {
  tenant_id: z.string().min(2).max(64),
  project_id: z.string().min(2).max(64),
};

const assertionSchema = z.object({
  subject: z.string().min(1).max(4_000),
  predicate: z.string().min(1).max(4_000),
  object: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
}).strict();

const evidenceSchema = z.object({
  source_ref: z.string().min(1).max(2_048),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_excerpt: z.string().min(1).max(4_000).optional(),
  observed_at: z.string().datetime({ offset: true }),
}).strict();

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
      assertions: z.array(assertionSchema).min(1).max(100),
      evidence: z.array(evidenceSchema).min(1).max(100),
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
  Object.freeze({
    name: "handoff.compact",
    description: "Compile accepted project handoffs into a pending epoch draft without writing memory.",
    inputSchema: z.object({
      ...targetShape,
      occurred_at: z.string().datetime({ offset: true }).optional(),
      event: z.enum(["phase_complete", "context_compaction", "project_complete"]).optional(),
      agent_family: z.enum(["codex", "claude", "gemini", "other"]).optional(),
      agent_id: z.string().min(2).max(128).optional(),
      session_id: z.string().min(2).max(128).optional(),
    }).strict(),
    annotations: retrievalAnnotations,
  }),
  Object.freeze({
    name: "handoff.propose",
    description: "Validate a local handoff draft and request user confirmation without accepting memory.",
    inputSchema: z.object({
      ...targetShape,
      local_draft: z.record(z.string(), z.unknown()),
    }).strict(),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "handoff.accept",
    description: "Accept one exact proposed handoff after explicit owner approval.",
    inputSchema: z.object({
      ...targetShape,
      confirmation_id: z.string().regex(/^handoff_confirmation_[a-f0-9]{32}$/),
      payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
      local_draft: z.record(z.string(), z.unknown()),
      approval: z.object({
        approved: z.literal(true),
        approved_by_credential_id: z.string().min(2).max(128),
        receipt_hash: z.string().regex(/^[a-f0-9]{64}$/),
      }).strict(),
    }).strict(),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
]);

export const MCP_RESOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "handoff-latest",
    uri_template: HANDOFF_RESOURCE_URI_TEMPLATE,
    mime_type: HANDOFF_RESOURCE_MIME_TYPE,
  }),
]);

export const GRAPH_MEMORY_SERVICES = Object.freeze({
  rehydrateAcceptedMemory,
  searchAcceptedMemory,
  traverseAcceptedMemory,
  createMemoryCandidate,
  getOwnCandidate,
  proposeHandoffCompaction,
  proposeHandoffDraft,
  acceptHandoffDraft,
  readLatestHandoffResource,
});

export async function invokeMemoryTool(name, {
  env,
  principal,
  input,
  services = GRAPH_MEMORY_SERVICES,
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
  services = GRAPH_MEMORY_SERVICES,
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

export async function invokeHandoffTool(name, {
  env,
  principal,
  input,
  services = GRAPH_MEMORY_SERVICES,
}) {
  try {
    const operations = {
      "handoff.compact": services.proposeHandoffCompaction,
      "handoff.propose": services.proposeHandoffDraft,
      "handoff.accept": services.acceptHandoffDraft,
    };
    const operation = operations[name];
    if (typeof operation !== "function") {
      throw Object.assign(new Error("unknown_handoff_tool"), {
        code: "UNKNOWN_HANDOFF_TOOL",
        status: 404,
      });
    }
    const output = await operation({
      env,
      principal,
      input,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const normalized = {
      error: {
        code: error?.code || "HANDOFF_OPERATION_FAILED",
        message: "The handoff operation could not be completed",
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(normalized) }],
      structuredContent: normalized,
      isError: true,
    };
  }
}

export async function invokeHandoffResource({
  env,
  principal,
  tenantId,
  projectId,
  services = GRAPH_MEMORY_SERVICES,
}) {
  try {
    return await services.readLatestHandoffResource({
      env,
      principal,
      tenantId,
      projectId,
    });
  } catch (error) {
    throw Object.assign(new Error("The handoff resource could not be read"), {
      code: error?.code || "HANDOFF_RESOURCE_FAILED",
      status: error?.status || 400,
    });
  }
}

export async function handleMcpRequest(request, {
  env,
  principal,
  services = GRAPH_MEMORY_SERVICES,
}) {
  const server = new McpServer({
    name: "mnemosyne-shared-memory",
    version: "1.0.0",
  });
  for (const definition of MCP_TOOL_DEFINITIONS) {
    const invoke = definition.name.startsWith("handoff.")
      ? invokeHandoffTool
      : invokeMemoryTool;
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      input => invoke(definition.name, {
        env,
        principal,
        input,
        services,
      }),
    );
  }
  const resourceTemplate = new ResourceTemplate(
    HANDOFF_RESOURCE_URI_TEMPLATE,
    {}
  );
  server.registerResource(
    "handoff-latest",
    resourceTemplate,
    {
      description: "Latest accepted Mnemosyne handoff package for a tenant/project scope.",
      mimeType: HANDOFF_RESOURCE_MIME_TYPE,
    },
    async (uri, variables) => ({
      contents: [{
        uri: uri.toString(),
        mimeType: HANDOFF_RESOURCE_MIME_TYPE,
        text: JSON.stringify(await invokeHandoffResource({
          env,
          principal,
          tenantId: variables.tenant_id,
          projectId: variables.project_id,
          services,
        })),
      }],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
