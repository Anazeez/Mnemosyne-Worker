import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    entrypoint: "/workspace/src/worker.js",
    continuityReadEnabled: true,
    oauthKvNamespaceId: "oauth-kv",
    customDomain: "memory.azzayezz.com",
    ownerGithubUserIds: "277895262",
    memoryTenantId: "personal",
    specialistPackageVersion: "2026-08-03.2",
    graphMemoryFlags: {
      GRAPH_MEMORY_READ_ENABLED: true,
      GRAPH_MEMORY_MCP_ENABLED: true,
    },
  });
  assert.equal(config.main, "/workspace/src/worker.js");
  assert.equal(config.d1_databases[0].database_id, "new-db");
  assert.equal(config.kv_namespaces[0].id, "kv");
  assert.equal(config.durable_objects.bindings[0].script_name, "alarm-worker");
  assert.equal(config.secrets_store_secrets[0].store_id, "store");
  assert.equal(config.vars.FLAG, "on");
  assert.deepEqual(config.vars.POLICY, { root: true });
  assert.equal(config.vars.CONTINUITY_READ_ENABLED, "1");
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.vars).filter(([name]) =>
      name.startsWith("GRAPH_MEMORY_"))),
    {
      GRAPH_MEMORY_READ_ENABLED: "1",
      GRAPH_MEMORY_PROPOSE_ENABLED: "0",
      GRAPH_MEMORY_VALIDATION_ENABLED: "0",
      GRAPH_MEMORY_RESOLUTION_ENABLED: "0",
      GRAPH_MEMORY_OWNER_REVIEW_ENABLED: "0",
      GRAPH_MEMORY_OWNER_COMMIT_ENABLED: "0",
      GRAPH_MEMORY_REVIEW_ENABLED: "0",
      GRAPH_MEMORY_PUBLICATION_ENABLED: "0",
      GRAPH_MEMORY_MCP_ENABLED: "1",
      GRAPH_MEMORY_ACTIONS_ENABLED: "0",
    },
  );
  assert.deepEqual(
    config.kv_namespaces.find(binding => binding.binding === "OAUTH_KV"),
    { binding: "OAUTH_KV", id: "oauth-kv" },
  );
  assert.deepEqual(config.routes, [{
    pattern: "memory.azzayezz.com",
    custom_domain: true,
  }]);
  assert.equal(config.vars.AUTHORIZED_GITHUB_USER_IDS, "277895262");
  assert.equal(config.vars.MEMORY_TENANT_ID, "personal");
  assert.equal(config.vars.SPECIALIST_PACKAGE_VERSION, "2026-08-03.2");
  assert.deepEqual(
    Object.keys(config.vars).filter((name) =>
      name.startsWith("CONTINUITY_") && name !== "CONTINUITY_READ_ENABLED"
    ),
    [],
  );
  assert.doesNotMatch(JSON.stringify(config), /TOKEN/);
});

