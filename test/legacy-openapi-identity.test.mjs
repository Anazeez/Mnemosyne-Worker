import assert from "node:assert/strict";
import test from "node:test";

import { hashLegacyKey } from "../src/auth/legacy-credentials.js";
import {
  applySpecialistMigration,
  migratedSpecialistEnvironment,
} from "./helpers/d1-specialists.mjs";

const rawKey = "synn-key-with-sufficient-randomness";
const pepper = "p".repeat(32);

async function synnEnvironment() {
  const env = await migratedSpecialistEnvironment({
    LEGACY_CREDENTIAL_PEPPER: pepper,
    SPECIALIST_PACKAGE_VERSION: "2026-08-03.2",
  });
  await applySpecialistMigration(env.DB);
  await env.DB.prepare(`
    INSERT INTO specialist_principals (
      principal_id, specialist_id, tenant_id, project_ids_json,
      domain_ids_json, memory_domains_json, capabilities_json,
      lane_permissions_json, grant_version, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    "principal-synn", "synn", "personal", '["project-infinitum"]',
    '["security-compliance-preflight"]', '["knowledge"]',
    '["memory.read","memory.search","memory.propose","security.preflight"]',
    '["root-local","savae-routed"]', "e".repeat(64),
    "2026-08-03T00:00:00Z", "2026-08-03T00:00:00Z",
  ).run();
  await env.DB.prepare(`
    INSERT INTO legacy_credentials (
      credential_id, principal_id, key_hash, active, created_at
    ) VALUES (?, ?, ?, 1, ?)
  `).bind(
    "legacy-synn",
    "principal-synn",
    await hashLegacyKey(rawKey, pepper),
    "2026-08-03T00:00:00Z",
  ).run();
  return env;
}

test("Matrix key verifies only its bound specialist identity", async () => {
  const module = await import("../src/openapi.js");
  assert.equal(typeof module.handleMatrixIdentityRequest, "function");
  const response = await module.handleMatrixIdentityRequest(
    new Request("https://memory.example/v1/identity", {
      headers: { "X-Matrix-Key": rawKey },
    }),
    await synnEnvironment(),
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.specialist_id, "synn");
  assert.deepEqual(payload.project_ids, ["project-infinitum"]);
  assert.deepEqual(payload.domain_ids, ["security-compliance-preflight"]);
  assert.deepEqual(payload.oauth_scopes, []);
  assert.equal(payload.package_version, "2026-08-03.2");
  assert.equal(JSON.stringify(payload).includes(rawKey), false);
});

test("unknown Matrix key fails closed without identity details", async () => {
  const module = await import("../src/openapi.js");
  assert.equal(typeof module.handleMatrixIdentityRequest, "function");
  const response = await module.handleMatrixIdentityRequest(
    new Request("https://memory.example/v1/identity", {
      headers: { "X-Matrix-Key": "wrong-key-with-sufficient-randomness" },
    }),
    await synnEnvironment(),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "identity_not_authenticated" });
});

test("Matrix identity fails closed when package policy is unavailable", async () => {
  const module = await import("../src/openapi.js");
  const env = await synnEnvironment();
  delete env.SPECIALIST_PACKAGE_VERSION;
  const response = await module.handleMatrixIdentityRequest(
    new Request("https://memory.example/v1/identity", {
      headers: { "X-Matrix-Key": rawKey },
    }),
    env,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "identity_policy_unavailable" });
});
