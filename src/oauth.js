import { PUBLIC_SCOPE_CAPABILITIES } from "./graph-memory/policy.js";
import {
  approveAssistantGrant,
  resolveAssistantGrant,
  revokeAssistantGrant,
} from "./graph-memory/grants.js";
import { normalizeGraphTarget } from "./graph-memory/contracts.js";
import {
  resolveMemoryCandidate,
  validateMemoryCandidate,
} from "./graph-memory/review.js";
import {
  commitOwnerReviewedCandidate,
  getOwnerReviewCandidate,
  reviewMemoryCandidate,
} from "./graph-memory/human-review.js";

const OAUTH_STATE_TTL_SECONDS = 600;
const OWNER_VALIDATION_STATE_PREFIX = "owner-validation.";
const OWNER_RESOLUTION_STATE_PREFIX = "owner-resolution.";
const OWNER_REVIEW_STATE_PREFIX = "owner-review.";
const OWNER_COMMIT_STATE_PREFIX = "owner-commit.";
const CANDIDATE_ID_PATTERN = /^candidate_[a-zA-Z0-9._:-]{8,128}$/;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
export const PUBLIC_OAUTH_SCOPES = Object.freeze(Object.keys(PUBLIC_SCOPE_CAPABILITIES));
export const HUMAN_REVIEW_SCOPE = "memory:review";

