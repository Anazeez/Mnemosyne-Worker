import {
  SpecialistPolicyError,
  assertSpecialistAccess,
} from "./policy.js";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{1,127}$/u;

export function buildAuthorizedVectorFilter(principal, input = {}) {
  const tenantId = boundedId(input.tenant_id ?? principal?.tenant_id, "TENANT_SCOPE_REQUIRED");
  const projectId = boundedId(input.project_id, "PROJECT_SCOPE_REQUIRED");
  const domainId = boundedId(input.domain_id, "DOMAIN_SCOPE_REQUIRED");

  if (principal?.role === "specialist") {
    assertSpecialistAccess(principal, {
      tenant_id: tenantId,
      project_id: projectId,
      domain_id: domainId,
      ...(input.identity_id ? { identity_id: input.identity_id } : {}),
    }, input.capability ?? "memory.search");
  } else {
    if (
      principal?.tenant_id
      && principal.tenant_id !== tenantId
      && !principal.project_ids?.includes("*")
    ) {
      throw denied("TENANT_SCOPE_DENIED", "Tenant is outside the principal grant");
    }
    if (
      principal?.project_ids?.length
      && !principal.project_ids.includes("*")
      && !principal.project_ids.includes(projectId)
    ) {
      throw denied("PROJECT_SCOPE_DENIED", "Project is outside the principal grant");
    }
  }

  return {
    tenant_id: tenantId,
    project_id: projectId,
    domain_id: domainId,
    ...safeOptionalFilters(input),
  };
}

export function optionalAuthorizedVectorFilter(principal, input = {}) {
  if (principal?.role === "specialist") {
    return buildAuthorizedVectorFilter(principal, input);
  }
  const filter = safeOptionalFilters(input);
  const tenantId = optionalId(input.tenant_id ?? principal?.tenant_id);
  const projectId = optionalId(input.project_id);
  const domainId = optionalId(input.domain_id);
  if (tenantId) filter.tenant_id = tenantId;
  if (projectId) {
    if (
      principal?.project_ids?.length
      && !principal.project_ids.includes("*")
      && !principal.project_ids.includes(projectId)
    ) throw denied("PROJECT_SCOPE_DENIED", "Project is outside the principal grant");
    filter.project_id = projectId;
  }
  if (domainId) filter.domain_id = domainId;
  return filter;
}

function safeOptionalFilters(input) {
  const filter = {};
  const scopeKey = optionalId(input.scope_key);
  const runwayId = optionalId(input.runway_id);
  const createdAfter = boundedText(input.created_after, 128);
  const sourceRefs = Array.isArray(input.source_refs)
    ? input.source_refs
      .map((value) => boundedText(value, 500))
      .filter(Boolean)
      .slice(0, 100)
    : [];
  if (scopeKey) filter.scope_key = scopeKey;
  if (runwayId) filter.runway_id = runwayId;
  if (createdAfter) filter.created = { $gte: createdAfter };
  if (sourceRefs.length > 0) filter.source_ref = { $in: sourceRefs };
  return filter;
}

function boundedId(value, code) {
  const normalized = optionalId(value);
  if (!normalized) throw denied(code, code.toLowerCase());
  return normalized;
}

function optionalId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return IDENTIFIER.test(normalized) ? normalized : null;
}

function boundedText(value, maximum) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function denied(code, message) {
  return new SpecialistPolicyError(code, message, 403);
}
