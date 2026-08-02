import { contractForSpecialist } from "../specialists/policy.js";

const STORAGE_PARTITIONS = Object.freeze([
  "knowledge",
  "agents",
  "skills",
  "files",
  "library",
]);

export async function hashLegacyKey(rawKey, pepper) {
  const secret = new TextEncoder().encode(String(pepper ?? ""));
  if (secret.byteLength < 32) {
    throw new Error("LEGACY_CREDENTIAL_PEPPER_INVALID");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(rawKey ?? "")),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticateLegacyRequest(request, env, { now } = {}) {
  const rawKey = String(request.headers.get("X-Matrix-Key") ?? "");
  if (rawKey.length < 20 || !env?.DB) return null;
  const pepper = String(env.LEGACY_CREDENTIAL_PEPPER ?? "");
  if (new TextEncoder().encode(pepper).byteLength < 32) return null;

  const keyHash = await hashLegacyKey(rawKey, pepper);
  let row;
  try {
    row = await env.DB.prepare(`
      SELECT
        c.credential_id,
        p.principal_id,
        p.specialist_id,
        p.tenant_id,
        p.project_ids_json,
        p.domain_ids_json,
        p.memory_domains_json,
        p.capabilities_json,
        p.lane_permissions_json,
        p.grant_version
      FROM legacy_credentials c
      JOIN specialist_principals p ON p.principal_id = c.principal_id
      WHERE c.key_hash = ?
        AND c.active = 1
        AND c.rotated_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > ?)
        AND p.active = 1
    `).bind(keyHash, now ?? new Date().toISOString()).first();
  } catch {
    return null;
  }
  if (!row) return null;
  if (
    env.SPECIALIST_GRANT_VERSION
    && row.grant_version !== env.SPECIALIST_GRANT_VERSION
  ) return null;

  const contract = contractForSpecialist(row.specialist_id);
  const projectIds = parseList(row.project_ids_json);
  const domainIds = parseList(row.domain_ids_json);
  const memoryDomains = parseList(row.memory_domains_json);
  const capabilities = parseList(row.capabilities_json);
  const lanePermissions = parseList(row.lane_permissions_json);
  if (
    !contract
    || projectIds.length === 0
    || projectIds.includes("*")
    || domainIds.length === 0
    || memoryDomains.length === 0
    || memoryDomains.includes("*")
    || !memoryDomains.every((value) => STORAGE_PARTITIONS.includes(value))
    || !domainIds.every((value) => contract.domain_ids.includes(value))
    || !capabilities.every((value) => contract.capabilities.includes(value))
    || !lanePermissions.every((value) => contract.lane_permissions.includes(value))
    || !/^[a-f0-9]{64}$/.test(String(row.grant_version ?? ""))
  ) return null;

  return {
    tenant_id: row.tenant_id,
    credential_id: row.credential_id,
    principal_id: row.specialist_id,
    role: "specialist",
    specialist_id: row.specialist_id,
    capabilities,
    memory_domains: memoryDomains,
    project_ids: projectIds,
    domain_ids: domainIds,
    identity_ids: [row.specialist_id],
    lane_permissions: lanePermissions,
    grant_version: row.grant_version,
    receives_mandates: true,
  };
}

export async function constantTimeSecretEqual(left, right) {
  const leftBytes = new TextEncoder().encode(String(left ?? ""));
  const rightBytes = new TextEncoder().encode(String(right ?? ""));
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function parseList(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      return [];
    }
    return [...new Set(parsed.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}
