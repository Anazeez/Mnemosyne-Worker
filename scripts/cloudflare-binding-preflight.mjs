import { readFile, writeFile } from "node:fs/promises";

export const GRAPH_MEMORY_DEPLOYMENT_FLAGS = Object.freeze([
  "GRAPH_MEMORY_READ_ENABLED",
  "GRAPH_MEMORY_PROPOSE_ENABLED",
  "GRAPH_MEMORY_VALIDATION_ENABLED",
  "GRAPH_MEMORY_RESOLUTION_ENABLED",
  "GRAPH_MEMORY_OWNER_REVIEW_ENABLED",
  "GRAPH_MEMORY_OWNER_COMMIT_ENABLED",
  "GRAPH_MEMORY_REVIEW_ENABLED",
  "GRAPH_MEMORY_PUBLICATION_ENABLED",
  "GRAPH_MEMORY_HANDOFF_ACCEPT_ENABLED",
  "GRAPH_MEMORY_MCP_ENABLED",
  "GRAPH_MEMORY_ACTIONS_ENABLED",
]);

export function findVersionId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVersionId(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (/version.*id/i.test(key) && typeof child === "string" && child) return child;
  }
  for (const child of Object.values(value)) {
    const found = findVersionId(child);
    if (found) return found;
  }
  return null;
}

export function bindingSummary(value) {
  const bindings = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string" && typeof node.name === "string") {
      bindings.push({ name: node.name, type: node.type });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return [...new Map(bindings.map(item => [`${item.type}:${item.name}`, item])).values()]
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

export function bindingShapeSummary(value) {
  const bindings = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string" && typeof node.name === "string") {
      bindings.push({
        name: node.name,
        type: node.type,
        keys: Object.keys(node).sort(),
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return bindings.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

export function collectBindings(value) {
  const bindings = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string" && typeof node.name === "string") bindings.push(node);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return [...new Map(bindings.map(item => [`${item.type}:${item.name}`, item])).values()];
}

export function buildDeploymentConfig(
  value,
  {
    databaseId,
    migrationsDir,
    entrypoint,
    continuityReadEnabled = false,
    oauthKvNamespaceId,
    customDomain,
    ownerGithubUserIds,
    memoryTenantId,
    graphMemoryFlags = {},
  },
) {
  const config = {
    name: "mnemosyne-worker",
    main: entrypoint,
    compatibility_date: "2024-01-01",
    vars: {},
  };
  for (const binding of collectBindings(value)) {
    switch (binding.type) {
      case "ai": config.ai = { binding: binding.name }; break;
      case "d1": (config.d1_databases ??= []).push({ binding: binding.name, database_id: databaseId, database_name: "pulse-registry", migrations_dir: migrationsDir }); break;
      case "durable_object_namespace": (config.durable_objects ??= { bindings: [] }).bindings.push({ name: binding.name, class_name: binding.class_name, script_name: binding.script_name }); break;
      case "kv_namespace": (config.kv_namespaces ??= []).push({ binding: binding.name, id: binding.namespace_id }); break;
      case "queue": (config.queues ??= { producers: [] }).producers.push({ binding: binding.name, queue: binding.queue_name }); break;
      case "r2_bucket": (config.r2_buckets ??= []).push({ binding: binding.name, bucket_name: binding.bucket_name }); break;
      case "secrets_store_secret": (config.secrets_store_secrets ??= []).push({ binding: binding.name, store_id: binding.store_id, secret_name: binding.secret_name }); break;
      case "send_email": (config.send_email ??= []).push({ name: binding.name }); break;
      case "vectorize": (config.vectorize ??= []).push({ binding: binding.name, index_name: binding.index_name }); break;
      case "plain_text": config.vars[binding.name] = binding.text; break;
      case "json": config.vars[binding.name] = binding.json; break;
      case "secret_text": break;
      default: throw new Error(`unsupported_live_binding_type:${binding.type}`);
    }
  }
  if (continuityReadEnabled) {
    config.vars.CONTINUITY_READ_ENABLED = "1";
  }
  for (const flag of GRAPH_MEMORY_DEPLOYMENT_FLAGS) {
    config.vars[flag] = enabled(graphMemoryFlags[flag]) ? "1" : "0";
  }
  const hasOAuthKv = config.kv_namespaces?.some(
    binding => binding.binding === "OAUTH_KV",
  );
  if (!hasOAuthKv && oauthKvNamespaceId) {
    (config.kv_namespaces ??= []).push({
      binding: "OAUTH_KV",
      id: oauthKvNamespaceId,
    });
  }
  if (customDomain) {
    const normalizedDomain = String(customDomain).trim().toLowerCase();
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
        .test(normalizedDomain)
    ) {
      throw new Error("invalid_custom_domain");
    }
    config.routes = [{
      pattern: normalizedDomain,
      custom_domain: true,
    }];
  }
  if (ownerGithubUserIds) {
    config.vars.AUTHORIZED_GITHUB_USER_IDS =
      String(ownerGithubUserIds).trim();
  }
  if (memoryTenantId) {
    config.vars.MEMORY_TENANT_ID = String(memoryTenantId).trim();
  }
  if (Object.keys(config.vars).length === 0) delete config.vars;
  return config;
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

if (process.argv[1]?.endsWith("cloudflare-binding-preflight.mjs")) {
  const command = process.argv[2];
  if (command === "version-id") {
    const deployments = JSON.parse(await readFile(process.argv[3], "utf8"));
    const versionId = findVersionId(deployments);
    if (!versionId) throw new Error("current_worker_version_unresolved");
    process.stdout.write(versionId);
  } else if (command === "build-config") {
    const version = JSON.parse(await readFile(process.argv[3], "utf8"));
    const config = buildDeploymentConfig(version, {
      databaseId: process.env.MNEMOSYNE_D1_DATABASE_ID,
      migrationsDir: `${process.env.GITHUB_WORKSPACE}/migrations`,
      entrypoint: `${process.env.GITHUB_WORKSPACE}/src/worker.js`,
      continuityReadEnabled: true,
      oauthKvNamespaceId: process.env.OAUTH_KV_NAMESPACE_ID,
      customDomain: process.env.MNEMOSYNE_CUSTOM_DOMAIN,
      ownerGithubUserIds: process.env.AUTHORIZED_GITHUB_USER_IDS,
      memoryTenantId: process.env.MEMORY_TENANT_ID,
      graphMemoryFlags: Object.fromEntries(
        GRAPH_MEMORY_DEPLOYMENT_FLAGS.map(flag => [flag, process.env[flag]]),
      ),
    });
    await writeFile(process.argv[4], JSON.stringify(config));
  } else {
    throw new Error("unknown_preflight_command");
  }
}
