import {
  SpecialistPolicyError,
  assertSpecialistAccess,
} from "./policy.js";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{1,127}$/u;
const VISUAL_SCOPE = Object.freeze({
  tenant_id: "personal",
  project_id: "project-infinitum",
  domain_id: "visual-design-expression",
});

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
    return buildAuthorizedVectorFilter(principal, {
      ...input,
      project_id: input.project_id ?? soleScope(principal.project_ids),
      domain_id: input.domain_id ?? soleScope(principal.domain_ids),
    });
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

export function buildAuthorizedVisualSkillFilter(principal, input = {}) {
  if (!principal?.capabilities?.includes("memory.search")) {
    throw denied("VISUAL_SKILL_SCOPE_DENIED", "Visual skill search is outside the principal grant");
  }
  let consumerId;
  if (principal.role === "specialist") {
    if (principal.specialist_id !== "haava") {
      throw denied("VISUAL_SKILL_CONSUMER_DENIED", "Only Haava owns the specialist projection");
    }
    consumerId = "haava";
  } else if (
    principal.role === "portal"
    && principal.consumer_ids?.includes("general-assistant")
  ) {
    consumerId = "general-assistant";
  } else {
    throw denied("VISUAL_SKILL_CONSUMER_DENIED", "The principal has no visual skill consumer binding");
  }
  if (input.consumer_id && String(input.consumer_id).trim().toLowerCase() !== consumerId) {
    throw denied("VISUAL_SKILL_CONSUMER_DENIED", "Caller consumer impersonation is denied");
  }
  if (principal.role === "portal" && (!input.project_id || !input.domain_id)) {
    throw denied("VISUAL_SKILL_SCOPE_DENIED", "Portal visual skill search requires explicit project and domain");
  }
  const target = {
    tenant_id: input.tenant_id ?? principal.tenant_id,
    project_id: input.project_id ?? soleScope(principal.project_ids),
    domain_id: input.domain_id ?? soleScope(principal.domain_ids),
  };
  if (
    target.tenant_id !== VISUAL_SCOPE.tenant_id
    || target.project_id !== VISUAL_SCOPE.project_id
    || target.domain_id !== VISUAL_SCOPE.domain_id
    || principal.tenant_id !== VISUAL_SCOPE.tenant_id
    || !principal.project_ids?.includes(VISUAL_SCOPE.project_id)
    || !principal.domain_ids?.includes(VISUAL_SCOPE.domain_id)
  ) {
    throw denied("VISUAL_SKILL_SCOPE_DENIED", "Visual skill target is outside the bounded contract");
  }
  if (principal.role === "specialist") {
    buildAuthorizedVectorFilter(principal, target);
  }
  return { ...VISUAL_SCOPE, consumer_id: consumerId };
}

function soleScope(values) {
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
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
