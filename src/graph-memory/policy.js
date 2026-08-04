import {
  GraphMemoryError,
  normalizeGraphTarget
} from "./contracts.js";
import { contractForSpecialist } from "../specialists/policy.js";

const PRINCIPAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export const PUBLIC_SCOPE_CAPABILITIES = Object.freeze({
  "identity:read": Object.freeze(["identity.read"]),
  "memory:read": Object.freeze(["memory.read", "continuity.read"]),
  "memory:search": Object.freeze(["memory.search"]),
  "memory:propose": Object.freeze(["memory.propose"]),
  "memory:candidate:read": Object.freeze(["memory.candidate.read.own"]),
  "mesh:inbox": Object.freeze(["exchanges.inbox"]),
});
export const OWNER_SCOPE_CAPABILITIES = Object.freeze({
  "memory:review": Object.freeze([
    "memory.review",
    "memory.validate",
    "memory.resolve",
    "memory.publish"
  ])
});

export function principalFromOAuthClaims(claims) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw invalidClaims();
  }

  const tenantId = normalizePrincipalId(claims.tenant_id);
  const credentialId = normalizePrincipalId(claims.credential_id);
  const assistantId = normalizePrincipalId(claims.assistant_id);
  const role = String(claims.role ?? "").trim().toLowerCase();
  const projectIds = normalizeIdList(claims.project_ids);
  const identityIds = normalizeIdList(claims.identity_ids);
  const specialistId = normalizePrincipalId(claims.specialist_id);
  const domainIds = normalizeIdList(claims.domain_ids);
  const consumerIds = normalizeIdList(claims.consumer_ids);
  const memoryDomains = normalizeIdList(claims.memory_domains);
  const lanePermissions = normalizeIdList(claims.lane_permissions);
  const scopes = Array.isArray(claims.scopes)
    ? [...new Set(claims.scopes.map(value => String(value).trim()))]
    : [];

  if (
    !tenantId ||
    !credentialId ||
    !assistantId ||
    !["portal", "specialist", "owner"].includes(role) ||
    projectIds.length === 0
  ) {
    throw invalidClaims();
  }

  const specialistContract = role === "specialist"
    ? contractForSpecialist(specialistId)
    : null;
  if (role === "specialist" && (
    !specialistContract ||
    claims.project_ids?.includes("*") ||
    claims.domain_ids?.includes("*") ||
    domainIds.length === 0 ||
    memoryDomains.length === 0 ||
    memoryDomains.includes("*") ||
    !domainIds.every(domain => specialistContract.domain_ids.includes(domain)) ||
    !identityIds.includes(specialistId) ||
    lanePermissions.length === 0 ||
    !lanePermissions.every(lane => specialistContract.lane_permissions.includes(lane)) ||
    !/^[a-f0-9]{64}$/.test(String(claims.grant_version ?? ""))
  )) {
    throw invalidClaims();
  }
  const isVisualConsumer = role === "portal" && consumerIds.length > 0;
  if (isVisualConsumer && (
    consumerIds.length !== 1
    || consumerIds[0] !== "general-assistant"
    || domainIds.length !== 1
    || domainIds[0] !== "visual-design-expression"
    || projectIds.length !== 1
    || projectIds[0] !== "project-infinitum"
    || claims.principal_id !== "general-assistant"
    || !/^oauth-[a-f0-9]{32}$/u.test(String(claims.assistant_id ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(claims.grant_version ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(claims.consumer_grant_version ?? ""))
    || scopes.some((scope) => !["identity:read", "memory:read", "memory:search"].includes(scope))
  )) {
    throw invalidClaims();
  }

  const capabilities = [];
  const scopeCapabilities = role === "owner"
    ? { ...PUBLIC_SCOPE_CAPABILITIES, ...OWNER_SCOPE_CAPABILITIES }
    : PUBLIC_SCOPE_CAPABILITIES;
  for (const scope of scopes) {
    for (const capability of scopeCapabilities[scope] || []) {
      if (!capabilities.includes(capability)) {
        capabilities.push(capability);
      }
    }
  }
  if (role === "specialist") {
    for (const capability of claims.capabilities ?? []) {
      if (
        specialistContract.capabilities.includes(capability) &&
        !capabilities.includes(capability)
      ) capabilities.push(capability);
    }
  }

  return {
    tenant_id: tenantId,
    credential_id: credentialId,
    assistant_id: assistantId,
    principal_id: role === "specialist"
      ? specialistId
      : isVisualConsumer
        ? "general-assistant"
        : role,
    role,
    ...(role === "specialist" ? {
      specialist_id: specialistId,
      domain_ids: domainIds,
      memory_domains: memoryDomains,
      lane_permissions: lanePermissions,
      grant_version: claims.grant_version,
      package_version: String(claims.package_version ?? ""),
    } : {}),
    ...(isVisualConsumer ? {
      consumer_ids: consumerIds,
      domain_ids: domainIds,
      grant_version: claims.grant_version,
      consumer_grant_version: claims.consumer_grant_version,
    } : {}),
    project_ids: projectIds,
    identity_ids: identityIds,
    scopes: scopes.filter(scope => scope in scopeCapabilities),
    capabilities
  };
}

export function assertCurrentSpecialistPackage(principal, expectedVersion) {
  if (principal?.role !== "specialist") return principal;
  const expected = String(expectedVersion ?? "").trim();
  const observed = String(principal.package_version ?? "").trim();
  if (!expected || observed !== expected) {
    throw Object.assign(new Error("SPECIALIST_PACKAGE_STALE"), {
      code: "SPECIALIST_PACKAGE_STALE",
      status: 401,
    });
  }
  return principal;
}

export function assertGraphAccess(principal, target, capability) {
  const normalizedTarget = normalizeGraphTarget(target);

  if (!principal?.capabilities?.includes(capability)) {
    throw new GraphMemoryError(
      "CAPABILITY_DENIED",
      "The authenticated principal lacks the required capability",
      403
    );
  }

  if (principal.tenant_id !== normalizedTarget.tenant_id) {
    throw new GraphMemoryError(
      "TENANT_SCOPE_DENIED",
      "The requested tenant is outside the authenticated scope",
      403
    );
  }

  if (
    !principal.project_ids?.includes("*") &&
    !principal.project_ids?.includes(normalizedTarget.project_id)
  ) {
    throw new GraphMemoryError(
      "PROJECT_SCOPE_DENIED",
      "The requested project is outside the authenticated scope",
      403
    );
  }

  return normalizedTarget;
}

function normalizePrincipalId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return PRINCIPAL_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map(normalizePrincipalId)
    .filter(Boolean);
  return [...new Set(normalized)];
}

function invalidClaims() {
  return new GraphMemoryError(
    "INVALID_OAUTH_CLAIMS",
    "OAuth claims are incomplete or outside the public portal policy",
    401
  );
}
