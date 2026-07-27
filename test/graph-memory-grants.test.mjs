import assert from "node:assert/strict";
import test from "node:test";

import {
  approveAssistantGrant,
  resolveAssistantGrant,
  revokeAssistantGrant,
} from "../src/graph-memory/grants.js";
import {
  migratedGraphMemoryEnvironment,
} from "./helpers/d1-graph-memory.mjs";

const NOW = "2026-07-27T12:00:00.000Z";
const OWNER = 277895262;
const ASSISTANT = "oauth-0123456789abcdef0123456789abcdef";

test("an owner assistant receives global canon without a project grant", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const result = await resolveAssistantGrant(env.DB, {
    tenantId: "personal",
    ownerGithubId: OWNER,
    assistantId: ASSISTANT,
    now: NOW,
  });
  assert.deepEqual(result.project_ids, ["global-canon"]);
  assert.match(result.grant_version, /^[a-f0-9]{64}$/);
});

test("active specialist and orchestrator grants resolve deterministically", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await approve(env.DB, {
    project_id: "project-alpha",
    idempotency_key: "grant-project-alpha",
    permanent: true,
  });
  const specialist = await resolve(env.DB);
  assert.deepEqual(specialist.project_ids, [
    "global-canon",
    "project-alpha",
  ]);

  await approve(env.DB, {
    project_id: "*",
    idempotency_key: "grant-orchestrator-all",
    permanent: true,
  });
  const orchestrator = await resolve(env.DB);
  assert.deepEqual(orchestrator.project_ids, [
    "*",
    "global-canon",
    "project-alpha",
  ]);
  assert.equal(
    orchestrator.grant_version,
    (await resolve(env.DB)).grant_version,
  );
});

test("future revoked and expired grants are excluded with receipts", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await approve(env.DB, {
    project_id: "future-project",
    idempotency_key: "grant-future-project",
    starts_at: "2026-07-28T00:00:00.000Z",
    expires_at: "2026-07-29T00:00:00.000Z",
  });
  const revoked = await approve(env.DB, {
    project_id: "revoked-project",
    idempotency_key: "grant-revoked-project",
    permanent: true,
  });
  await revokeAssistantGrant(env.DB, {
    grant_id: revoked.grant_id,
    actor_id: "owner:277895262",
    reason: "owner revoked project access",
    now: NOW,
  });
  await approve(env.DB, {
    project_id: "expired-project",
    idempotency_key: "grant-expired-project",
    starts_at: "2026-07-25T00:00:00.000Z",
    expires_at: "2026-07-26T00:00:00.000Z",
  });

  assert.deepEqual((await resolve(env.DB)).project_ids, ["global-canon"]);
  assert.equal(
    await env.DB.count(
      "memory_authorization_receipts",
      "action = 'expired'",
    ),
    1,
  );
});

test("approval is idempotent and exceptional access defaults to 24 hours", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const first = await approve(env.DB, {
    project_id: "project-beta",
    idempotency_key: "grant-project-beta",
  });
  const second = await approve(env.DB, {
    project_id: "project-beta",
    idempotency_key: "grant-project-beta",
  });
  assert.deepEqual(second, first);
  assert.equal(first.expires_at, "2026-07-28T12:00:00.000Z");
  assert.equal(await env.DB.count("memory_access_grants"), 1);
  assert.equal(await env.DB.count("memory_authorization_receipts"), 1);
});

test("permanent approval requires an explicit permanent choice", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const permanent = await approve(env.DB, {
    project_id: "project-gamma",
    idempotency_key: "grant-project-gamma",
    permanent: true,
  });
  assert.equal(permanent.expires_at, null);
});

test("revocation changes the grant version and writes an immutable receipt", async () => {
  const env = await migratedGraphMemoryEnvironment();
  const grant = await approve(env.DB, {
    project_id: "project-delta",
    idempotency_key: "grant-project-delta",
    permanent: true,
  });
  const before = await resolve(env.DB);
  await revokeAssistantGrant(env.DB, {
    grant_id: grant.grant_id,
    actor_id: "owner:277895262",
    reason: "specialist assignment ended",
    now: "2026-07-27T13:00:00.000Z",
  });
  const after = await resolveAssistantGrant(env.DB, {
    tenantId: "personal",
    ownerGithubId: OWNER,
    assistantId: ASSISTANT,
    now: "2026-07-27T13:00:01.000Z",
  });
  assert.notEqual(after.grant_version, before.grant_version);
  assert.deepEqual(after.project_ids, ["global-canon"]);
  assert.equal(
    await env.DB.count(
      "memory_authorization_receipts",
      "action = 'revoked'",
    ),
    1,
  );
  await assert.rejects(
    env.DB.prepare(`
      UPDATE memory_authorization_receipts
         SET reason = 'changed'
    `).run(),
    /authorization receipt is immutable/,
  );
});

async function approve(db, overrides) {
  return approveAssistantGrant(db, {
    tenant_id: "personal",
    owner_github_id: OWNER,
    assistant_id: ASSISTANT,
    capabilities: ["memory.read", "memory.search"],
    approved_by: "owner:277895262",
    reason: "owner approved project access",
    now: NOW,
    ...overrides,
  });
}

async function resolve(db) {
  return resolveAssistantGrant(db, {
    tenantId: "personal",
    ownerGithubId: OWNER,
    assistantId: ASSISTANT,
    now: NOW,
  });
}
