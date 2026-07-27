import { PUBLIC_SCOPE_CAPABILITIES } from "./graph-memory/policy.js";
import {
  approveAssistantGrant,
  resolveAssistantGrant,
  revokeAssistantGrant,
} from "./graph-memory/grants.js";

const OAUTH_STATE_TTL_SECONDS = 600;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
export const PUBLIC_OAUTH_SCOPES = Object.freeze(Object.keys(PUBLIC_SCOPE_CAPABILITIES));

export const OAUTH_PROVIDER_OPTIONS = Object.freeze({
  apiRoute: Object.freeze(["/mcp", "/v1/memory/"]),
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: PUBLIC_OAUTH_SCOPES,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  allowTokenExchangeGrant: false,
  disallowPublicClientRegistration: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
  clientRegistrationTTL: 7776000,
  resourceMetadata: Object.freeze({
    scopes_supported: PUBLIC_OAUTH_SCOPES,
    bearer_methods_supported: Object.freeze(["header"]),
    resource_name: "Mnemosyne Shared Memory",
  }),
});

export function narrowRequestedScopes(requested) {
  const supported = new Set(PUBLIC_OAUTH_SCOPES);
  const narrowed = [...new Set(requested ?? [])].filter(scope => supported.has(scope));
  if (narrowed.length === 0) throw new Error("no_supported_scope_requested");
  return narrowed;
}

export function parseAllowedGithubUserIds(value) {
  const ids = String(value || "")
    .split(",")
    .map(item => Number(item.trim()))
    .filter(Number.isSafeInteger)
    .filter(id => id > 0);
  if (ids.length === 0) {
    throw statusError("github_allowlist_missing", 503);
  }
  return new Set(ids);
}

export function assertAllowedGithubUser(githubUser, allowedIds) {
  const id = Number(githubUser?.id);
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !(allowedIds instanceof Set) ||
    !allowedIds.has(id)
  ) {
    throw statusError("github_identity_not_authorized", 403);
  }
  return id;
}

export async function assistantIdForOAuthClient(clientId) {
  const normalized = String(clientId || "").trim();
  if (!normalized) throw statusError("oauth_client_identity_missing", 400);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const suffix = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  return `oauth-${suffix}`;
}

export async function refreshGrantProps(props, { fetchImpl = fetch } = {}) {
  const url = new URL(String(props?.grant_resolver_url || ""));
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/internal/oauth/grants" ||
    url.search ||
    url.hash
  ) {
    throw new Error("grant_refresh_denied");
  }
  const resolverToken = String(props?.grant_resolver_token || "");
  if (resolverToken.length < 32) {
    throw new Error("grant_refresh_denied");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${resolverToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tenant_id: props.tenant_id,
      owner_github_id: props.owner_github_id,
      assistant_id: props.assistant_id,
    }),
  });
  if (!response.ok) {
    throw new Error("grant_refresh_denied");
  }
  const grant = await response.json();
  if (
    !Array.isArray(grant?.project_ids) ||
    !grant.project_ids.every(value => typeof value === "string") ||
    !/^[a-f0-9]{64}$/.test(String(grant?.grant_version || ""))
  ) {
    throw new Error("grant_refresh_denied");
  }
  return {
    ...props,
    project_ids: [...new Set(grant.project_ids)].sort(),
    grant_version: grant.grant_version,
  };
}

export function buildGrantClaims({
  githubUser,
  tenantId,
  assistantId,
  projectIds = [],
  requestedScopes,
}) {
  const scope = narrowRequestedScopes(requestedScopes);
  const numericId = Number(githubUser?.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error("invalid_github_identity");
  }
  if (!tenantId || typeof tenantId !== "string") throw new Error("invalid_tenant");
  if (!/^oauth-[a-f0-9]{32}$/.test(String(assistantId || ""))) {
    throw new Error("invalid_assistant_identity");
  }
  const login = String(githubUser.login ?? "");
  return {
    userId: `github-${numericId}`,
    scope,
    metadata: {
      identity_provider: "github",
      github_login: login,
      tenant_id: tenantId,
    },
      props: {
        auth_source: "oauth",
        credential_id: `github-${numericId}`,
        assistant_id: assistantId,
        principal_id: `github:${numericId}`,
        role: "portal",
        tenant_id: tenantId,
        project_ids: [...new Set(projectIds.map(String))],
        identity_ids: [],
        scopes: scope,
      },
  };
}

