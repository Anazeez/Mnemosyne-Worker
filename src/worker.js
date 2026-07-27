import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import legacyWorker from "./index.js";
import {
  OAUTH_PROVIDER_OPTIONS,
  createOAuthDefaultHandler,
} from "./oauth.js";
import { principalFromOAuthClaims } from "./graph-memory/policy.js";
import { handleMcpRequest } from "./mcp.js";
import { handleOpenApiRequest } from "./openapi.js";

const protectedApi = {
  async fetch(request, env, ctx) {
    const principal = principalFromOAuthClaims(ctx?.props);
    if (new URL(request.url).pathname === "/mcp") {
      return handleMcpRequest(request, { env, principal });
    }
    return handleOpenApiRequest(request, { env, principal });
  },
};

const publicAndLegacyApi = {
  async fetch(request, env, ctx) {
    if (
      new URL(request.url).pathname === "/openapi.json" &&
      request.method === "GET"
    ) {
      return handleOpenApiRequest(request);
    }
    return legacyWorker.fetch(request, env, ctx);
  },
};

export const oauthWorker = new OAuthProvider({
  ...OAUTH_PROVIDER_OPTIONS,
  apiHandler: protectedApi,
  defaultHandler: createOAuthDefaultHandler({ legacyWorker: publicAndLegacyApi }),
});

export default oauthWorker;
