import { executeMemoryOperation } from "./mcp.js";

const scopeDescriptions = Object.freeze({
  "memory:read": "Read accepted project memory and continuity",
  "memory:search": "Search accepted project memory",
  "memory:propose": "Submit an immutable memory candidate",
  "memory:candidate:read": "Read status of candidates submitted by this credential",
});

const targetProperties = {
  tenant_id: { type: "string", minLength: 2, maxLength: 64 },
  project_id: { type: "string", minLength: 2, maxLength: 64 },
};

export const OPENAPI_DOCUMENT = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "Mnemosyne Shared Memory",
    version: "1.0.0",
    description: "Evidence-backed project memory with governed proposal intake.",
  },
  security: [{ oauth: [] }],
  paths: {
    "/v1/memory/rehydrate": postOperation(
      "rehydrateMemory",
      "Rehydrate accepted project memory",
      "memory:search",
      {
        ...targetProperties,
        query: { type: "string", minLength: 1, maxLength: 1_000 },
        top_k: { type: "integer", minimum: 1, maximum: 25 },
        invocation_id: { type: "string", minLength: 8, maxLength: 128 },
      },
      ["tenant_id", "project_id", "query", "invocation_id"],
    ),
    "/v1/memory/search": postOperation(
      "searchMemory",
      "Search accepted project memory",
      "memory:search",
      {
        ...targetProperties,
        query: { type: "string", minLength: 1, maxLength: 1_000 },
        top_k: { type: "integer", minimum: 1, maximum: 25 },
      },
      ["tenant_id", "project_id", "query"],
    ),
    "/v1/memory/traverse": postOperation(
      "traverseMemory",
      "Traverse a bounded accepted-memory graph",
      "memory:read",
      {
        ...targetProperties,
        start_entity_id: { type: "string", minLength: 2, maxLength: 128 },
        max_depth: { type: "integer", minimum: 0, maximum: 4 },
        max_nodes: { type: "integer", minimum: 1, maximum: 200 },
        max_edges: { type: "integer", minimum: 1, maximum: 500 },
        time_budget_ms: { type: "integer", minimum: 1, maximum: 3_000 },
      },
      ["tenant_id", "project_id", "start_entity_id"],
    ),
    "/v1/memory/candidates": postOperation(
      "proposeMemory",
      "Submit a governed memory candidate",
      "memory:propose",
      {
        ...targetProperties,
        idempotency_key: { type: "string", minLength: 8, maxLength: 128 },
        assertions: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "object", additionalProperties: true },
        },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "object", additionalProperties: true },
        },
      },
      ["tenant_id", "project_id", "idempotency_key", "assertions", "evidence"],
    ),
    "/v1/memory/candidates/{candidate_id}": {
      get: {
        operationId: "getOwnMemoryCandidate",
        summary: "Read an own candidate status",
        security: [{ oauth: ["memory:candidate:read"] }],
        parameters: [{
          name: "candidate_id",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 18, maxLength: 138 },
        }],
        responses: standardResponses(),
      },
    },
  },
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "/authorize",
            tokenUrl: "/token",
            scopes: scopeDescriptions,
          },
        },
      },
    },
  },
});

const ACTION_ROUTES = Object.freeze({
  "POST /v1/memory/rehydrate": "memory_rehydrate",
  "POST /v1/memory/search": "memory_search",
  "POST /v1/memory/traverse": "memory_traverse",
  "POST /v1/memory/candidates": "memory_propose",
  "GET /v1/memory/candidates/:candidate_id": "memory_candidate_status",
});

export async function handleOpenApiRequest(request, {
  env,
  principal,
  services,
  requestId = () => crypto.randomUUID(),
} = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/openapi.json" && request.method === "GET") {
    return Response.json(OPENAPI_DOCUMENT, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }
  const candidateMatch = url.pathname.match(
    /^\/v1\/memory\/candidates\/([^/]+)$/,
  );
  const routeKey = candidateMatch
    ? `${request.method} /v1/memory/candidates/:candidate_id`
    : `${request.method} ${url.pathname}`;
  const toolName = ACTION_ROUTES[routeKey];
  if (!toolName) return normalizedError("ROUTE_NOT_FOUND", 404, requestId());

  try {
    let input;
    if (candidateMatch) {
      input = { candidate_id: decodeURIComponent(candidateMatch[1]) };
    } else {
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength > 262_144) {
        return normalizedError("REQUEST_TOO_LARGE", 413, requestId());
      }
      input = await request.json();
    }
    const result = await executeMemoryOperation(toolName, {
      env,
      principal,
      input,
      services,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return normalizedError(
      error?.code || "MEMORY_OPERATION_FAILED",
      Number.isInteger(error?.status) ? error.status : 500,
      requestId(),
    );
  }
}

function postOperation(operationId, summary, scope, properties, required) {
  return {
    post: {
      operationId,
      summary,
      security: [{ oauth: [scope] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              properties,
              required,
            },
          },
        },
      },
      responses: standardResponses(),
    },
  };
}

function standardResponses() {
  return {
    200: { description: "Successful governed memory operation" },
    400: { description: "Invalid request" },
    401: { description: "Authentication required" },
    403: { description: "Requested scope is not authorized" },
    404: { description: "Resource unavailable" },
  };
}

function normalizedError(code, status, requestId) {
  return Response.json(
    {
      error: {
        code,
        message: "The memory operation could not be completed",
        request_id: requestId,
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
