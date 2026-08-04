import { buildAuthorizedVisualSkillFilter } from "../specialists/retrieval.js";
import {
  validateVisualSkillProjection,
  VISUAL_SKILL_CONTRACT,
} from "./contracts.js";

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

export async function retrieveVisualSkills({ env, principal, input }) {
  const filter = buildAuthorizedVisualSkillFilter(principal, input);
  const query = String(input?.query ?? "").trim();
  if (!query || query.length > 1000) throw invalid("VISUAL_SKILL_QUERY_INVALID", 400);
  const topK = Math.min(25, Math.max(1, Number.parseInt(input.top_k ?? input.topK ?? 5, 10) || 5));
  const threshold = Math.min(0.95, Math.max(0.5, Number(input.threshold ?? 0.65) || 0.65));
  if (!env?.AI?.run || !env?.MATRIX_SKILLS?.query) {
    return unavailable(query, threshold, "visual skill bindings unavailable");
  }
  let vector;
  try {
    const embedded = await env.AI.run(EMBEDDING_MODEL, { text: [query] });
    vector = embedded?.data?.[0];
  } catch {
    return unavailable(query, threshold, "embedding unavailable");
  }
  if (!Array.isArray(vector) || vector.length === 0) {
    return unavailable(query, threshold, "embedding unavailable");
  }
  let matches;
  try {
    const response = await env.MATRIX_SKILLS.query(vector, {
      topK,
      returnMetadata: "all",
      filter,
    });
    matches = Array.isArray(response?.matches) ? response.matches : [];
  } catch {
    return unavailable(query, threshold, "skills index unavailable");
  }
  const authorized = matches.filter((match) => authorizedMetadata(match, filter));
  const results = authorized
    .filter((match) => Number(match.score) >= threshold)
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, topK)
    .map(formatVisualSkillMatch);
  return {
    verification: "passed",
    state: results.length > 0
      ? "results"
      : authorized.length > 0
        ? "below-threshold"
        : "empty",
    query,
    threshold,
    total_raw: matches.length,
    authorized_raw: authorized.length,
    above_threshold: results.length,
    results,
    errors: [],
    api: "/v1/skills/retrieval",
  };
}

export function formatVisualSkillMatch(match) {
  const metadata = match.metadata ?? {};
  return {
    id: match.id,
    score: Number(Number(match.score).toFixed(4)),
    skill_id: metadata.skill_id,
    authority_owner: metadata.authority_owner,
    source_sha256: metadata.source_sha256,
    card_sha256: metadata.card_sha256,
    source_pages: String(metadata.source_pages ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number),
    catalog_version: metadata.catalog_version,
    status: metadata.status,
    citation: metadata.citation_path,
    project_id: metadata.project_id,
    domain_id: metadata.domain_id,
  };
}

function authorizedMetadata(match, filter) {
  const metadata = match?.metadata;
  const scoped = metadata?.tenant_id === filter.tenant_id
    && metadata?.project_id === filter.project_id
    && metadata?.domain_id === filter.domain_id
    && metadata?.consumer_id === filter.consumer_id
    && metadata?.authority_owner === VISUAL_SKILL_CONTRACT.authority_owner
    && metadata?.source_sha256 === VISUAL_SKILL_CONTRACT.source_sha256
    && metadata?.catalog_version === VISUAL_SKILL_CONTRACT.catalog_version
    && metadata?.status === "accepted";
  if (!scoped) return false;
  try {
    validateVisualSkillProjection({ id: match.id, metadata });
    return true;
  } catch {
    return false;
  }
}

function unavailable(query, threshold, reason) {
  return {
    verification: "unavailable",
    state: "unavailable",
    query,
    threshold,
    total_raw: 0,
    authorized_raw: 0,
    above_threshold: 0,
    results: [],
    errors: [{ code: "VISUAL_SKILL_RETRIEVAL_UNAVAILABLE", reason }],
    api: "/v1/skills/retrieval",
  };
}

function invalid(code, status = 403) {
  return Object.assign(new Error(code), { code, status });
}
