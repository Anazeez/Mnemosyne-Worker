const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{1,127}$/u;
const FAMILY = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const MAX_METADATA_BYTES = 2048;

export const VISUAL_SKILL_CONTRACT = Object.freeze({
  tenant_id: "personal",
  project_id: "project-infinitum",
  domain_id: "visual-design-expression",
  authority_owner: "haava",
  consumers: Object.freeze(["haava", "general-assistant"]),
  source_sha256: "30a4f87a42821a21e633424ab333d6103b6a6ad911d963bd756fb9ca16ca715a",
  index_binding: "MATRIX_SKILLS",
  catalog_version: "2026-08-04.1",
  projection_prefix: "visual-skill:2026-08-04.1:",
});

export class VisualSkillContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "VisualSkillContractError";
    this.code = code;
  }
}

export function projectionIdFor(consumerId, skillId) {
  const consumer = normalizeConsumer(consumerId);
  const skill = normalizeIdentifier(skillId, "VISUAL_SKILL_ID_INVALID");
  return `${VISUAL_SKILL_CONTRACT.projection_prefix}${consumer}:${skill}`;
}

export function buildVisualSkillProjection(card, consumerId, clientMetadata = {}) {
  if (Object.keys(clientMetadata ?? {}).length > 0) {
    throw invalid("CLIENT_SCOPE_OVERRIDE_DENIED");
  }
  const consumer = normalizeConsumer(consumerId);
  assertAcceptedCard(card);
  const sourcePages = card.source_pages.join(",");
  const citationPath = `references/${card.primary_family}.md#${card.skill_id}`;
  const record = {
    id: projectionIdFor(consumer, card.skill_id),
    metadata: {
      tenant_id: VISUAL_SKILL_CONTRACT.tenant_id,
      project_id: VISUAL_SKILL_CONTRACT.project_id,
      domain_id: VISUAL_SKILL_CONTRACT.domain_id,
      authority_owner: VISUAL_SKILL_CONTRACT.authority_owner,
      consumer_id: consumer,
      source_sha256: card.source_sha256,
      skill_id: card.skill_id,
      card_sha256: card.content_sha256,
      catalog_version: VISUAL_SKILL_CONTRACT.catalog_version,
      status: "accepted",
      source_pages: sourcePages,
      citation_path: citationPath,
    },
  };
  validateVisualSkillProjection(record);
  return record;
}

export function validateVisualSkillProjection(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw invalid("VISUAL_SKILL_PROJECTION_INVALID");
  }
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw invalid("VISUAL_SKILL_METADATA_INVALID");
  }
  if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    throw invalid("VISUAL_SKILL_METADATA_TOO_LARGE");
  }
  if (!String(record.id ?? "").startsWith(VISUAL_SKILL_CONTRACT.projection_prefix)) {
    throw invalid("VISUAL_SKILL_PROJECTION_ID_INVALID");
  }
  if (metadata.authority_owner !== VISUAL_SKILL_CONTRACT.authority_owner) {
    throw invalid("VISUAL_SKILL_AUTHORITY_MISMATCH");
  }
  for (const key of ["tenant_id", "project_id", "domain_id"]) {
    if (metadata[key] !== VISUAL_SKILL_CONTRACT[key] || metadata[key] === "*") {
      throw invalid("VISUAL_SKILL_SCOPE_MISMATCH");
    }
  }
  const consumer = normalizeConsumer(metadata.consumer_id);
  const skill = normalizeIdentifier(metadata.skill_id, "VISUAL_SKILL_ID_INVALID");
  const expectedId = projectionIdFor(consumer, skill);
  if (record.id !== expectedId) throw invalid("VISUAL_SKILL_PROJECTION_ID_INVALID");
  if (metadata.source_sha256 !== VISUAL_SKILL_CONTRACT.source_sha256) {
    throw invalid("VISUAL_SKILL_SOURCE_MISMATCH");
  }
  if (!HASH.test(String(metadata.card_sha256 ?? ""))) {
    throw invalid("VISUAL_SKILL_CARD_HASH_INVALID");
  }
  if (
    metadata.catalog_version !== VISUAL_SKILL_CONTRACT.catalog_version
    || metadata.status !== "accepted"
  ) throw invalid("VISUAL_SKILL_STATE_INVALID");
  if (!/^\d+(?:,\d+)*$/u.test(String(metadata.source_pages ?? ""))) {
    throw invalid("VISUAL_SKILL_SOURCE_PAGES_INVALID");
  }
  const citation = String(metadata.citation_path ?? "");
  if (!citation.endsWith(`#${skill}`) || !/^references\/[a-z0-9-]+\.md#[a-z0-9-]+$/u.test(citation)) {
    throw invalid("VISUAL_SKILL_CITATION_INVALID");
  }
  const expectedKeys = [
    "tenant_id", "project_id", "domain_id", "authority_owner", "consumer_id",
    "source_sha256", "skill_id", "card_sha256", "catalog_version", "status",
    "source_pages", "citation_path",
  ];
  if (
    Object.keys(metadata).length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(metadata, key))
    || Object.values(metadata).some((value) => !["string", "number", "boolean"].includes(typeof value))
  ) throw invalid("VISUAL_SKILL_METADATA_INVALID");
  return record;
}

function assertAcceptedCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw invalid("VISUAL_SKILL_CARD_INVALID");
  }
  normalizeIdentifier(card.skill_id, "VISUAL_SKILL_ID_INVALID");
  if (card.status !== "accepted") throw invalid("VISUAL_SKILL_NOT_ACCEPTED");
  if (card.source_sha256 !== VISUAL_SKILL_CONTRACT.source_sha256) {
    throw invalid("VISUAL_SKILL_SOURCE_MISMATCH");
  }
  if (!HASH.test(String(card.content_sha256 ?? ""))) {
    throw invalid("VISUAL_SKILL_CARD_HASH_INVALID");
  }
  if (!FAMILY.test(String(card.primary_family ?? ""))) {
    throw invalid("VISUAL_SKILL_FAMILY_INVALID");
  }
  if (
    !Array.isArray(card.source_pages)
    || card.source_pages.length === 0
    || card.source_pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 10000)
  ) throw invalid("VISUAL_SKILL_SOURCE_PAGES_INVALID");
}

function normalizeConsumer(value) {
  const consumer = String(value ?? "").trim().toLowerCase();
  if (!VISUAL_SKILL_CONTRACT.consumers.includes(consumer)) {
    throw invalid("VISUAL_SKILL_CONSUMER_DENIED");
  }
  return consumer;
}

function normalizeIdentifier(value, code) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!IDENTIFIER.test(normalized) || normalized.includes("..")) throw invalid(code);
  return normalized;
}

function invalid(code) {
  return new VisualSkillContractError(code);
}
