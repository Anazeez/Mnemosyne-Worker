import { executeMemoryOperation } from "./mcp.js";
import { buildHealthPayload } from "./health.js";
import { handleMeshInboxRequest } from "./mesh/routes.js";

const scopeDescriptions = Object.freeze({
  "identity:read": "Verify the authenticated specialist identity and bounded grants",
  "memory:read": "Read accepted project memory and continuity",
  "memory:search": "Search accepted project memory",
  "memory:propose": "Submit an immutable memory candidate",
  "memory:candidate:read": "Read status of candidates submitted by this credential",
  "mesh:inbox": "Read the authenticated specialist's private mesh inbox",
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
    "/ping": {
      get: {
        operationId: "checkHealth",
        summary: "Check Mnemosyne availability",
        security: [],
        responses: {
          200: { description: "Bounded Mnemosyne health status" },
        },
      },
    },
    "/v1/session": {
      get: {
        operationId: "verifyPrincipal",
        summary: "Verify the authenticated specialist identity and bounded grants",
        security: [{ oauth: ["identity:read"] }],
        responses: standardResponses(),
      },
    },
    "/v1/mesh/inbox": {
      get: {
        operationId: "listMeshInbox",
        summary: "Read the authenticated specialist's private mesh inbox",
        security: [{ oauth: ["mesh:inbox"] }],
        responses: standardResponses(),
      },
    },
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
  if (url.pathname === "/ping" && request.method === "GET") {
    return Response.json(buildHealthPayload(env), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === "/v1/session" && request.method === "GET") {
    try {
      return Response.json(verifiedPrincipalView(principal), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return normalizedError(
        error?.code || "IDENTITY_SCOPE_DENIED",
        Number.isInteger(error?.status) ? error.status : 403,
        requestId(),
      );
    }
  }
  if (url.pathname === "/v1/mesh/inbox" && request.method === "GET") {
    return handleMeshInboxRequest(request, { env, principal });
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

export function verifiedPrincipalView(principal) {
  if (
    principal?.role !== "specialist"
    || !principal?.specialist_id
    || !principal?.capabilities?.includes("identity.read")
  ) {
    throw Object.assign(new Error("IDENTITY_SCOPE_DENIED"), {
      code: "IDENTITY_SCOPE_DENIED",
      status: 403,
    });
  }
  const sorted = value => [...new Set(value ?? [])].map(String).sort();
  return {
    authenticated: true,
    tenant_id: principal.tenant_id,
    principal_id: principal.specialist_id,
    role: "specialist",
    specialist_id: principal.specialist_id,
    project_ids: sorted(principal.project_ids),
    domain_ids: sorted(principal.domain_ids),
    memory_domains: sorted(principal.memory_domains),
    lane_permissions: sorted(principal.lane_permissions),
    oauth_scopes: sorted(principal.scopes),
    capabilities: sorted(principal.capabilities),
    package_version: String(principal.package_version ?? ""),
    grant_version: String(principal.grant_version ?? ""),
  };
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
