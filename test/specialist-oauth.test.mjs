import assert from "node:assert/strict";
import test from "node:test";

import { principalFromOAuthClaims } from "../src/graph-memory/policy.js";
import {
  buildGrantClaims,
  resolveSpecialistAssistantBinding,
} from "../src/oauth.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";
import { applySpecialistMigration } from "./helpers/d1-specialists.mjs";

const assistantId = "oauth-11111111111111111111111111111111";

test("OAuth principal receives only its bound specialist grants", () => {
  const principal = principalFromOAuthClaims({
    tenant_id: "personal",
    credential_id: "github-277895262",
    assistant_id: assistantId,
    role: "specialist",
    specialist_id: "haava",
    project_ids: ["project-infinitum"],
    identity_ids: ["haava"],
    domain_ids: ["visual-design-expression"],
    lane_permissions: ["root-local", "savae-routed"],
    scopes: ["memory:read", "memory:search", "memory:propose"],
    grant_version: "a".repeat(64),
  });

  assert.equal(principal.specialist_id, "haava");
  assert.deepEqual(principal.domain_ids, ["visual-design-expression"]);
  assert.equal(principal.capabilities.includes("memory.publish"), false);
});

test("specialist OAuth claims reject wildcard projects and domains", () => {
  assert.throws(
    () => principalFromOAuthClaims({
      tenant_id: "personal",
      credential_id: "github-277895262",
      assistant_id: assistantId,
      role: "specialist",
      specialist_id: "haava",
      project_ids: ["*"],
      identity_ids: ["haava"],
      domain_ids: ["*"],
      lane_permissions: ["root-local"],
      scopes: ["memory:read"],
      grant_version: "a".repeat(64),
    }),
    (error) => error.code === "INVALID_OAUTH_CLAIMS",
  );
});

test("assistant binding resolves one active package-bound specialist", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await applySpecialistMigration(env.DB);
  await env.DB.prepare(`
    INSERT INTO specialist_principals (
      principal_id, specialist_id, tenant_id, project_ids_json,
      domain_ids_json, capabilities_json, lane_permissions_json,
      grant_version, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    "principal-haava", "haava", "personal", '["project-infinitum"]',
    '["visual-design-expression"]', '["memory.read","memory.search","memory.propose"]',
    '["root-local","savae-routed"]', "b".repeat(64),
    "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z",
  ).run();
  await env.DB.prepare(`
    INSERT INTO specialist_assistant_bindings (
      assistant_id, principal_id, transport, package_version, active
    ) VALUES (?, ?, 'custom-gpt', ?, 1)
  `).bind(assistantId, "principal-haava", "2026-08-02.1").run();

  const binding = await resolveSpecialistAssistantBinding(env.DB, assistantId, {
    packageVersion: "2026-08-02.1",
  });
  assert.deepEqual(binding.domain_ids, ["visual-design-expression"]);
  assert.equal(binding.specialist_id, "haava");

  const claims = buildGrantClaims({
    githubUser: { id: 277895262, login: "Anazeez" },
    tenantId: "personal",
    assistantId,
    projectIds: binding.project_ids,
    requestedScopes: ["memory:read", "memory:search"],
    specialistGrant: binding,
  });
  assert.equal(claims.props.role, "specialist");
  assert.equal(claims.props.specialist_id, "haava");
  assert.deepEqual(claims.props.domain_ids, ["visual-design-expression"]);
});