export function redactOAuthError(error) {
  return String(error?.message ?? error)
    .replace(/\b(access_token|refresh_token|code|client_secret)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

export function createOAuthDefaultHandler({ legacyWorker, fetchImpl = fetch }) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/.well-known/openai-apps-challenge") {
          if (request.method !== "GET") {
            return new Response("Method not allowed", {
              status: 405,
              headers: { Allow: "GET" },
            });
          }
          const challenge = String(env.OPENAI_APPS_CHALLENGE || "");
          if (!challenge) return new Response("Not found", { status: 404 });
          return new Response(challenge, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
        if (
          url.pathname === "/internal/oauth/grants" &&
          request.method === "POST"
        ) {
          return await resolvePrivateGrant(request, env);
        }
        if (
          url.pathname === "/internal/admin/memory/grants" &&
          request.method === "POST"
        ) {
          return await administerPrivateGrant(request, env);
        }
        if (url.pathname === "/authorize" && request.method === "GET") {
          return await beginConsent(request, env);
        }
        if (url.pathname === "/authorize" && request.method === "POST") {
          return await acceptConsent(request, env);
        }
        if (url.pathname === "/callback" && request.method === "GET") {
          return await finishGitHubIdentity(request, env, fetchImpl);
        }
        return await legacyWorker.fetch(request, env, ctx);
      } catch (error) {
        return Response.json(
          { error: "oauth_request_failed", detail: redactOAuthError(error) },
          { status: oauthErrorStatus(error) },
        );
      }
    },
  };
}

