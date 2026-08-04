import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { principalFromOAuthClaims } from "../src/graph-memory/policy.js";
import {
  buildGrantClaims,
  createOAuthDefaultHandler,
  refreshGrantProps,
} from "../src/oauth.js";
import { approveAssistantGrant } from "../src/graph-memory/grants.js";
import {
  approveVisualSkillConsumer,
  resolveVisualSkillConsumerBinding,
  revokeVisualSkillConsumer,
} from "../src/visual-skills/consumers.js";
import { assistantIdForOAuthClient } from "../src/oauth.js";
import { projectionIdFor } from "../src/visual-skills/contracts.js";
import {
  handleOpenApiRequest,
  OPENAPI_DOCUMENT,
  verifiedPrincipalView,
} from "../src/openapi.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

const clientId = "ordinary-chatgpt-client";
const assistantId = await assistantIdForOAuthClient(clientId);
const now = "2026-08-04T00:00:00.000Z";

async function environment() {
  const env = await migratedGraphMemoryEnvironment();
  env.DB.database.exec(await readFile(
    new URL("../migrations/011_visual_skill_consumers.sql", import.meta.url),
    "utf8",
  ));
  return env;
}

test("active binding resolves one read-only general-assistant consumer", async () => {
  const env = await environment();
  const approved = await approveVisualSkillConsumer(env.DB, {
    assistant_id: assistantId,
    actor_id: "owner:277895262",
    reason: "approved ordinary ChatGPT visual retrieval",
    now,
  });
  assert.equal(approved.consumer_id, "general-assistant");
  assert.equal(approved.project_id, "project-infinitum");
  assert.equal(approved.domain_id, "visual-design-expression");
  assert.deepEqual(approved.allowed_scopes, ["identity:read", "memory:read", "memory:search"]);
  assert.match(approved.grant_version, /^[a-f0-9]{64}$/u);

  const binding = await resolveVisualSkillConsumerBinding(env.DB, assistantId);
  assert.deepEqual(binding, approved);
});

test("grant claims remain portal-only and strip all write or mesh scopes", async () => {
  const env = await environment();
  const binding = await approveVisualSkillConsumer(env.DB, {
    assistant_id: assistantId,
    actor_id: "owner:277895262",
    reason: "approved ordinary ChatGPT visual retrieval",
    now,
  });
  const claims = buildGrantClaims({
    githubUser: { id: 277895262, login: "Anazeez" },
    tenantId: "personal",
    assistantId,
    projectIds: ["other-project", "project-infinitum"],
    requestedScopes: [
      "identity:read", "memory:read", "memory:search", "memory:propose",
      "memory:review", "mesh:inbox",
    ],
    consumerGrant: binding,
    allowOwnerReview: true,
  });
  assert.equal(claims.props.role, "portal");
  assert.equal(claims.props.principal_id, "general-assistant");
  assert.deepEqual(claims.scope, ["identity:read", "memory:read", "memory:search"]);
  assert.deepEqual(claims.props.project_ids, ["project-infinitum"]);
  assert.deepEqual(claims.props.consumer_ids, ["general-assistant"]);
  assert.deepEqual(claims.props.domain_ids, ["visual-design-expression"]);
  assert.equal(claims.props.specialist_id, undefined);

  const principal = principalFromOAuthClaims({
    ...claims.props,
    grant_version: "a".repeat(64),
  });
  assert.equal(principal.role, "portal");
  assert.equal(principal.principal_id, "general-assistant");
  assert.deepEqual(principal.capabilities.sort(), [
    "continuity.read", "identity.read", "memory.read", "memory.search",
  ]);
  for (const denied of [
    "memory.propose", "memory.review", "memory.publish", "memory.commit",
    "memory.rollback", "exchanges.inbox", "mandates.dispatch",
  ]) assert.equal(principal.capabilities.includes(denied), false, denied);
});

