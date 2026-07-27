import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import legacyWorker from "./index.js";
import {
  OAUTH_PROVIDER_OPTIONS,
  createOAuthDefaultHandler,
} from "./oauth.js";

const protectedApi = {
  async fetch() {
    return Response.json(
      { error: "protected_memory_adapter_not_ready" },
      { status: 501 },
    );
  },
};

export const oauthWorker = new OAuthProvider({
  ...OAUTH_PROVIDER_OPTIONS,
  apiHandler: protectedApi,
  defaultHandler: createOAuthDefaultHandler({ legacyWorker }),
});

export default oauthWorker;
