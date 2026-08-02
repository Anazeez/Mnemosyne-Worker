import { SPECIALIST_CONTRACTS } from "./contracts.js";

export class SpecialistPolicyError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = "SpecialistPolicyError";
    this.code = code;
    this.status = status;
  }
}

export function assertSpecialistAccess(principal, target, capability) {
  if (!principal?.capabilities?.includes(capability)) {
    throw denied("CAPABILITY_DENIED", "Required capability is outside the principal grant");
  }
  if (principal.tenant_id !== target?.tenant_id) {
    throw denied("TENANT_SCOPE_DENIED", "Tenant is outside the principal grant");
  }
  if (!principal.project_ids?.includes(target?.project_id)) {
    throw denied("PROJECT_SCOPE_DENIED", "Project is outside the principal grant");
  }
  if (!principal.domain_ids?.includes(target?.domain_id)) {
    throw denied("DOMAIN_SCOPE_DENIED", "Domain is outside the principal grant");
  }
  const identityId = target?.identity_id ?? target?.specialist_id;
  if (identityId && !principal.identity_ids?.includes(identityId)) {
    throw denied("IDENTITY_SCOPE_DENIED", "Identity is outside the principal grant");
  }
  if (target?.lane && !principal.lane_permissions?.includes(target.lane)) {
    throw denied("LANE_SCOPE_DENIED", "Lane is outside the principal grant");
  }
  return target;
}

export function canObserveMessage(principal, message) {
  const actor = principal?.specialist_id ?? principal?.principal_id;
  if (principal?.role === "owner" || actor === "architectus") return true;
  if (actor === message?.target_specialist) return true;
  if (actor === "savae") {
    return message?.lane === "savae-routed"
      || Number(message?.forwarded_by_architectus) === 1;
  }
  return actor === "synn" && isConfirmedCritical(message);
}

export function observableMessageView(principal, message) {
  if (!canObserveMessage(principal, message)) return null;
  const actor = principal?.specialist_id ?? principal?.principal_id;
  if (actor === "synn"
    && actor !== message?.target_specialist
    && isConfirmedCritical(message)) {
    return {
      message_id: message.message_id,
      security_state: message.security_state,
      severity: message.preflight.severity,
      decision: message.preflight.decision,
      reason_codes: [...(message.preflight.reason_codes ?? [])],
      redacted: true,
    };
  }
  return structuredClone(message);
}

export function contractForSpecialist(idOrAlias) {
  const normalized = String(idOrAlias ?? "").trim().toLowerCase();
  return SPECIALIST_CONTRACTS[normalized]
    ?? Object.values(SPECIALIST_CONTRACTS).find((item) => item.aliases.includes(normalized))
    ?? null;
}

function isConfirmedCritical(message) {
  return message?.preflight?.severity === "critical"
    && message?.preflight?.decision === "block";
}

function denied(code, message) {
  return new SpecialistPolicyError(code, message, 403);
}
