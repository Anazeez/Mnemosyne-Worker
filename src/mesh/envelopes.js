import { contractForSpecialist } from "../specialists/policy.js";

export class MeshEnvelopeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MeshEnvelopeError";
    this.code = code;
    this.status = status;
  }
}

const ID = /^[a-z0-9][a-z0-9._:-]{7,127}$/u;
const PROJECT = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const SOURCES = new Set(["chatgpt", "email", "mesh", "api"]);
const LANES = new Set(["root-local", "savae-routed"]);
const PREFLIGHTS = new Map([
  ["clear:allow", "cleared"],
  ["warning:alarm", "quarantined"],
  ["critical:block", "blocked"],
]);

export function normalizeMeshEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  if (input.schema_version !== "mnemosyne.mesh.v1") throw invalid();
  const messageId = normalized(input.message_id, ID);
  const correlationId = normalized(input.correlation_id, ID);
  const source = normalized(input.source, SOURCES);
  const principalId = normalized(input.principal_id, ID);
  const projectId = normalized(input.project_id, PROJECT);
  const lane = normalized(input.lane, LANES);
  const contract = contractForSpecialist(input.target_specialist);
  if (!messageId || !correlationId || !source || !principalId || !projectId || !lane || !contract) {
    throw invalid();
  }
  const payload = input.payload;
  if (payload === undefined || payload === null || typeof payload === "function") throw invalid();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attachments.length > 20 || attachments.some((item) => !boundedJson(item, 16_384))) {
    throw invalid();
  }
  const severity = normalized(input.preflight?.severity, new Set(["clear", "warning", "critical"]));
  const decision = normalized(input.preflight?.decision, new Set(["allow", "alarm", "block"]));
  const securityState = PREFLIGHTS.get(`${severity}:${decision}`);
  const reasonCodes = Array.isArray(input.preflight?.reason_codes)
    ? [...new Set(input.preflight.reason_codes.map((value) => normalized(value, PROJECT)).filter(Boolean))].slice(0, 20)
    : [];
  if (!securityState || !boundedJson(payload, 196_608)) throw invalid();
  return {
    schema_version: "mnemosyne.mesh.v1",
    message_id: messageId,
    correlation_id: correlationId,
    source,
    principal_id: principalId,
    target_specialist: contract.specialist_id,
    lane,
    project_id: projectId,
    payload,
    attachments,
    forwarded_by_architectus: input.forwarded_by_architectus === true,
    preflight: { severity, decision, reason_codes: reasonCodes },
    security_state: securityState,
  };
}

function normalized(value, vocabulary) {
  const text = String(value ?? "").trim().toLowerCase();
  if (vocabulary instanceof Set) return vocabulary.has(text) ? text : null;
  return vocabulary.test(text) ? text : null;
}

function boundedJson(value, maximum) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
  } catch {
    return false;
  }
}

function invalid() {
  return new MeshEnvelopeError("MESH_ENVELOPE_INVALID");
}
