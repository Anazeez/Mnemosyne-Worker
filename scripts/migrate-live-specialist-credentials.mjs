#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { hashLegacyKey } from "../src/auth/legacy-credentials.js";
import { contractForSpecialist } from "../src/specialists/policy.js";
import { collectBindings } from "./cloudflare-binding-preflight.mjs";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{1,127}$/u;
const STORAGE_PARTITIONS = Object.freeze([
  "knowledge", "agents", "skills", "files", "library",
]);

export async function buildLiveSpecialistCredentialSql(
  records,
  {
    pepper,
    createdAt,
    tenantId = "personal",
    defaultProjectIds = [],
    requiredSpecialistIds = [],
  },
) {
  const entries = registryEntries(records);
  const migrated = [];
  for (const { record, fallbackKey } of entries) {
    const contract = resolveContract(record);
    if (!contract) continue;
    const rawKey = String(record.key ?? record.action_key ?? fallbackKey ?? "");
    if (rawKey.length < 20) {
      throw new Error(`LEGACY_SPECIALIST_KEY_INVALID:${contract.specialist_id}`);
    }
    const projectIds = normalizedIds(
      record.project_ids ?? record.projectIds ?? record.projects ?? defaultProjectIds,
    );
    if (projectIds.length === 0 || projectIds.includes("*")) {
      throw new Error(`LEGACY_SPECIALIST_PROJECTS_INVALID:${contract.specialist_id}`);
    }
    const requestedDomains = normalizedIds(record.memory_domains ?? record.memoryDomains);
    const memoryDomains = requestedDomains.length > 0
      ? requestedDomains.filter((value) => STORAGE_PARTITIONS.includes(value))
      : [...STORAGE_PARTITIONS];
    if (memoryDomains.length === 0) {
      throw new Error(`LEGACY_SPECIALIST_MEMORY_INVALID:${contract.specialist_id}`);
    }
    const keyHash = await hashLegacyKey(rawKey, pepper);
    const grant = {
      tenant_id: normalizedId(record.tenant_id ?? record.tenantId ?? tenantId),
      specialist_id: contract.specialist_id,
      project_ids: projectIds,
      domain_ids: [...contract.domain_ids],
      memory_domains: memoryDomains,
      capabilities: [...contract.capabilities],
      lane_permissions: [...contract.lane_permissions],
    };
    if (!grant.tenant_id) {
      throw new Error(`LEGACY_SPECIALIST_TENANT_INVALID:${contract.specialist_id}`);
    }
    if (migrated.some((item) => item.specialist_id === contract.specialist_id)) {
      throw new Error(`LEGACY_SPECIALIST_DUPLICATE:${contract.specialist_id}`);
    }
    migrated.push({
      credential_id: `legacy-${contract.specialist_id}-${keyHash.slice(0, 12)}`,
      principal_id: `principal-${contract.specialist_id}`,
      key_hash: keyHash,
      grant_version: await sha256(JSON.stringify(grant)),
      expires_at: normalizedTimestamp(record.expires_at ?? record.expiresAt),
      ...grant,
    });
  }
  if (migrated.length === 0) throw new Error("LEGACY_SPECIALIST_REGISTRY_EMPTY");
  const migratedIds = new Set(migrated.map((item) => item.specialist_id));
  for (const requiredId of normalizedIds(requiredSpecialistIds)) {
    const contract = contractForSpecialist(requiredId);
    if (!contract || !migratedIds.has(contract.specialist_id)) {
      throw new Error(`LEGACY_SPECIALIST_REQUIRED_MISSING:${requiredId}`);
    }
  }
  const sql = ["PRAGMA foreign_keys = ON;"];
  for (const item of migrated) {
    sql.push(`
INSERT INTO specialist_principals (
  principal_id, specialist_id, tenant_id, project_ids_json,
  domain_ids_json, memory_domains_json, capabilities_json,
  lane_permissions_json, grant_version, active, created_at, updated_at
) VALUES (
  ${quoted(item.principal_id)}, ${quoted(item.specialist_id)}, ${quoted(item.tenant_id)},
  ${quoted(JSON.stringify(item.project_ids))}, ${quoted(JSON.stringify(item.domain_ids))},
  ${quoted(JSON.stringify(item.memory_domains))}, ${quoted(JSON.stringify(item.capabilities))},
  ${quoted(JSON.stringify(item.lane_permissions))}, ${quoted(item.grant_version)}, 1,
  ${quoted(createdAt)}, ${quoted(createdAt)}
)
ON CONFLICT(principal_id) DO UPDATE SET
  specialist_id = excluded.specialist_id,
  tenant_id = excluded.tenant_id,
  project_ids_json = excluded.project_ids_json,
  domain_ids_json = excluded.domain_ids_json,
  memory_domains_json = excluded.memory_domains_json,
  capabilities_json = excluded.capabilities_json,
  lane_permissions_json = excluded.lane_permissions_json,
  grant_version = excluded.grant_version,
  active = 1,
  updated_at = excluded.updated_at;

UPDATE legacy_credentials
SET active = 0, rotated_at = ${quoted(createdAt)}
WHERE principal_id = ${quoted(item.principal_id)}
  AND key_hash <> ${quoted(item.key_hash)}
  AND active = 1;

INSERT INTO legacy_credentials (
  credential_id, principal_id, key_hash, active, created_at, expires_at, rotated_at
) VALUES (
  ${quoted(item.credential_id)}, ${quoted(item.principal_id)}, ${quoted(item.key_hash)}, 1,
  ${quoted(createdAt)}, ${item.expires_at ? quoted(item.expires_at) : "NULL"}, NULL
)
ON CONFLICT(credential_id) DO UPDATE SET
  principal_id = excluded.principal_id,
  key_hash = excluded.key_hash,
  active = 1,
  expires_at = excluded.expires_at,
  rotated_at = NULL;`);
  }
  return {
    sql: `${sql.join("\n")}\n`,
    migrated_count: migrated.length,
    specialist_ids: [...new Set(migrated.map((item) => item.specialist_id))].sort(),
  };
}

