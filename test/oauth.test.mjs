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
  refreshGrantProps,
  redactOAuthError,
} from "../src/oauth.js";
import { approveAssistantGrant } from "../src/graph-memory/grants.js";
import { buildDeploymentConfig } from "../scripts/cloudflare-binding-preflight.mjs";
import {
  migratedGraphMemoryEnvironment,
} from "./helpers/d1-graph-memory.mjs";

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
  assert.throws(
    () => narrowRequestedScopes(["memory:review"]),
    /no_supported_scope_requested/,
  );
  assert.deepEqual(
    narrowRequestedScopes(["memory:review"], { allowReview: true }),
    ["memory:review"],
  );
});

test("OAuth provider requires S256 PKCE and disables implicit and token exchange grants", () => {
  assert.equal(OAUTH_PROVIDER_OPTIONS.allowPlainPKCE, false);
  assert.equal(OAUTH_PROVIDER_OPTIONS.allowImplicitFlow, false);
  assert.equal(OAUTH_PROVIDER_OPTIONS.allowTokenExchangeGrant, false);
  assert.deepEqual(OAUTH_PROVIDER_OPTIONS.scopesSupported, [
    "memory:read",
    "memory:search",
    "memory:propose",
    "memory:candidate:read",
  ]);
  assert.deepEqual(
    OAUTH_PROVIDER_OPTIONS.resourceMetadata.scopes_supported,
    OAUTH_PROVIDER_OPTIONS.scopesSupported,
  );
  assert.doesNotMatch(
    JSON.stringify(OAUTH_PROVIDER_OPTIONS.resourceMetadata),
    /memory:review/,
  );
  assert.deepEqual(OAUTH_PROVIDER_OPTIONS.apiRoute, [
    "/mcp",
    "/v1/memory/",
    "/admin/memory/",
  ]);
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

test("OAuth authorization resolves project claims from D1 grants", async () => {
  const kv = memoryKv();
  const env = await migratedGraphMemoryEnvironment(oauthEnvironment(kv));
  env.AUTHORIZED_GITHUB_USER_IDS = "277895262";
  env.MEMORY_TENANT_ID = "personal";
  env.GRANT_RESOLVER_TOKEN = "resolver-token-with-at-least-32-characters";
  let completed;
  env.OAUTH_PROVIDER.completeAuthorization = async claims => {
    completed = claims;
    return { redirectTo: "https://client.example/callback?code=issued" };
  };
  const assistantId = await assistantIdForOAuthClient("client");
  await approveAssistantGrant(env.DB, {
    tenant_id: "personal",
    owner_github_id: 277895262,
    assistant_id: assistantId,
    project_id: "project-alpha",
    capabilities: ["memory.read", "memory.search"],
    approved_by: "owner:277895262",
    reason: "owner approved project access",
    idempotency_key: "grant-project-alpha",
    permanent: true,
    now: "2026-07-27T00:00:00.000Z",
  });
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
    fetchImpl: async (url) => {
      if (String(url).includes("access_token")) {
        return Response.json({ access_token: "github-access" });
      }
      return Response.json({ id: 277895262, login: "Anazeez" });
    },
  });

  const consent = await handler.fetch(
    new Request("https://memory.example/authorize?client_id=client"),
    env,
  );
  const html = await consent.text();
  const requestId = html.match(/request=([^"]+)/)[1];
  const csrf = html.match(/name="csrf" value="([^"]+)/)[1];
  const githubRedirect = await handler.fetch(
    new Request(`https://memory.example/authorize?request=${requestId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mnemosyne_csrf=${csrf}`,
      },
      body: `csrf=${encodeURIComponent(csrf)}`,
    }),
    env,
  );
  const githubState = new URL(
    githubRedirect.headers.get("location"),
  ).searchParams.get("state");
  const callback = await handler.fetch(
    new Request(
      `https://memory.example/callback?state=${githubState}&code=github-code`,
    ),
    env,
  );

  assert.equal(callback.status, 302);
  assert.deepEqual(completed.props.project_ids, [
    "global-canon",
    "project-alpha",
  ]);
  assert.match(completed.props.grant_version, /^[a-f0-9]{64}$/);
  assert.equal(completed.props.owner_github_id, 277895262);
  assert.equal(completed.props.assistant_id, assistantId);
  assert.equal(
    completed.props.grant_resolver_url,
    "https://memory.example/internal/oauth/grants",
  );
  assert.equal(
    completed.props.grant_resolver_token,
    "resolver-token-with-at-least-32-characters",
  );
});

test("refresh resolves the current project grant through the private resolver", async () => {
  const calls = [];
  const props = {
    owner_github_id: 277895262,
    assistant_id: "oauth-0123456789abcdef0123456789abcdef",
    tenant_id: "personal",
    project_ids: ["global-canon"],
    grant_version: "old-version",
    grant_resolver_url: "https://memory.example/internal/oauth/grants",
    grant_resolver_token: "resolver-token-with-at-least-32-characters",
  };
  const refreshed = await refreshGrantProps(props, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        project_ids: ["global-canon", "project-alpha"],
        grant_version: "b".repeat(64),
      });
    },
  });

  assert.deepEqual(refreshed.project_ids, [
    "global-canon",
    "project-alpha",
  ]);
  assert.equal(refreshed.grant_version, "b".repeat(64));
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].init.headers.Authorization,
    "Bearer resolver-token-with-at-least-32-characters",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    tenant_id: "personal",
    owner_github_id: 277895262,
    assistant_id: "oauth-0123456789abcdef0123456789abcdef",
  });
});

