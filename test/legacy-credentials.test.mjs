import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateLegacyRequest,
  hashLegacyKey,
} from "../src/auth/legacy-credentials.js";
import {
  applySpecialistMigration,
  migratedSpecialistEnvironment,
} from "./helpers/d1-specialists.mjs";
import { buildLegacyCredentialSql } from "../scripts/migrate-legacy-credentials.mjs";

function requestWithKey(key) {
  return new Request("https://worker.invalid/v1/specialists/memory/search", {
    headers: { "X-Matrix-Key": key },
  });
}

test("legacy authentication stores and compares only HMAC hashes", async () => {
  const hash = await hashLegacyKey(
    "persona-random-key-with-entropy",
    "p".repeat(32),
  );
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes("persona-random-key-with-entropy"), false);
});

test("plaintext principal JSON is not consulted", async () => {
  const env = await migratedSpecialistEnvironment();
  await applySpecialistMigration(env.DB);
  const principal = await authenticateLegacyRequest(
    requestWithKey("old-key-that-is-at-least-twenty"),
    {
      MATRIX_PRINCIPAL_KEYS: JSON.stringify([{
        key: "old-key-that-is-at-least-twenty",
        credential_id: "haava",
      }]),
      LEGACY_CREDENTIAL_PEPPER: "p".repeat(32),
      DB: env.DB,
    },
  );
  assert.equal(principal, null);
});

test("active HMAC credential resolves only its bound specialist principal", async () => {
  const env = await migratedSpecialistEnvironment();
  await applySpecialistMigration(env.DB);
  const rawKey = "haava-key-with-sufficient-randomness";
  const pepper = "p".repeat(32);
  const keyHash = await hashLegacyKey(rawKey, pepper);
  await env.DB.prepare(`
    INSERT INTO specialist_principals (
      principal_id, specialist_id, tenant_id, project_ids_json,
      domain_ids_json, memory_domains_json, capabilities_json,
      lane_permissions_json, grant_version, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    "principal-haava", "haava", "personal", '["project-infinitum"]',
    '["visual-design-expression"]', '["knowledge"]',
    '["memory.read","memory.search","memory.propose"]',
    '["root-local","savae-routed"]', "c".repeat(64),
    "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z",
  ).run();
  await env.DB.prepare(`
    INSERT INTO legacy_credentials (
      credential_id, principal_id, key_hash, active, created_at
    ) VALUES (?, ?, ?, 1, ?)
  `).bind("legacy-haava", "principal-haava", keyHash, "2026-08-02T00:00:00Z").run();

  const principal = await authenticateLegacyRequest(requestWithKey(rawKey), {
    DB: env.DB,
    LEGACY_CREDENTIAL_PEPPER: pepper,
  });
  assert.equal(principal.specialist_id, "haava");
  assert.deepEqual(principal.domain_ids, ["visual-design-expression"]);
  assert.equal(principal.capabilities.includes("memory.publish"), false);
});

test("local migration output contains hashes and never raw credentials", async () => {
  const sql = await buildLegacyCredentialSql([{
    credential_id: "legacy-haava",
    principal_id: "principal-haava",
    key: "raw-key-that-must-never-appear",
  }], {
    pepper: "p".repeat(32),
    createdAt: "2026-08-02T00:00:00Z",
  });

  assert.doesNotMatch(sql, /raw-key-that-must-never-appear/);
  assert.match(sql, /[a-f0-9]{64}/);
  assert.match(sql, /INSERT INTO legacy_credentials/);
});

test("live registry migration emits only bounded specialist principals and HMAC hashes", async () => {
  const module = await import("../scripts/migrate-live-specialist-credentials.mjs")
    .catch(() => ({}));
  assert.equal(typeof module.buildLiveSpecialistCredentialSql, "function");
  const synnKey = "synn-live-key-that-must-never-appear";
  const uixKey = "uix-live-key-that-must-never-appear";
  const output = await module.buildLiveSpecialistCredentialSql([
    {
      credentialId: "synn-builder",
      identity_aliases: ["synn"],
      key: synnKey,
      project_ids: ["project-infinitum"],
      memory_domains: ["knowledge", "skills"],
    },
    {
      credential_id: "uix-builder",
      identity_aliases: ["uix"],
      action_key: uixKey,
      project_ids: ["project-infinitum"],
      memory_domains: ["knowledge", "files"],
    },
    {
      credential_id: "archivist",
      identity_aliases: ["archivist"],
      key: "non-specialist-key-that-is-ignored",
      project_ids: ["project-infinitum"],
    },
  ], {
    pepper: "p".repeat(32),
    createdAt: "2026-08-03T00:00:00Z",
    tenantId: "personal",
  });

  assert.equal(output.migrated_count, 2);
  assert.deepEqual(output.specialist_ids, ["synn", "vitruvius"]);
  assert.doesNotMatch(output.sql, new RegExp(synnKey));
  assert.doesNotMatch(output.sql, new RegExp(uixKey));
  assert.doesNotMatch(output.sql, /non-specialist-key-that-is-ignored/);
  assert.match(output.sql, /principal-synn/);
  assert.match(output.sql, /principal-vitruvius/);
  assert.match(output.sql, /[a-f0-9]{64}/);
  assert.match(output.sql, /UPDATE legacy_credentials[\s\S]+key_hash <>/);
  assert.doesNotMatch(output.sql, /\*/);
});

test("live registry migration rejects a specialist without a bounded project", async () => {
  const module = await import(
    "../scripts/migrate-live-specialist-credentials.mjs"
  ).catch(() => ({}));
  assert.equal(typeof module.buildLiveSpecialistCredentialSql, "function");
  await assert.rejects(
    module.buildLiveSpecialistCredentialSql([{
      credential_id: "synn-builder",
      identity_aliases: ["synn"],
      key: "synn-live-key-with-sufficient-entropy",
      project_ids: ["*"],
    }], {
      pepper: "p".repeat(32),
      createdAt: "2026-08-03T00:00:00Z",
      tenantId: "personal",
    }),
    /LEGACY_SPECIALIST_PROJECTS_INVALID:synn/,
  );
});

test("live registry migration fails closed when a required specialist is absent", async () => {
  const { buildLiveSpecialistCredentialSql } = await import(
    "../scripts/migrate-live-specialist-credentials.mjs"
  );
  await assert.rejects(
    buildLiveSpecialistCredentialSql([{
      credential_id: "synn-builder",
      identity_aliases: ["synn"],
      key: "synn-live-key-with-sufficient-entropy",
      project_ids: ["project-infinitum"],
    }], {
      pepper: "p".repeat(32),
      createdAt: "2026-08-03T00:00:00Z",
      tenantId: "personal",
      requiredSpecialistIds: ["synn", "haava"],
    }),
    /LEGACY_SPECIALIST_REQUIRED_MISSING:haava/,
  );
});
