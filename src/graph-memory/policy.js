import {
  GraphMemoryError,
  normalizeGraphTarget
} from "./contracts.js";

const PRINCIPAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export const PUBLIC_SCOPE_CAPABILITIES = Object.freeze({
  "memory:read": Object.freeze(["memory.read", "continuity.read"]),
  "memory:search": Object.freeze(["memory.search"]),
  "memory:propose": Object.freeze(["memory.propose"]),
  "memory:candidate:read": Object.freeze(["memory.candidate.read.own"])
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
  const scopes = Array.isArray(claims.scopes)
    ? [...new Set(claims.scopes.map(value => String(value).trim()))]
    : [];

  if (
    !tenantId ||
    !credentialId ||
    !assistantId ||
    role !== "portal" ||
    projectIds.length === 0
  ) {
    throw invalidClaims();
  }

  const capabilities = [];
  for (const scope of scopes) {
    for (const capability of PUBLIC_SCOPE_CAPABILITIES[scope] || []) {
      if (!capabilities.includes(capability)) {
        capabilities.push(capability);
      }
    }
  }

  return {
    tenant_id: tenantId,
    credential_id: credentialId,
    assistant_id: assistantId,
    principal_id: role,
    role,
    project_ids: projectIds,
    identity_ids: identityIds,
    scopes: scopes.filter(scope => scope in PUBLIC_SCOPE_CAPABILITIES),
    capabilities
  };
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