export const OAUTH_PROVIDER_OPTIONS = Object.freeze({
  apiRoute: Object.freeze(["/mcp", "/v1/memory/", "/admin/memory/"]),
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

export function narrowRequestedScopes(requested, { allowReview = false } = {}) {
  const supported = new Set([
    ...PUBLIC_OAUTH_SCOPES,
    ...(allowReview ? [HUMAN_REVIEW_SCOPE] : []),
  ]);
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
  allowOwnerReview = false,
}) {
  const scope = narrowRequestedScopes(requestedScopes, {
    allowReview: allowOwnerReview,
  });
  const isOwnerReview = scope.includes(HUMAN_REVIEW_SCOPE);
  const numericId = Number(githubUser?.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error("invalid_github_identity");
  }
  if (!tenantId || typeof tenantId !== "string") throw new Error("invalid_tenant");
  if (!isOwnerReview && !/^oauth-[a-f0-9]{32}$/.test(String(assistantId || ""))) {
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
        principal_id: isOwnerReview ? "owner" : `github:${numericId}`,
        role: isOwnerReview ? "owner" : "portal",
        assistant_id: isOwnerReview ? "human-review-console" : assistantId,
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
        if (url.pathname.startsWith("/owner/memory/candidates/")) {
          if (!["GET", "POST"].includes(request.method)) {
            return new Response("Method not allowed", {
              status: 405,
              headers: { Allow: "GET, POST" },
            });
          }
          return await beginOwnerCandidateAction(request, env);
        }
        if (url.pathname === "/authorize" && request.method === "GET") {
          return await beginConsent(request, env);
        }
        if (url.pathname === "/authorize" && request.method === "POST") {
          return await acceptConsent(request, env);
        }
        if (url.pathname === "/callback" && request.method === "GET") {
          const ownerState = String(url.searchParams.get("state") || "");
          if (
            ownerState.startsWith(OWNER_VALIDATION_STATE_PREFIX) ||
            ownerState.startsWith(OWNER_RESOLUTION_STATE_PREFIX) ||
            ownerState.startsWith(OWNER_REVIEW_STATE_PREFIX) ||
            ownerState.startsWith(OWNER_COMMIT_STATE_PREFIX)
          ) {
            return await finishOwnerCandidateAction(
              request,
              env,
              fetchImpl,
            );
          }
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

async function beginOwnerCandidateAction(request, env) {
  requireOAuthBindings(env);
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/owner\/memory\/candidates\/([^/]+)\/(validate|resolve|review|commit)$/,
  );
  const candidateId = match ? decodeURIComponent(match[1]) : "";
  const operation = match?.[2] || "";
  const config = ownerCandidateActionConfig(operation, env);
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw statusError("candidate_unavailable", 404);
  }
  const target = normalizeGraphTarget({
    tenant_id: url.searchParams.get("tenant_id"),
    project_id: url.searchParams.get("project_id"),
  });
  if (target.tenant_id !== String(env.MEMORY_TENANT_ID || "personal")) {
    throw statusError(config.targetDeniedCode, 403);
  }
  if (
    operation === "review" &&
    request.method === "POST" &&
    url.searchParams.has("decision_request")
  ) {
    return finishOwnerReviewDecision(
      request,
      env,
      config,
      candidateId,
      target
    );
  }
  if (
    operation === "commit" &&
    request.method === "POST" &&
    url.searchParams.has("commit_request")
  ) {
    return finishOwnerCommitDecision(
      request,
      env,
      config,
      candidateId,
      target
    );
  }
  if (request.method === "GET") {
    const requestId = randomToken();
    const csrf = randomToken();
    await env.OAUTH_KV.put(
      stateKey(requestId),
      JSON.stringify({
        stage: config.consentStage,
        action: operation,
        candidate_id: candidateId,
        target,
        csrf,
      }),
      { expirationTtl: OAUTH_STATE_TTL_SECONDS },
    );
    const actionUrl = new URL(url);
    actionUrl.searchParams.set("request", requestId);
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${escapeHtml(config.heading)}</title></head><body><main>` +
      `<h1>${escapeHtml(config.heading)}</h1>` +
      `<p><code>${escapeHtml(candidateId)}</code></p>` +
      `<p>${escapeHtml(config.explanation)}</p>` +
      `<form method="post" action="${escapeHtml(actionUrl)}">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      `<button type="submit">Continue with GitHub</button></form>` +
      `</main></body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": ownerCandidateCsrfCookie(csrf, config),
        },
      },
    );
  }
  const requestId = url.searchParams.get("request");
  const stored = await readState(
    env,
    requestId,
    config.consentStage,
  );
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  if (
    !csrf ||
    csrf !== stored.csrf ||
    csrf !== readCookie(request, config.csrfCookieName)
  ) {
    throw statusError("csrf_validation_failed", 403);
  }
  if (
    stored.candidate_id !== candidateId ||
    stored.action !== operation ||
    stored.target.tenant_id !== target.tenant_id ||
    stored.target.project_id !== target.project_id
  ) {
    throw statusError(config.targetDeniedCode, 403);
  }
  await env.OAUTH_KV.delete(stateKey(requestId));
  const state = `${config.statePrefix}${randomToken()}`;
  await env.OAUTH_KV.put(
    stateKey(state),
    JSON.stringify({
      stage: config.stateStage,
      action: operation,
      candidate_id: stored.candidate_id,
      target: stored.target,
    }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  const destination = new URL(GITHUB_AUTHORIZE_URL);
  destination.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  destination.searchParams.set("redirect_uri", `${url.origin}/callback`);
  destination.searchParams.set("scope", "read:user");
  destination.searchParams.set("state", state);
  return Response.redirect(destination, 302);
}

async function finishOwnerCandidateAction(request, env, fetchImpl) {
  requireOAuthBindings(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const action = state?.startsWith(OWNER_VALIDATION_STATE_PREFIX)
    ? "validate"
    : state?.startsWith(OWNER_RESOLUTION_STATE_PREFIX)
      ? "resolve"
      : state?.startsWith(OWNER_REVIEW_STATE_PREFIX)
        ? "review"
        : state?.startsWith(OWNER_COMMIT_STATE_PREFIX)
          ? "commit"
      : "";
  const config = ownerCandidateActionConfig(action, env);
  if (!state || !code) {
    throw statusError("invalid_github_callback", 400);
  }
  const stored = await readState(env, state, config.stateStage);
  if (stored.action !== action) {
    throw statusError(config.targetDeniedCode, 403);
  }
  await env.OAUTH_KV.delete(stateKey(state));
  const githubUser = await exchangeGithubIdentity(url, env, fetchImpl);
  const ownerGithubId = assertAllowedGithubUser(
    githubUser,
    parseAllowedGithubUserIds(env.AUTHORIZED_GITHUB_USER_IDS),
  );
  if (!env.DB) throw statusError(config.databaseMissingCode, 503);
  const principal = {
    tenant_id: stored.target.tenant_id,
    credential_id: `github-${ownerGithubId}`,
    assistant_id: config.assistantId,
    principal_id: "owner",
    role: "owner",
    project_ids: [stored.target.project_id],
    identity_ids: [],
    capabilities: [config.capability],
  };
  if (action === "review") {
    return renderOwnerReviewDecision({
      request,
      env,
      principal,
      candidateId: stored.candidate_id,
      target: stored.target,
    });
  }
  if (action === "commit") {
    return renderOwnerCommitDecision({
      request,
      env,
      principal,
      candidateId: stored.candidate_id,
      target: stored.target,
    });
  }
  const input = {
    env,
    principal,
    candidateId: stored.candidate_id,
  };
  const result = action === "validate"
    ? await validateMemoryCandidate(input)
    : await resolveMemoryCandidate(input);
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function renderOwnerReviewDecision({
  request,
  env,
  principal,
  candidateId,
  target,
}) {
  const detail = await getOwnerReviewCandidate({
    env,
    principal,
    target,
    candidateId,
  });
  const decisionRequest = randomToken();
  const csrf = randomToken();
  await env.OAUTH_KV.put(
    stateKey(decisionRequest),
    JSON.stringify({
      stage: "owner_review_decision",
      candidate_id: candidateId,
      target,
      credential_id: principal.credential_id,
      csrf,
    }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  const actionUrl = new URL(
    `/owner/memory/candidates/${encodeURIComponent(candidateId)}/review`,
    new URL(request.url).origin,
  );
  actionUrl.searchParams.set("tenant_id", target.tenant_id);
  actionUrl.searchParams.set("project_id", target.project_id);
  actionUrl.searchParams.set("decision_request", decisionRequest);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>Review resolved candidate</title></head><body><main>` +
    `<h1>Review resolved candidate</h1>` +
    `<h2>Assertions</h2><pre>${escapeHtml(JSON.stringify(
      detail.candidate.payload.assertions,
      null,
      2,
    ))}</pre>` +
    `<h2>Evidence</h2><pre>${escapeHtml(JSON.stringify(
      detail.evidence,
      null,
      2,
    ))}</pre>` +
    `<h2>Entity resolution</h2><pre>${escapeHtml(JSON.stringify(
      {
        resolution_receipt_id: detail.resolution.resolution_receipt_id,
        resolutions: detail.resolution.resolutions,
      },
      null,
      2,
    ))}</pre>` +
    `<p>Approval records permission for a later controlled commit. ` +
    `It does not publish memory.</p>` +
    `<form method="post" action="${escapeHtml(actionUrl)}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button name="decision" value="approve_for_commit" type="submit">` +
    `Approve for controlled commit</button>` +
    `<button name="decision" value="reject" type="submit">Reject</button>` +
    `<button name="decision" value="quarantine" type="submit">Quarantine</button>` +
    `</form></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie":
          `mnemosyne_owner_review_decision_csrf=${csrf}; ` +
          `Path=/owner/memory/candidates/; HttpOnly; Secure; SameSite=Lax; ` +
          `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
      },
    },
  );
}