test("portal consumer claims reject wildcard, unknown consumer, and missing grant versions", () => {
  const base = {
    tenant_id: "personal",
    credential_id: "github-277895262",
    assistant_id: assistantId,
    principal_id: "general-assistant",
    role: "portal",
    project_ids: ["project-infinitum"],
    identity_ids: [],
    domain_ids: ["visual-design-expression"],
    consumer_ids: ["general-assistant"],
    scopes: ["memory:search"],
    grant_version: "a".repeat(64),
    consumer_grant_version: "b".repeat(64),
  };
  for (const changed of [
    { project_ids: ["*"] },
    { project_ids: ["other-project", "project-infinitum"] },
    { domain_ids: ["*"] },
    { consumer_ids: ["haava"] },
    { grant_version: undefined },
    { consumer_grant_version: undefined },
    { role: "specialist", specialist_id: "haava" },
  ]) {
    assert.throws(
      () => principalFromOAuthClaims({ ...base, ...changed }),
      (error) => error.code === "INVALID_OAUTH_CLAIMS",
    );
  }
});

test("revoke removes binding and stale refresh fails closed while Haava is unrelated", async () => {
  const env = await environment();
  const binding = await approveVisualSkillConsumer(env.DB, {
    assistant_id: assistantId,
    actor_id: "owner:277895262",
    reason: "approved ordinary ChatGPT visual retrieval",
    now,
  });
  await revokeVisualSkillConsumer(env.DB, {
    assistant_id: assistantId,
    actor_id: "owner:277895262",
    reason: "rollback drill consumer revoke",
    now: "2026-08-04T01:00:00.000Z",
  });
  assert.equal(await resolveVisualSkillConsumerBinding(env.DB, assistantId), null);
  await assert.rejects(
    refreshGrantProps({
      tenant_id: "personal",
      owner_github_id: 277895262,
      assistant_id: assistantId,
      role: "portal",
      consumer_ids: ["general-assistant"],
      domain_ids: ["visual-design-expression"],
      consumer_grant_version: binding.grant_version,
      grant_resolver_url: "https://memory.example/internal/oauth/grants",
      grant_resolver_token: "resolver-token-with-at-least-32-characters",
    }, {
      fetchImpl: async () => Response.json({
        project_ids: ["project-infinitum"],
        grant_version: "c".repeat(64),
      }),
    }),
    /grant_refresh_denied/u,
  );
});

test("OAuth session and skills route expose bounded general-assistant identity and retrieval", async () => {
  const principal = principalFromOAuthClaims({
    tenant_id: "personal",
    credential_id: "github-277895262",
    assistant_id: assistantId,
    principal_id: "general-assistant",
    role: "portal",
    project_ids: ["project-infinitum"],
    identity_ids: [],
    domain_ids: ["visual-design-expression"],
    consumer_ids: ["general-assistant"],
    scopes: ["identity:read", "memory:read", "memory:search"],
    grant_version: "a".repeat(64),
    consumer_grant_version: "b".repeat(64),
  });
  assert.deepEqual(verifiedPrincipalView(principal), {
    authenticated: true,
    tenant_id: "personal",
    principal_id: "general-assistant",
    role: "portal",
    assistant_id: assistantId,
    project_ids: ["project-infinitum"],
    domain_ids: ["visual-design-expression"],
    consumer_ids: ["general-assistant"],
    oauth_scopes: ["identity:read", "memory:read", "memory:search"],
    capabilities: ["continuity.read", "identity.read", "memory.read", "memory.search"],
    grant_version: "a".repeat(64),
    consumer_grant_version: "b".repeat(64),
  });
  assert.equal(
    OPENAPI_DOCUMENT.paths["/v1/skills/retrieval"].post.operationId,
    "retrieveSkills",
  );

  const metadata = {
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    authority_owner: "haava",
    consumer_id: "general-assistant",
    source_sha256: "30a4f87a42821a21e633424ab333d6103b6a6ad911d963bd756fb9ca16ca715a",
    skill_id: "cdv-guide-audience-through-chart",
    card_sha256: "3817be65a9f26852a87bb95433f76cfd7e97c6887126c7a06a9447b1127e75cb",
    catalog_version: "2026-08-04.1",
    status: "accepted",
    source_pages: "16,136,142,148",
    citation_path: "references/storytelling.md#cdv-guide-audience-through-chart",
  };
  const response = await handleOpenApiRequest(
    new Request("https://memory.example/v1/skills/retrieval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: "personal",
        project_id: "project-infinitum",
        domain_id: "visual-design-expression",
        query: "explain a chart",
      }),
    }),
    {
      principal,
      env: {
        AI: { async run() { return { data: [[0.1]] }; } },
        MATRIX_SKILLS: {
          async query() {
            return { matches: [{
              id: projectionIdFor("general-assistant", metadata.skill_id),
              score: 0.9,
              metadata,
            }] };
          },
        },
      },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].skill_id, "cdv-guide-audience-through-chart");
  assert.equal(body.results[0].consumer_id, undefined);
});

