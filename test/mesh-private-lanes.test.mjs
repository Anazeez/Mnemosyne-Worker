import assert from "node:assert/strict";
import test from "node:test";

import { signMeshEnvelope } from "../src/mesh/signatures.js";
import {
  acceptMeshMessage,
  handleMeshInboxRequest,
  handleMeshIngressRequest,
  listMeshInbox,
  startMeshMessage,
} from "../src/mesh/routes.js";
import {
  applySpecialistMigration,
  migratedSpecialistEnvironment,
} from "./helpers/d1-specialists.mjs";

const secret = "mesh-gateway-secret-with-32-bytes-minimum";
const now = new Date("2026-08-02T12:00:00.000Z");

function envelope(overrides = {}) {
  return {
    schema_version: "mnemosyne.mesh.v1",
    message_id: "msg-12345678",
    correlation_id: "cor-12345678",
    source: "email",
    principal_id: "mnemosyne-mail-gateway",
    target_specialist: "hearken",
    lane: "root-local",
    project_id: "project-infinitum",
    payload: { subject: "Review bounded implementation" },
    attachments: [],
    forwarded_by_architectus: false,
    preflight: { severity: "clear", decision: "allow", reason_codes: [] },
    ...overrides,
  };
}

async function signedRequest(body, { timestamp = now.toISOString(), signature } = {}) {
  const rawBody = JSON.stringify(body);
  const resolvedSignature = signature ?? await signMeshEnvelope(rawBody, timestamp, secret);
  return new Request("https://worker.invalid/v1/mesh/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mesh-Timestamp": timestamp,
      "X-Mesh-Signature": resolvedSignature,
    },
    body: rawBody,
  });
}

async function environment() {
  const env = await migratedSpecialistEnvironment({ MESH_GATEWAY_SECRET: secret });
  await applySpecialistMigration(env.DB);
  return env;
}

test("mesh ingress rejects a bad signature and stale timestamp", async () => {
  const env = await environment();
  const bad = await handleMeshIngressRequest(
    await signedRequest(envelope(), { signature: "0".repeat(64) }),
    { env, now: () => now },
  );
  const stale = await handleMeshIngressRequest(
    await signedRequest(envelope(), {
      timestamp: new Date(now.getTime() - 301_000).toISOString(),
    }),
    { env, now: () => now },
  );

  assert.equal(bad.status, 401);
  assert.equal(stale.status, 401);
  assert.equal(await env.DB.count("mesh_messages"), 0);
});

test("duplicate message id is idempotent", async () => {
  const env = await environment();
  const first = await handleMeshIngressRequest(await signedRequest(envelope()), {
    env, now: () => now,
  });
  const second = await handleMeshIngressRequest(await signedRequest(envelope()), {
    env, now: () => now,
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, "duplicate");
  assert.equal(await env.DB.count("mesh_messages"), 1);
});

test("Savae cannot list an unforwarded root-local exchange", async () => {
  const env = await environment();
  await acceptMeshMessage({ env, envelope: envelope(), now: () => now });
  const savae = await listMeshInbox({
    env,
    principal: {
      role: "specialist",
      principal_id: "savae",
      specialist_id: "savae",
    },
  });
  const hearken = await listMeshInbox({
    env,
    principal: {
      role: "specialist",
      principal_id: "hearken",
      specialist_id: "hearken",
    },
  });

  assert.deepEqual(savae.messages, []);
  assert.equal(hearken.messages.length, 1);
  assert.deepEqual(hearken.messages[0].payload, {
    subject: "Review bounded implementation",
  });
});

test("mesh inbox remains specialist-only even if a portal requests its OAuth scope", async () => {
  const env = await environment();
  const response = await handleMeshInboxRequest(
    new Request("https://worker.invalid/v1/mesh/inbox"),
    {
      env,
      principal: {
        role: "portal",
        principal_id: "portal",
        capabilities: ["exchanges.inbox"],
      },
    },
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "CAPABILITY_DENIED");
});

test("blocked execution requires an explicit Architectus override record", async () => {
  const env = await environment();
  await acceptMeshMessage({
    env,
    envelope: envelope({
      message_id: "msg-critical-1",
      preflight: {
        severity: "critical",
        decision: "block",
        reason_codes: ["suspicious_payload"],
      },
    }),
    now: () => now,
  });

  await assert.rejects(
    startMeshMessage({ env, messageId: "msg-critical-1", now: () => now }),
    (error) => error.code === "SECURITY_PREFLIGHT_BLOCKED",
  );
  const started = await startMeshMessage({
    env,
    messageId: "msg-critical-1",
    override: {
      actor: "architectus",
      scope: "message:msg-critical-1",
    },
    now: () => now,
  });
  assert.equal(started.status, "running");
  const row = env.DB.database.prepare(
    "SELECT override_actor, override_scope, overridden_at FROM security_preflights WHERE message_id = ?",
  ).get("msg-critical-1");
  assert.deepEqual({ ...row }, {
    override_actor: "architectus",
    override_scope: "message:msg-critical-1",
    overridden_at: now.toISOString(),
  });
});