async function finishOwnerReviewDecision(
  request,
  env,
  config,
  candidateId,
  target,
) {
  const url = new URL(request.url);
  const decisionRequest = url.searchParams.get("decision_request");
  const stored = await readState(
    env,
    decisionRequest,
    "owner_review_decision",
  );
  const form = await request.formData();
  const csrf = String(form.get("csrf") || "");
  if (
    !csrf ||
    csrf !== stored.csrf ||
    csrf !== readCookie(request, "mnemosyne_owner_review_decision_csrf")
  ) {
    throw statusError("csrf_validation_failed", 403);
  }
  if (
    stored.candidate_id !== candidateId ||
    stored.target.tenant_id !== target.tenant_id ||
    stored.target.project_id !== target.project_id
  ) {
    throw statusError(config.targetDeniedCode, 403);
  }
  await env.OAUTH_KV.delete(stateKey(decisionRequest));
  const result = await reviewMemoryCandidate({
    env,
    principal: {
      tenant_id: target.tenant_id,
      credential_id: stored.credential_id,
      assistant_id: "human-owner-review-console",
      principal_id: "owner",
      role: "owner",
      project_ids: [target.project_id],
      identity_ids: [],
      capabilities: ["memory.review"],
    },
    target,
    candidateId,
    decision: String(form.get("decision") || ""),
  });
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function renderOwnerCommitDecision({
  request,
  env,
  principal,
  candidateId,
  target,
}) {
  const detail = await getOwnerReviewCandidate({
    env,
    principal: {
      ...principal,
      capabilities: ["memory.review"],
    },
    target,
    candidateId,
  });
  if (detail.owner_review?.decision !== "approve_for_commit") {
    throw statusError("owner_commit_review_required", 409);
  }
  const commitRequest = randomToken();
  const csrf = randomToken();
  await env.OAUTH_KV.put(
    stateKey(commitRequest),
    JSON.stringify({
      stage: "owner_commit_decision",
      candidate_id: candidateId,
      target,
      credential_id: principal.credential_id,
      csrf,
    }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  const actionUrl = new URL(
    `/owner/memory/candidates/${encodeURIComponent(candidateId)}/commit`,
    new URL(request.url).origin,
  );
  actionUrl.searchParams.set("tenant_id", target.tenant_id);
  actionUrl.searchParams.set("project_id", target.project_id);
  actionUrl.searchParams.set("commit_request", commitRequest);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>Controlled memory commit</title></head><body><main>` +
    `<h1>Controlled memory commit</h1>` +
    `<h2>Assertions</h2><pre>${escapeHtml(JSON.stringify(
      detail.candidate.payload.assertions,
      null,
      2,
    ))}</pre>` +
    `<h2>Evidence</h2><pre>${escapeHtml(JSON.stringify(
      detail.evidence,
      null,
      2,
    ))}</pre>` +
    `<h2>Resolution receipt</h2><pre>${escapeHtml(JSON.stringify(
      {
        resolution_receipt_id: detail.resolution.resolution_receipt_id,
        resolutions: detail.resolution.resolutions,
      },
      null,
      2,
    ))}</pre>` +
    `<h2>Owner review receipt</h2><pre>${escapeHtml(JSON.stringify(
      detail.owner_review,
      null,
      2,
    ))}</pre>` +
    `<p>This creates the next accepted-memory generation, plus a rollback ` +
    `snapshot and immutable commit receipt.</p>` +
    `<form method="post" action="${escapeHtml(actionUrl)}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button type="submit">Commit accepted memory</button>` +
    `</form></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie":
          `mnemosyne_owner_commit_decision_csrf=${csrf}; ` +
          `Path=/owner/memory/candidates/; HttpOnly; Secure; SameSite=Lax; ` +
          `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
      },
    },
  );
}