test("authorization completion and refresh bind the exact client, project, domain, and read scopes", async () => {
  const env = await environment();
  const kv = memoryKv();
  let completed;
  Object.assign(env, {
    OAUTH_KV: kv,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    AUTHORIZED_GITHUB_USER_IDS: "277895262",
    MEMORY_TENANT_ID: "personal",
    GRANT_RESOLVER_TOKEN: "resolver-token-with-at-least-32-characters",
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({
        responseType: "code",
        clientId,
        redirectUri: "https://client.example/callback",
        scope: ["identity:read", "memory:read", "memory:search", "memory:propose"],
        state: "client-state",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
      }),
      lookupClient: async () => ({ clientName: "Ordinary ChatGPT" }),
      completeAuthorization: async (claims) => {
        completed = claims;
        return { redirectTo: "https://client.example/callback?code=issued" };
      },
    },
  });
  await approveAssistantGrant(env.DB, {
    tenant_id: "personal",
    owner_github_id: 277895262,
    assistant_id: assistantId,
    project_id: "project-infinitum",
    capabilities: ["memory.read", "memory.search"],
    approved_by: "owner:277895262",
    reason: "permanent visual retrieval project grant",
    idempotency_key: "visual-general-assistant-project",
    permanent: true,
    now,
  });
  const consumer = await approveVisualSkillConsumer(env.DB, {
    assistant_id: assistantId,
    actor_id: "owner:277895262",
    reason: "approved ordinary ChatGPT visual retrieval",
    now,
  });
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
    fetchImpl: async (url) => String(url).includes("access_token")
      ? Response.json({ access_token: "github-access" })
      : Response.json({ id: 277895262, login: "Anazeez" }),
  });
  const consent = await handler.fetch(
    new Request("https://memory.example/authorize?client_id=" + encodeURIComponent(clientId)),
    env,
  );
  const html = await consent.text();
  assert.doesNotMatch(html, /memory:propose/u);
  const requestId = html.match(/request=([^"]+)/u)[1];
  const csrf = html.match(/name="csrf" value="([^"]+)/u)[1];
  const githubRedirect = await handler.fetch(
    new Request("https://memory.example/authorize?request=" + requestId, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "mnemosyne_csrf=" + csrf,
      },
      body: "csrf=" + encodeURIComponent(csrf),
    }),
    env,
  );
  const state = new URL(githubRedirect.headers.get("location")).searchParams.get("state");
  const callback = await handler.fetch(
    new Request("https://memory.example/callback?state=" + state + "&code=github-code"),
    env,
  );
  assert.equal(callback.status, 302);
  assert.equal(completed.props.principal_id, "general-assistant");
  assert.equal(completed.props.role, "portal");
  assert.deepEqual(completed.props.project_ids, ["project-infinitum"]);
  assert.deepEqual(completed.props.domain_ids, ["visual-design-expression"]);
  assert.deepEqual(completed.props.consumer_ids, ["general-assistant"]);
  assert.deepEqual(completed.scope, ["identity:read", "memory:read", "memory:search"]);
  assert.equal(completed.props.consumer_grant_version, consumer.grant_version);

  const refreshed = await refreshGrantProps(completed.props, {
    fetchImpl: async (url, init) => handler.fetch(new Request(url, init), env),
  });
  assert.deepEqual(refreshed.consumer_ids, ["general-assistant"]);
  assert.deepEqual(refreshed.project_ids, ["project-infinitum"]);
  assert.equal(refreshed.consumer_grant_version, consumer.grant_version);
});

function memoryKv() {
  const values = new Map();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
}