export function extractLivePrincipalRegistry(version) {
  const binding = collectBindings(version).find(
    (item) => item.type === "json" && item.name === "MATRIX_PRINCIPAL_KEYS",
  );
  if (!binding) throw new Error("LEGACY_SPECIALIST_BINDING_MISSING");
  if (typeof binding.json === "string") {
    try {
      return JSON.parse(binding.json);
    } catch {
      throw new Error("LEGACY_SPECIALIST_BINDING_INVALID");
    }
  }
  if (binding.json && typeof binding.json === "object") return binding.json;
  throw new Error("LEGACY_SPECIALIST_BINDING_INVALID");
}

function registryEntries(records) {
  if (Array.isArray(records)) return records.map((record) => ({ record: record ?? {} }));
  if (!records || typeof records !== "object") throw new Error("LEGACY_SPECIALIST_REGISTRY_INVALID");
  return Object.entries(records).map(([fallbackKey, record]) => ({
    fallbackKey,
    record: record && typeof record === "object" ? record : {},
  }));
}

function resolveContract(record) {
  const aliases = Array.isArray(record.identity_aliases)
    ? record.identity_aliases
    : Array.isArray(record.identityAliases)
      ? record.identityAliases
      : [];
  const candidates = [
    record.specialist_id,
    record.specialistId,
    record.identity,
    ...aliases,
    record.credential_id,
    record.credentialId,
  ];
  for (const candidate of candidates) {
    const contract = contractForSpecialist(candidate);
    if (contract) return contract;
  }
  return null;
}

function normalizedIds(value) {
  let values = value;
  if (typeof values === "string") {
    try {
      values = JSON.parse(values);
    } catch {
      values = values.split(",");
    }
  }
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizedId).filter(Boolean))].sort();
}

function normalizedId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return IDENTIFIER.test(normalized) ? normalized : null;
}

function normalizedTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = String(value);
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function quoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const versionPath = argument("--version-file");
  const outputPath = argument("--output");
  if (!versionPath || !outputPath || outputPath === "-") {
    console.error("Usage: node scripts/migrate-live-specialist-credentials.mjs --version-file FILE --output FILE");
    process.exitCode = 2;
  } else {
    try {
      const version = JSON.parse(await readFile(resolve(versionPath), "utf8"));
      const result = await buildLiveSpecialistCredentialSql(
        extractLivePrincipalRegistry(version),
        {
          pepper: process.env.LEGACY_CREDENTIAL_PEPPER,
          createdAt: new Date().toISOString(),
          tenantId: process.env.MEMORY_TENANT_ID || "personal",
          defaultProjectIds: String(process.env.SPECIALIST_DEFAULT_PROJECT_IDS || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          requiredSpecialistIds: String(process.env.SPECIALIST_REQUIRED_IDS || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
      );
      await writeFile(resolve(outputPath), result.sql, { encoding: "utf8", mode: 0o600 });
      console.log(`prepared ${result.migrated_count} hashed credentials for ${result.specialist_ids.join(",")}`);
    } catch (error) {
      console.error(/^LEGACY_[A-Z0-9_:.-]+$/.test(error.message ?? "")
        ? error.message
        : "LEGACY_SPECIALIST_MIGRATION_FAILED");
      process.exitCode = 1;
    }
  }
}