async function finishOwnerCommitDecision(
  request,
  env,
  config,
  candidateId,
  target,
) {
  const url = new URL(request.url);
  const commitRequest = url.searchParams.get("commit_request");
  const stored = await readState(
    env,
    commitRequest,
    "owner_commit_decision",
  );
  const form = await request.formData();
  const csrf = String(form.get("csrf") || "");
  if (
    !csrf ||
    csrf !== stored.csrf ||
    csrf !== readCookie(request, "mnemosyne_owner_commit_decision_csrf")
  ) {
    throw statusError("csrf_validation_failed", 403);
  }
  if (
    stored.candidate_id !== candidateId ||
    stored.target.tenant_id !== target.tenant_id ||
    stored.target.project_id !== target.project_id
  ) {
    throw statusError(config.targetDeniedCode, 403);
  }
  await env.OAUTH_KV.delete(stateKey(commitRequest));
  const result = await commitOwnerReviewedCandidate({
    env,
    principal: {
      tenant_id: target.tenant_id,
      credential_id: stored.credential_id,
      assistant_id: "human-owner-commit-console",
      principal_id: "owner",
      role: "owner",
      project_ids: [target.project_id],
      identity_ids: [],
      capabilities: ["memory.commit"],
    },
    target,
    candidateId,
  });
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
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
  const reviewClients = parseCsv(env.MEMORY_REVIEW_CLIENT_IDS);
  const allowReview = reviewClients.includes(String(authRequest.clientId));
  const scopes = narrowRequestedScopes(authRequest.scope, { allowReview });
  const requestId = randomToken();
  const csrf = randomToken();
  await env.OAUTH_KV.put(
    stateKey(requestId),
    JSON.stringify({
      stage: "consent",
      authRequest,
      scopes,
      csrf,
      allowOwnerReview: allowReview,
    }),
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
      allowOwnerReview: stored.allowOwnerReview,
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
  const githubUser = await exchangeGithubIdentity(url, env, fetchImpl);

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
    allowOwnerReview:
      Boolean(stored.allowOwnerReview) &&
      parseCsv(env.MEMORY_OWNER_GITHUB_IDS).includes(String(githubUser.id)),
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

async function exchangeGithubIdentity(url, env, fetchImpl) {
  const code = url.searchParams.get("code");
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
  return githubUser;
}

function requireOAuthBindings(env) {
  if (!env.OAUTH_KV || !env.OAUTH_PROVIDER) throw statusError("oauth_binding_missing", 503);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw statusError("github_oauth_not_configured", 503);
  }
}

function requireOwnerValidationEnabled(env) {
  if (!["1", "true", "yes", "on"].includes(
    String(env.GRAPH_MEMORY_VALIDATION_ENABLED || "").trim().toLowerCase(),
  )) {
    throw statusError("owner_validation_disabled", 404);
  }
}

function requireOwnerResolutionEnabled(env) {
  if (!["1", "true", "yes", "on"].includes(
    String(env.GRAPH_MEMORY_RESOLUTION_ENABLED || "").trim().toLowerCase(),
  )) {
    throw statusError("owner_resolution_disabled", 404);
  }
}

function requireOwnerReviewEnabled(env) {
  if (!["1", "true", "yes", "on"].includes(
    String(env.GRAPH_MEMORY_OWNER_REVIEW_ENABLED || "").trim().toLowerCase(),
  )) {
    throw statusError("owner_review_disabled", 404);
  }
}

function requireOwnerCommitEnabled(env) {
  if (!["1", "true", "yes", "on"].includes(
    String(env.GRAPH_MEMORY_OWNER_COMMIT_ENABLED || "").trim().toLowerCase(),
  )) {
    throw statusError("owner_commit_disabled", 404);
  }
}

function ownerCandidateActionConfig(action, env) {
  if (action === "validate") {
    requireOwnerValidationEnabled(env);
    return {
      statePrefix: OWNER_VALIDATION_STATE_PREFIX,
      consentStage: "owner_validation_consent",
      stateStage: "owner_validation",
      csrfCookieName: "mnemosyne_owner_validation_csrf",
      heading: "Validate candidate",
      explanation:
        "This runs deterministic validation only. It does not accept or publish memory.",
      targetDeniedCode: "owner_validation_target_denied",
      databaseMissingCode: "owner_validation_database_missing",
      assistantId: "human-validation-console",
      capability: "memory.validate",
    };
  }
  if (action === "resolve") {
    requireOwnerResolutionEnabled(env);
    return {
      statePrefix: OWNER_RESOLUTION_STATE_PREFIX,
      consentStage: "owner_resolution_consent",
      stateStage: "owner_resolution",
      csrfCookieName: "mnemosyne_owner_resolution_csrf",
      heading: "Resolve candidate entities",
      explanation:
        "This runs exact entity resolution only. It does not review, accept, or publish memory.",
      targetDeniedCode: "owner_resolution_target_denied",
      databaseMissingCode: "owner_resolution_database_missing",
      assistantId: "human-resolution-console",
      capability: "memory.resolve",
    };
  }
  if (action === "review") {
    requireOwnerReviewEnabled(env);
    return {
      statePrefix: OWNER_REVIEW_STATE_PREFIX,
      consentStage: "owner_review_consent",
      stateStage: "owner_review",
      csrfCookieName: "mnemosyne_owner_review_csrf",
      heading: "Review resolved candidate",
      explanation:
        "Authenticate to inspect assertions, evidence, and resolution before recording a review decision.",
      targetDeniedCode: "owner_review_target_denied",
      databaseMissingCode: "owner_review_database_missing",
      assistantId: "human-owner-review-console",
      capability: "memory.review",
    };
  }
  if (action === "commit") {
    requireOwnerCommitEnabled(env);
    return {
      statePrefix: OWNER_COMMIT_STATE_PREFIX,
      consentStage: "owner_commit_consent",
      stateStage: "owner_commit",
      csrfCookieName: "mnemosyne_owner_commit_csrf",
      heading: "Controlled memory commit",
      explanation:
        "Authenticate to verify the approved receipts before creating accepted memory.",
      targetDeniedCode: "owner_commit_target_denied",
      databaseMissingCode: "owner_commit_database_missing",
      assistantId: "human-owner-commit-console",
      capability: "memory.commit",
    };
  }
  throw statusError("candidate_unavailable", 404);
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

function ownerCandidateCsrfCookie(value, config) {
  return `${config.csrfCookieName}=${value}; ` +
    `Path=/owner/memory/candidates/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`;
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

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function parseProjectIds(value) {
  return parseCsv(value);
}

function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

function oauthErrorStatus(error) {
  return Number.isInteger(error?.status) ? error.status : 400;
}
