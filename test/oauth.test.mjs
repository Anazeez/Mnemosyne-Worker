import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import {
  OAUTH_PROVIDER_OPTIONS,
  assertAllowedGithubUser,
  assistantIdForOAuthClient,
  buildGrantClaims,
  createOAuthDefaultHandler,
  narrowRequestedScopes,
  parseAllowedGithubUserIds,
  redactOAuthError,
} from "../src/oauth.js";
import { buildDeploymentConfig } from "../scripts/cloudflare-binding-preflight.mjs";

test("OAuth requests are narrowed to supported public scopes", () => {
  assert.deepEqual(
    narrowRequestedScopes([
      "memory:read",
      "memory:search",
      "admin",
      "memory:read",
    ]),
    ["memory:read", "memory:search"],
  );
  assert.throws(
    () => narrowRequestedScopes(["admin"]),
    /no_supported_scope_requested/,
  );
});

test("OAuth provider requires S256 PKCE and disables implicit and token exchange grants", () => {
  assert.equal(OAUTH_PROVIDER_OPTIONS.allowPlainPKCE, false);
  assert.equal(OAUTH_PROVIDER_OPTIONS.allowImplicitFlow, false);
  assert.equal(OAUTH_PROVIDER_OPTIONS.allowTokenExchangeGrant, false);
  assert.deepEqual(OAUTH_PROVIDER_OPTIONS.apiRoute, ["/mcp", "/v1/memory/"]);
});

test("only the immutable authorized GitHub owner ID is accepted", () => {
  const allowed = parseAllowedGithubUserIds("277895262");
  assert.equal(
    assertAllowedGithubUser(
      { id: 277895262, login: "Anazeez" },
      allowed,
    ),
    277895262,
  );
  assert.throws(
    () => assertAllowedGithubUser(
      { id: 7, login: "Anazeez" },
      allowed,
    ),
    /github_identity_not_authorized/,
  );
  assert.throws(
    () => parseAllowedGithubUserIds("not-an-id"),
    /github_allowlist_missing/,
  );
});

test("assistant attribution is stable and bound to the OAuth client", async () => {
  const first = await assistantIdForOAuthClient("client-a");
  assert.equal(first, await assistantIdForOAuthClient("client-a"));
  assert.notEqual(first, await assistantIdForOAuthClient("client-b"));
  assert.match(first, /^oauth-[a-f0-9]{32}$/);
});

test("grant claims bind tenant, subject, and narrowed scopes", () => {
  assert.deepEqual(
    buildGrantClaims({
      githubUser: { id: 42, login: "octocat" },
      tenantId: "personal",
      assistantId: "oauth-0123456789abcdef0123456789abcdef",
      projectIds: ["mnemosyne"],
      requestedScopes: ["memory:search", "unknown"],
    }),
    {
      userId: "github-42",
      scope: ["memory:search"],
      metadata: {
        identity_provider: "github",
        github_login: "octocat",
        tenant_id: "personal",
      },
      props: {
        auth_source: "oauth",
        credential_id: "github-42",
        assistant_id: "oauth-0123456789abcdef0123456789abcdef",
        principal_id: "github:42",
        role: "portal",
        tenant_id: "personal",
        project_ids: ["mnemosyne"],
        identity_ids: [],
        scopes: ["memory:search"],
      },
    },
  );
});

test("an invalid Authorization header never falls back to X-Matrix-Key", async () => {
  const response = await worker.fetch(
    new Request("https://memory.example/api/ariadne/core/status", {
      headers: {
        Authorization: "Bearer definitely-invalid",
        "X-Matrix-Key": "legacy-root-key",
      },
    }),
    { MATRIX_AUTH_KEY: "legacy-root-key" },
  );
  assert.equal(response.status, 401);
});

test("OAuth errors redact access tokens, codes, and client secrets", () => {
  const redacted = redactOAuthError(
    "exchange failed access_token=gho_secret code=abc client_secret=hunter2",
  );
  assert.doesNotMatch(redacted, /gho_secret|abc|hunter2/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("authorization renders explicit narrowed consent and sets a CSRF cookie", async () => {
  const kv = memoryKv();
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const response = await handler.fetch(
    new Request("https://memory.example/authorize?client_id=client"),
    oauthEnvironment(kv),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const body = await response.text();
  assert.match(body, /memory:read/);
  assert.doesNotMatch(body, /admin/);
  assert.match(body, /Continue with GitHub/);
});

test("authorization rejects a mismatched CSRF token before GitHub redirect", async () => {
  const kv = memoryKv();
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const consent = await handler.fetch(
    new Request("https://memory.example/authorize?client_id=client"),
    oauthEnvironment(kv),
  );
  const html = await consent.text();
  const requestId = html.match(/request=([^"]+)/)[1];
  const response = await handler.fetch(
    new Request(`https://memory.example/authorize?request=${requestId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "mnemosyne_csrf=wrong",
      },
      body: "csrf=also-wrong",
    }),
    oauthEnvironment(kv),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "oauth_request_failed",
    detail: "csrf_validation_failed",
  });
});

test("deployment preflight preserves the OAUTH_KV binding", () => {
  const config = buildDeploymentConfig(
    {
      bindings: [
        { type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-id" },
      ],
    },
    {
      databaseId: "db-id",
      migrationsDir: "migrations",
      entrypoint: "src/worker.js",
    },
  );
  assert.deepEqual(config.kv_namespaces, [
    { binding: "OAUTH_KV", id: "kv-id" },
  ]);
});

function oauthEnvironment(kv) {
  return {
    OAUTH_KV: kv,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({
        responseType: "code",
        clientId: "client",
        redirectUri: "https://client.example/callback",
        scope: ["memory:read", "admin"],
        state: "client-state",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
      }),
      lookupClient: async () => ({ clientName: "Test Assistant" }),
    },
  };
}

function memoryKv() {
  const values = new Map();
  return {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
  };
}
