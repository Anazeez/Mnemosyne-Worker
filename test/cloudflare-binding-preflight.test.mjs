import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingShapeSummary,
  bindingSummary,
  buildDeploymentConfig,
  findVersionId,
} from "../scripts/cloudflare-binding-preflight.mjs";

test("preflight extracts the version without exposing unrelated identifiers", () => {
  assert.equal(findVersionId([{ versions: [{ version_id: "version-secret" }] }]), "version-secret");
});

test("deployment config preserves every supported non-secret live binding", () => {
  const config = buildDeploymentConfig({ bindings: [
    { type: "d1", name: "DB", id: "old" },
    { type: "kv_namespace", name: "KV_MATRIX", namespace_id: "kv" },
    { type: "durable_object_namespace", name: "AL_ARM3", class_name: "Alarm", script_name: "alarm-worker" },
    { type: "queue", name: "QUEUE", queue_name: "queue" },
    { type: "r2_bucket", name: "R2", bucket_name: "bucket" },
    { type: "secrets_store_secret", name: "STORE", store_id: "store", secret_name: "secret" },
    { type: "send_email", name: "MAIL" },
    { type: "vectorize", name: "INDEX", index_name: "index" },
    { type: "ai", name: "AI" },
    { type: "plain_text", name: "FLAG", text: "on" },
    { type: "json", name: "POLICY", json: { root: true } },
    { type: "secret_text", name: "TOKEN" },
  ] }, {
    databaseId: "new-db",
    migrationsDir: "/workspace/migrations",
    entrypoint: "/workspace/src/index.js",
    continuityReadEnabled: true,
  });
  assert.equal(config.main, "/workspace/src/index.js");
  assert.equal(config.d1_databases[0].database_id, "new-db");
  assert.equal(config.kv_namespaces[0].id, "kv");
  assert.equal(config.durable_objects.bindings[0].script_name, "alarm-worker");
  assert.equal(config.secrets_store_secrets[0].store_id, "store");
  assert.equal(config.vars.FLAG, "on");
  assert.deepEqual(config.vars.POLICY, { root: true });
  assert.equal(config.vars.CONTINUITY_READ_ENABLED, "1");
  assert.deepEqual(
    Object.keys(config.vars).filter((name) =>
      name.startsWith("CONTINUITY_") && name !== "CONTINUITY_READ_ENABLED"
    ),
    [],
  );
  assert.doesNotMatch(JSON.stringify(config), /TOKEN/);
});

test("binding shape audit exposes keys but never values", () => {
  const summary = bindingShapeSummary({ bindings: [
    { type: "d1", name: "DB", id: "private-id" },
  ] });
  assert.deepEqual(summary, [{ keys: ["id", "name", "type"], name: "DB", type: "d1" }]);
  assert.doesNotMatch(JSON.stringify(summary), /private-id/);
});

test("binding audit emits aliases and types only", () => {
  const summary = bindingSummary({ resources: { bindings: [
    { type: "d1", name: "DB", id: "private-id" },
    { type: "kv_namespace", name: "KV_MATRIX", namespace_id: "private-kv" },
  ] } });
  assert.deepEqual(summary, [
    { name: "DB", type: "d1" },
    { name: "KV_MATRIX", type: "kv_namespace" },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /private/);
});