test("refresh denies a failed private grant resolution", async () => {
  await assert.rejects(
    refreshGrantProps({
      owner_github_id: 277895262,
      assistant_id: "oauth-0123456789abcdef0123456789abcdef",
      tenant_id: "personal",
      grant_resolver_url: "https://memory.example/internal/oauth/grants",
      grant_resolver_token: "resolver-token-with-at-least-32-characters",
    }, {
      fetchImpl: async () => Response.json(
        { error: "grant_denied" },
        { status: 403 },
      ),
    }),
    /grant_refresh_denied/,
  );
});

test("private grant resolver requires its secret and returns current D1 grants", async () => {
  const kv = memoryKv();
  const env = await migratedGraphMemoryEnvironment(oauthEnvironment(kv));
  env.AUTHORIZED_GITHUB_USER_IDS = "277895262";
  env.GRANT_RESOLVER_TOKEN = "resolver-token-with-at-least-32-characters";
  const assistantId = await assistantIdForOAuthClient("client");
  await approveAssistantGrant(env.DB, {
    tenant_id: "personal",
    owner_github_id: 277895262,
    assistant_id: assistantId,
    project_id: "project-alpha",
    capabilities: ["memory.read"],
    approved_by: "owner:277895262",
    reason: "owner approved project access",
    idempotency_key: "grant-resolver-alpha",
    permanent: true,
    now: "2026-07-27T00:00:00.000Z",
  });
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const body = JSON.stringify({
    tenant_id: "personal",
    owner_github_id: 277895262,
    assistant_id: assistantId,
  });
  const denied = await handler.fetch(
    new Request("https://memory.example/internal/oauth/grants", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong",
        "Content-Type": "application/json",
      },
      body,
    }),
    env,
  );
  assert.equal(denied.status, 403);

  const allowed = await handler.fetch(
    new Request("https://memory.example/internal/oauth/grants", {
      method: "POST",
      headers: {
        Authorization:
          "Bearer resolver-token-with-at-least-32-characters",
        "Content-Type": "application/json",
      },
      body,
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).project_ids, [
    "global-canon",
    "project-alpha",
  ]);
});

test("private grant administration requires the root key and writes receipts", async () => {
  const env = await migratedGraphMemoryEnvironment({
    ...oauthEnvironment(memoryKv()),
    MATRIX_AUTH_KEY: "root-key-with-at-least-20-characters",
    AUTHORIZED_GITHUB_USER_IDS: "277895262",
    MEMORY_TENANT_ID: "personal",
  });
  const assistantId = await assistantIdForOAuthClient("orchestrator-client");
  const operation = {
    command: "approve",
    dryRun: false,
    input: {
      tenant_id: "personal",
      owner_github_id: 277895262,
      assistant_id: assistantId,
      project_id: "*",
      capabilities: ["memory.read", "memory.search"],
      approved_by: "owner:277895262",
      reason: "owner approved orchestrator project access",
      idempotency_key: "grant-orchestrator-all",
      now: "2026-07-27T12:00:00.000Z",
      starts_at: "2026-07-27T12:00:00.000Z",
      expires_at: null,
      permanent: true,
    },
  };
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const denied = await handler.fetch(
    new Request("https://memory.example/internal/admin/memory/grants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-Key": "wrong",
      },
      body: JSON.stringify(operation),
    }),
    env,
  );
  assert.equal(denied.status, 403);
  assert.equal(await env.DB.count("memory_access_grants"), 0);

  const approved = await handler.fetch(
    new Request("https://memory.example/internal/admin/memory/grants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-Key": "root-key-with-at-least-20-characters",
      },
      body: JSON.stringify(operation),
    }),
    env,
  );
  assert.equal(approved.status, 200);
  const result = await approved.json();
  assert.equal(result.project_id, "*");
  assert.equal(result.assistant_id, assistantId);
  assert.equal(await env.DB.count("memory_access_grants"), 1);
  assert.equal(await env.DB.count("memory_authorization_receipts"), 1);
});

test("OpenAI Apps challenge returns only the configured token", async () => {
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const response = await handler.fetch(
    new Request(
      "https://memory.azzayezz.com/.well-known/openai-apps-challenge",
    ),
    {
      OPENAI_APPS_CHALLENGE: "openai-domain-challenge-token",
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "openai-domain-challenge-token");
  assert.match(
    response.headers.get("content-type"),
    /^text\/plain; charset=utf-8$/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("OpenAI Apps challenge is absent when unconfigured and rejects writes", async () => {
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const missing = await handler.fetch(
    new Request(
      "https://memory.azzayezz.com/.well-known/openai-apps-challenge",
    ),
    {},
  );
  assert.equal(missing.status, 404);
  const write = await handler.fetch(
    new Request(
      "https://memory.azzayezz.com/.well-known/openai-apps-challenge",
      { method: "POST" },
    ),
    { OPENAI_APPS_CHALLENGE: "openai-domain-challenge-token" },
  );
  assert.equal(write.status, 405);
});

test("owner review grants require both owner identity and review client", () => {
  assert.deepEqual(
    buildGrantClaims({
      githubUser: { id: 42, login: "owner" },
      tenantId: "personal",
      projectIds: ["mnemosyne"],
      requestedScopes: ["memory:review"],
      allowOwnerReview: true,
    }).props,
    {
      auth_source: "oauth",
      credential_id: "github-42",
      assistant_id: "human-review-console",
      principal_id: "owner",
      role: "owner",
      tenant_id: "personal",
      project_ids: ["mnemosyne"],
      identity_ids: [],
      scopes: ["memory:review"],
    },
  );
  assert.throws(
    () => buildGrantClaims({
      githubUser: { id: 42, login: "owner" },
      tenantId: "personal",
      projectIds: ["mnemosyne"],
      requestedScopes: ["memory:review"],
      allowOwnerReview: false,
    }),
    /no_supported_scope_requested/,
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
