import { executeMemoryOperation } from "./mcp.js";
import { buildHealthPayload } from "./health.js";
import { handleMeshInboxRequest } from "./mesh/routes.js";
import { authenticateLegacyRequest } from "./auth/legacy-credentials.js";
import { retrieveVisualSkills } from "./visual-skills/retrieval.js";

const scopeDescriptions = Object.freeze({
  "identity:read": "Verify the authenticated identity and bounded grants",
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

const boundedId = { type: "string", minLength: 2, maxLength: 128 };
const boundedIdList = {
  type: "array",
  uniqueItems: true,
  items: boundedId,
};
const graphHealthProperties = Object.fromEntries(
  [
    "actions", "mcp", "owner_commit", "owner_review", "propose",
    "publication", "read", "resolution", "review", "validation",
  ].map(name => [name, { type: "boolean" }]),
);
const healthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status", "worker", "d1", "oauth", "graph_memory",
    "specialist_policy_version", "mesh_ingress",
  ],
  properties: {
    status: { const: "ok" },
    worker: { const: "ready" },
    d1: { enum: ["available", "unavailable"] },
    oauth: { enum: ["available", "unavailable"] },
    graph_memory: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(graphHealthProperties),
      properties: graphHealthProperties,
    },
    specialist_policy_version: boundedId,
    mesh_ingress: { enum: ["ready", "unavailable"] },
  },
};
const specialistPrincipalResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "authenticated", "tenant_id", "principal_id", "role", "specialist_id",
    "project_ids", "domain_ids", "memory_domains", "lane_permissions",
    "oauth_scopes", "capabilities", "package_version", "grant_version",
  ],
  properties: {
    authenticated: { const: true },
    tenant_id: boundedId,
    principal_id: boundedId,
    role: { const: "specialist" },
    specialist_id: boundedId,
    project_ids: boundedIdList,
    domain_ids: boundedIdList,
    memory_domains: boundedIdList,
    lane_permissions: boundedIdList,
    oauth_scopes: boundedIdList,
    capabilities: boundedIdList,
    package_version: boundedId,
    grant_version: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
};
const visualPortalPrincipalResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "authenticated", "tenant_id", "principal_id", "role", "assistant_id",
    "project_ids", "domain_ids", "consumer_ids", "oauth_scopes",
    "capabilities", "grant_version", "consumer_grant_version",
  ],
  properties: {
    authenticated: { const: true },
    tenant_id: boundedId,
    principal_id: { const: "general-assistant" },
    role: { const: "portal" },
    assistant_id: { type: "string", pattern: "^oauth-[a-f0-9]{32}$" },
    project_ids: boundedIdList,
    domain_ids: boundedIdList,
    consumer_ids: boundedIdList,
    oauth_scopes: boundedIdList,
    capabilities: boundedIdList,
    grant_version: { type: "string", pattern: "^[a-f0-9]{64}$" },
    consumer_grant_version: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
};
const principalResponseSchema = {
  oneOf: [specialistPrincipalResponseSchema, visualPortalPrincipalResponseSchema],
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
          200: jsonResponse("Bounded Mnemosyne health status", healthResponseSchema),
        },
      },
    },
    "/v1/session": {
      get: {
        operationId: "verifyOAuthPrincipal",
        summary: "Verify the authenticated identity and bounded grants",
        security: [{ oauth: ["identity:read"] }],
        responses: {
          ...standardResponses(),
          200: jsonResponse(
            "Bounded authenticated identity and grants",
            principalResponseSchema,
          ),
        },
      },
    },
    "/v1/identity": {
      get: {
        operationId: "verifyPrincipal",
        summary: "Verify the Matrix-key-bound specialist identity and grants",
        security: [{ matrixKey: [] }],
        responses: {
          ...standardResponses(),
          200: jsonResponse(
            "Bounded Matrix-key-bound specialist identity and grants",
            specialistPrincipalResponseSchema,
          ),
        },
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
    "/v1/skills/retrieval": postOperation(
      "retrieveSkills",
      "Retrieve grounded visual communication capabilities",
      "memory:search",
      {
        ...targetProperties,
        domain_id: { type: "string", const: "visual-design-expression" },
        query: { type: "string", minLength: 1, maxLength: 1_000 },
        top_k: { type: "integer", minimum: 1, maximum: 25 },
        threshold: { type: "number", minimum: 0.5, maximum: 0.95 },
      },
      ["tenant_id", "project_id", "domain_id", "query"],
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
      matrixKey: {
        type: "apiKey",
        in: "header",
        name: "X-Matrix-Key",
      },
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

export async function handleMatrixIdentityRequest(request, env) {
  const packageVersion = String(env?.SPECIALIST_PACKAGE_VERSION ?? "").trim();
  if (!packageVersion) {
    return Response.json(
      { error: "identity_policy_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const principal = await authenticateLegacyRequest(request, env);
  if (!principal) {
    return Response.json(
      { error: "identity_not_authenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const identityPrincipal = {
    ...principal,
    scopes: [],
    capabilities: [...new Set([
      ...(principal.capabilities ?? []),
      "identity.read",
    ])],
    package_version: packageVersion,
  };
  try {
    return Response.json(verifiedPrincipalView(identityPrincipal), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "identity_scope_denied" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
}

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
  if (url.pathname === "/v1/skills/retrieval" && request.method === "POST") {
    try {
      return Response.json(await retrieveVisualSkills({
        env,
        principal,
        input: await request.json(),
      }), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return normalizedError(
        error?.code || "VISUAL_SKILL_RETRIEVAL_FAILED",
        Number.isInteger(error?.status) ? error.status : 500,
        requestId(),
      );
    }
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
    principal?.role === "portal"
    && principal?.principal_id === "general-assistant"
    && principal?.consumer_ids?.includes("general-assistant")
    && principal?.capabilities?.includes("identity.read")
  ) {
    const sorted = value => [...new Set(value ?? [])].map(String).sort();
    return {
      authenticated: true,
      tenant_id: principal.tenant_id,
      principal_id: "general-assistant",
      role: "portal",
      assistant_id: principal.assistant_id,
      project_ids: sorted(principal.project_ids),
      domain_ids: sorted(principal.domain_ids),
      consumer_ids: sorted(principal.consumer_ids),
      oauth_scopes: sorted(principal.scopes),
      capabilities: sorted(principal.capabilities),
      grant_version: String(principal.grant_version ?? ""),
      consumer_grant_version: String(principal.consumer_grant_version ?? ""),
    };
  }
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

function jsonResponse(description, schema) {
  return {
    description,
    content: { "application/json": { schema } },
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
