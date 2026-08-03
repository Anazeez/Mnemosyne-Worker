import {
  OAuthError,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";

import legacyWorker from "./index.js";
import {
  OAUTH_PROVIDER_OPTIONS,
  createOAuthDefaultHandler,
  refreshGrantProps,
} from "./oauth.js";
import {
  assertCurrentSpecialistPackage,
  principalFromOAuthClaims,
} from "./graph-memory/policy.js";
import {
  GRAPH_MEMORY_SERVICES,
  handleMcpRequest,
} from "./mcp.js";
import {
  handleMatrixIdentityRequest,
  handleOpenApiRequest,
} from "./openapi.js";
import {
  featureGatedGraphServices,
  graphMemoryFeatureState,
} from "./graph-memory/flags.js";
import { handleHumanReviewRequest } from "./graph-memory/human-review.js";
import {
  handleMeshInboxRequest,
  handleMeshIngressRequest,
} from "./mesh/routes.js";

const protectedApi = {
  async fetch(request, env, ctx) {
    const principal = principalFromOAuthClaims(ctx?.props);
    try {
      assertCurrentSpecialistPackage(
        principal,
        env.SPECIALIST_PACKAGE_VERSION,
      );
    } catch {
      return Response.json(
        { error: "specialist_package_stale" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const path = new URL(request.url).pathname;
    const featureState = graphMemoryFeatureState(env);
    const services = featureGatedGraphServices(env, GRAPH_MEMORY_SERVICES);
    if (path === "/mcp") {
      if (!featureState.mcp) return new Response("Not found", { status: 404 });
      return handleMcpRequest(request, { env, principal, services });
    }
    if (path === "/v1/mesh/inbox") {
      return handleMeshInboxRequest(request, { env, principal });
    }
    if (path.startsWith("/admin/memory/candidates")) {
      if (!featureState.review || !featureState.publication) {
        return new Response("Not found", { status: 404 });
      }
      return handleHumanReviewRequest(request, { env, principal });
    }
    if (!featureState.actions) {
      return new Response("Not found", { status: 404 });
    }
    return handleOpenApiRequest(request, { env, principal, services });
  },
};

export const publicAndLegacyApi = {
  async fetch(request, env, ctx) {
    if (
      new URL(request.url).pathname === "/v1/identity"
      && request.method === "GET"
    ) {
      return handleMatrixIdentityRequest(request, env);
    }
    if (
      new URL(request.url).pathname === "/v1/mesh/messages"
      && request.method === "POST"
    ) {
      return handleMeshIngressRequest(request, { env });
    }
    if (
      ["/openapi.json", "/ping"].includes(new URL(request.url).pathname) &&
      request.method === "GET"
    ) {
      return handleOpenApiRequest(request, { env });
    }
    return legacyWorker.fetch(request, env, ctx);
  },
};

export const oauthWorker = new OAuthProvider({
  ...OAUTH_PROVIDER_OPTIONS,
  tokenExchangeCallback: async options => {
    if (options.grantType !== "refresh_token") return;
    try {
      const newProps = await refreshGrantProps(options.props);
      return { accessTokenProps: newProps, newProps };
    } catch {
      throw new OAuthError("invalid_grant", {
        description: "grant_refresh_denied",
      });
    }
  },
  apiHandler: protectedApi,
  defaultHandler: createOAuthDefaultHandler({ legacyWorker: publicAndLegacyApi }),
});

export default oauthWorker;