test("custom domain is absent until explicitly supplied", () => {
  const config = buildDeploymentConfig({ bindings: [] }, {
    databaseId: "new-db",
    migrationsDir: "/workspace/migrations",
    entrypoint: "/workspace/src/worker.js",
  });
  assert.equal("routes" in config, false);
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

test("production workflow requires private OAuth inputs before activation", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/production-deploy.yml", import.meta.url),
    "utf8",
  );
  for (const name of [
    "OAUTH_KV_NAMESPACE_ID",
    "OAUTH_GITHUB_CLIENT_ID",
    "OAUTH_GITHUB_CLIENT_SECRET",
    "GRANT_RESOLVER_TOKEN",
    "OPENAI_APPS_CHALLENGE",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
  }
  assert.doesNotMatch(workflow, /secrets\.GITHUB_/);
  assert.match(workflow, /AUTHORIZED_GITHUB_USER_IDS: "277895262"/);
  assert.match(workflow, /MEMORY_TENANT_ID: "personal"/);
  assert.match(workflow, /SPECIALIST_PACKAGE_VERSION: "2026-08-03.2"/);
  assert.match(workflow, /memory\.azzayezz\.com/);
  assert.match(workflow, /wrangler secret put "\$name"/);
  assert.match(workflow, /put_secret GITHUB_CLIENT_ID/);
  assert.match(workflow, /put_secret GITHUB_CLIENT_SECRET/);
  assert.match(workflow, /put_secret GRANT_RESOLVER_TOKEN/);
  assert.match(workflow, /put_secret OPENAI_APPS_CHALLENGE/);
  assert.doesNotMatch(
    workflow,
    /MNEMOSYNE_CUSTOM_DOMAIN" && -z "\$OPENAI_APPS_CHALLENGE/,
  );
  assert.match(workflow, /GRAPH_MEMORY_REVIEW_ENABLED: "0"/);
  assert.match(workflow, /GRAPH_MEMORY_PUBLICATION_ENABLED: "0"/);
  assert.match(
    workflow,
    /GRAPH_MEMORY_VALIDATION_ENABLED: \$\{\{ inputs\.enable_validation && '1' \|\| '0' \}\}/,
  );
  assert.match(
    workflow,
    /GRAPH_MEMORY_RESOLUTION_ENABLED: \$\{\{ inputs\.enable_resolution && '1' \|\| '0' \}\}/,
  );
  assert.match(
    workflow,
    /GRAPH_MEMORY_OWNER_REVIEW_ENABLED: \$\{\{ inputs\.enable_owner_review && '1' \|\| '0' \}\}/,
  );
  assert.match(
    workflow,
    /GRAPH_MEMORY_OWNER_COMMIT_ENABLED: \$\{\{ inputs\.enable_owner_commit && '1' \|\| '0' \}\}/,
  );
  assert.equal(
    workflow.match(
      /GRAPH_MEMORY_VALIDATION_ENABLED" == "1"/g,
    )?.length,
    2,
  );
  assert.equal(
    workflow.match(
      /GRAPH_MEMORY_RESOLUTION_ENABLED" == "1"/g,
    )?.length,
    2,
  );
  assert.equal(
    workflow.match(
      /GRAPH_MEMORY_OWNER_REVIEW_ENABLED" == "1"/g,
    )?.length,
    2,
  );
  assert.equal(
    workflow.match(
      /GRAPH_MEMORY_OWNER_COMMIT_ENABLED" == "1"/g,
    )?.length,
    2,
  );
});

test("production workflow installs the credential pepper and migrates only hashed specialist credentials", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/production-deploy.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /LEGACY_CREDENTIAL_PEPPER: \$\{\{ secrets\.LEGACY_CREDENTIAL_PEPPER \}\}/);
  assert.match(workflow, /SPECIALIST_DEFAULT_PROJECT_IDS: "project-infinitum"/);
  assert.match(workflow, /SPECIALIST_REQUIRED_IDS: "ariadne,haava,hearken,nadeem,savae,synn,vitruvius"/);
  assert.match(workflow, /put_secret LEGACY_CREDENTIAL_PEPPER/);
  assert.match(workflow, /migrate-live-specialist-credentials\.mjs/);
  assert.match(workflow, /wrangler d1 execute DB --remote/);
  assert.doesNotMatch(workflow, /echo.*LEGACY_CREDENTIAL_PEPPER/);
});

test("production workflow ensures every scalar visual retrieval filter is indexed", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/production-deploy.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /vectorize list-metadata-index mnemosyne-skills/);
  assert.match(
    workflow,
    /vectorize create-metadata-index mnemosyne-skills[\s\S]+--propertyName "\$property" --type string/,
  );
  for (const property of ["tenant_id", "project_id", "domain_id", "consumer_id"]) {
    assert.match(workflow, new RegExp(`ensure_metadata_index ${property}`));
  }
});