async function administerPrivateGrant(request, env) {
  const configuredKey = String(env.MATRIX_AUTH_KEY || "");
  const suppliedKey = request.headers.get("X-Matrix-Key") || "";
  if (
    configuredKey.length < 20 ||
    !(await constantTimeEqual(configuredKey, suppliedKey))
  ) {
    return Response.json({ error: "grant_admin_denied" }, { status: 403 });
  }
  if (!env.DB) {
    return Response.json({ error: "grant_admin_unavailable" }, { status: 503 });
  }
  const operation = await request.json();
  if (operation?.dryRun === true) {
    return Response.json({ error: "dry_run_is_local_only" }, { status: 400 });
  }
  const input = operation?.input || {};
  assertAdminGrantTarget(input, env);
  if (operation?.command === "approve") {
    return Response.json(await approveAssistantGrant(env.DB, input), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (operation?.command === "revoke") {
    return Response.json(await revokeAssistantGrant(env.DB, input), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (operation?.command === "list-active") {
    const grant = await resolveAssistantGrant(env.DB, {
      tenantId: input.tenant_id,
      ownerGithubId: input.owner_github_id,
      assistantId: input.assistant_id,
      now: input.now,
    });
    return Response.json({
      assistant_id: input.assistant_id,
      status: "active",
      project_ids: grant.project_ids,
      grant_version: grant.grant_version,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  return Response.json({ error: "grant_admin_command_invalid" }, { status: 400 });
}

function assertAdminGrantTarget(input, env) {
  const ownerGithubId = Number(input?.owner_github_id);
  if (input?.grant_id) return;
  assertAllowedGithubUser(
    { id: ownerGithubId },
    parseAllowedGithubUserIds(env.AUTHORIZED_GITHUB_USER_IDS),
  );
  const tenantId = String(env.MEMORY_TENANT_ID || "personal");
  if (input?.tenant_id !== tenantId) {
    throw statusError("grant_admin_tenant_denied", 403);
  }
}

async function resolvePrivateGrant(request, env) {
  const configuredToken = String(env.GRANT_RESOLVER_TOKEN || "");
  const suppliedToken = bearerToken(request);
  if (
    configuredToken.length < 32 ||
    !(await constantTimeEqual(configuredToken, suppliedToken))
  ) {
    return Response.json({ error: "grant_resolution_denied" }, { status: 403 });
  }
  if (!env.DB) {
    return Response.json(
      { error: "grant_resolution_unavailable" },
      { status: 503 },
    );
  }
  const body = await request.json();
  const ownerGithubId = Number(body?.owner_github_id);
  assertAllowedGithubUser(
    { id: ownerGithubId },
    parseAllowedGithubUserIds(env.AUTHORIZED_GITHUB_USER_IDS),
  );
  const tenantId = String(env.MEMORY_TENANT_ID || "personal");
  if (body?.tenant_id !== tenantId) {
    return Response.json({ error: "grant_resolution_denied" }, { status: 403 });
  }
  const grant = await resolveAssistantGrant(env.DB, {
    tenantId,
    ownerGithubId,
    assistantId: body?.assistant_id,
    now: new Date().toISOString(),
  });
  return Response.json(grant, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function beginConsent(request, env) {
  requireOAuthBindings(env);
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return Response.json({ error: "unknown_client" }, { status: 400 });
  const scopes = narrowRequestedScopes(authRequest.scope);
  const requestId = randomToken();
  const csrf = randomToken();
  await env.OAUTH_KV.put(
    stateKey(requestId),
    JSON.stringify({ stage: "consent", authRequest, scopes, csrf }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  const clientName = escapeHtml(client.clientName || client.client_name || authRequest.clientId);
  const scopeList = scopes.map(scope => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Authorize Mnemosyne</title></head>` +
    `<body><main><h1>Authorize ${clientName}</h1><p>Grant only these memory capabilities:</p>` +
    `<ul>${scopeList}</ul><form method="post" action="/authorize?request=${encodeURIComponent(requestId)}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button type="submit">Continue with GitHub</button></form></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": csrfCookie(csrf),
      },
    },
  );
}

async function acceptConsent(request, env) {
  requireOAuthBindings(env);
  const requestId = new URL(request.url).searchParams.get("request");
  const stored = await readState(env, requestId, "consent");
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  if (!csrf || csrf !== stored.csrf || csrf !== readCookie(request, "mnemosyne_csrf")) {
    throw statusError("csrf_validation_failed", 403);
  }
  const githubState = randomToken();
  await env.OAUTH_KV.delete(stateKey(requestId));
  await env.OAUTH_KV.put(
    stateKey(githubState),
    JSON.stringify({
      stage: "github",
      authRequest: stored.authRequest,
      scopes: stored.scopes,
    }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  const callback = `${new URL(request.url).origin}/callback`;
  const destination = new URL(GITHUB_AUTHORIZE_URL);
  destination.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  destination.searchParams.set("redirect_uri", callback);
  destination.searchParams.set("scope", "read:user");
  destination.searchParams.set("state", githubState);
  return Response.redirect(destination, 302);
}

async function finishGitHubIdentity(request, env, fetchImpl) {
  requireOAuthBindings(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) throw statusError("invalid_github_callback", 400);
  const stored = await readState(env, state, "github");
  await env.OAUTH_KV.delete(stateKey(state));

  const tokenResponse = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw statusError(`github_token_exchange_failed status=${tokenResponse.status}`, 502);
  }
  const userResponse = await fetchImpl(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "mnemosyne-shared-memory",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const githubUser = await userResponse.json();
  if (!userResponse.ok) {
    throw statusError(`github_identity_failed status=${userResponse.status}`, 502);
  }
  const ownerGithubId = assertAllowedGithubUser(
    githubUser,
    parseAllowedGithubUserIds(env.AUTHORIZED_GITHUB_USER_IDS),
  );
  const assistantId = await assistantIdForOAuthClient(
    stored.authRequest.clientId,
  );
  if (!env.DB) throw statusError("grant_database_missing", 503);
  const grant = await resolveAssistantGrant(env.DB, {
    tenantId: env.MEMORY_TENANT_ID || "personal",
    ownerGithubId,
    assistantId,
    now: new Date().toISOString(),
  });
  const claims = buildGrantClaims({
    githubUser,
    tenantId: env.MEMORY_TENANT_ID || "personal",
    assistantId,
    projectIds: grant.project_ids,
    requestedScopes: stored.scopes,
  });
  const resolverToken = String(env.GRANT_RESOLVER_TOKEN || "");
  if (resolverToken.length < 32) {
    throw statusError("grant_resolver_not_configured", 503);
  }
  claims.props.owner_github_id = ownerGithubId;
  claims.props.grant_version = grant.grant_version;
  claims.props.grant_resolver_url =
    `${url.origin}/internal/oauth/grants`;
  claims.props.grant_resolver_token = resolverToken;
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.authRequest,
    ...claims,
  });
  return Response.redirect(redirectTo, 302);
}

function requireOAuthBindings(env) {
  if (!env.OAUTH_KV || !env.OAUTH_PROVIDER) throw statusError("oauth_binding_missing", 503);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw statusError("github_oauth_not_configured", 503);
  }
}

async function readState(env, id, expectedStage) {
  if (!id) throw statusError("oauth_state_missing", 400);
  const raw = await env.OAUTH_KV.get(stateKey(id));
  if (!raw) throw statusError("oauth_state_invalid_or_expired", 400);
  const value = JSON.parse(raw);
  if (value.stage !== expectedStage) throw statusError("oauth_state_stage_invalid", 400);
  return value;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function stateKey(value) {
  return `oauth_state:${value}`;
}

function csrfCookie(value) {
  return `mnemosyne_csrf=${value}; Path=/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_SECONDS}`;
}

function readCookie(request, name) {
  const pairs = (request.headers.get("Cookie") || "").split(";");
  for (const pair of pairs) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function bearerToken(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function constantTimeEqual(expected, actual) {
  const left = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(expected)),
    ),
  );
  const right = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(actual)),
    ),
  );
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

function oauthErrorStatus(error) {
  return Number.isInteger(error?.status) ? error.status : 400;
}
