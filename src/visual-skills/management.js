import {
  VISUAL_SKILL_CONTRACT,
  validateVisualSkillProjection,
} from "./contracts.js";

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

export async function manageVisualSkillProjection({
  command = "plan",
  records,
  manifest,
  expectedCatalogVersion,
  expectedInstalledSkillHash,
  environment,
  apply = false,
  bindings,
}) {
  const normalizedCommand = String(command || "plan").trim();
  if (!["plan", "upsert", "verify", "remove-version"].includes(normalizedCommand)) {
    throw invalid("VISUAL_SKILL_COMMAND_INVALID");
  }
  await validatePacket({ records, manifest, expectedCatalogVersion, expectedInstalledSkillHash });
  const index = bindings?.MATRIX_SKILLS;
  if (!index?.getByIds) throw invalid("VISUAL_SKILL_INDEX_UNAVAILABLE");
  if (["upsert", "remove-version"].includes(normalizedCommand)) {
    if (!apply) throw invalid("VISUAL_SKILL_APPLY_REQUIRED");
    if (environment !== "production") throw invalid("VISUAL_SKILL_ENVIRONMENT_MISMATCH");
  }

  const existing = await index.getByIds(manifest.ids);
  const existingById = new Map((existing ?? []).map((item) => [item.id, item]));
  const recordsById = new Map(records.map((item) => [item.id, item]));
  const missingIds = [];
  const unchangedIds = [];
  const conflictIds = [];
  for (const id of manifest.ids) {
    const observed = existingById.get(id);
    if (!observed) missingIds.push(id);
    else if (canonicalJson(observed.metadata) === canonicalJson(recordsById.get(id).metadata)) unchangedIds.push(id);
    else conflictIds.push(id);
  }

  if (normalizedCommand === "plan") {
    return planReceipt(normalizedCommand, manifest, missingIds, unchangedIds, conflictIds);
  }
  if (normalizedCommand === "verify") {
    return {
      command: normalizedCommand,
      verification: missingIds.length === 0 && conflictIds.length === 0 ? "passed" : "failed",
      verified: unchangedIds.length,
      missing_ids: missingIds,
      mismatched_ids: conflictIds,
      manifest_sha256: manifest.manifest_sha256,
    };
  }
  if (normalizedCommand === "remove-version") {
    assertRemovalBounds(manifest, records);
    await index.deleteByIds(manifest.ids);
    return {
      command: normalizedCommand,
      verification: "passed",
      removed: existingById.size,
      ids: [...manifest.ids],
      manifest_sha256: manifest.manifest_sha256,
    };
  }
  if (conflictIds.length > 0) throw invalid("VISUAL_SKILL_PROJECTION_CONFLICT");
  if (missingIds.length === 0) {
    return {
      ...planReceipt(normalizedCommand, manifest, missingIds, unchangedIds, conflictIds),
      applied: 0,
    };
  }
  const ai = bindings?.AI;
  if (!ai?.run || !index?.upsert) throw invalid("VISUAL_SKILL_MUTATION_BINDINGS_UNAVAILABLE");
  const missing = missingIds.map((id) => recordsById.get(id));
  const uniqueInputs = [...new Map(missing.map((record) => [
    record.embedding_input_sha256,
    record.embedding_input,
  ])).entries()];
  const response = await ai.run(EMBEDDING_MODEL, { text: uniqueInputs.map(([, input]) => input) });
  if (!Array.isArray(response?.data) || response.data.length !== uniqueInputs.length) {
    throw invalid("VISUAL_SKILL_EMBEDDING_FAILED");
  }
  const vectorsByHash = new Map(uniqueInputs.map(([hash], index_) => [hash, response.data[index_]]));
  const vectors = missing.map((record) => ({
    id: record.id,
    values: vectorsByHash.get(record.embedding_input_sha256),
    metadata: record.metadata,
  }));
  if (vectors.some((item) => !Array.isArray(item.values) || item.values.length === 0)) {
    throw invalid("VISUAL_SKILL_EMBEDDING_FAILED");
  }
  await index.upsert(vectors);
  return {
    command: normalizedCommand,
    verification: "passed",
    applied: vectors.length,
    unchanged: unchangedIds.length,
    conflicts: 0,
    ids: vectors.map((item) => item.id),
    manifest_sha256: manifest.manifest_sha256,
  };
}

async function validatePacket({ records, manifest, expectedCatalogVersion, expectedInstalledSkillHash }) {
  if (!manifest || !Array.isArray(records)) throw invalid("VISUAL_SKILL_PACKET_INVALID");
  if (
    expectedCatalogVersion !== VISUAL_SKILL_CONTRACT.catalog_version
    || manifest.catalog_version !== expectedCatalogVersion
  ) throw invalid("VISUAL_SKILL_CATALOG_VERSION_MISMATCH");
  if (
    !/^[a-f0-9]{64}$/u.test(String(expectedInstalledSkillHash ?? ""))
    || manifest.installed_skill_hash !== expectedInstalledSkillHash
  ) throw invalid("VISUAL_SKILL_INSTALLED_HASH_MISMATCH");
  if (
    manifest.projection_prefix !== VISUAL_SKILL_CONTRACT.projection_prefix
    || !manifest.projection_prefix
    || manifest.projection_prefix.includes("*")
  ) throw invalid("VISUAL_SKILL_PROJECTION_PREFIX_INVALID");
  if (
    manifest.index_binding !== VISUAL_SKILL_CONTRACT.index_binding
    || manifest.source_sha256 !== VISUAL_SKILL_CONTRACT.source_sha256
  ) throw invalid("VISUAL_SKILL_MANIFEST_SCOPE_MISMATCH");
  if (
    manifest.projection_count !== records.length
    || manifest.ids?.length !== records.length
    || manifest.card_count * VISUAL_SKILL_CONTRACT.consumers.length !== records.length
  ) throw invalid("VISUAL_SKILL_MANIFEST_COUNT_MISMATCH");
  const ids = records.map((record) => record.id);
  if (
    new Set(ids).size !== ids.length
    || canonicalJson([...ids].sort()) !== canonicalJson(manifest.ids)
  ) throw invalid("VISUAL_SKILL_MANIFEST_MEMBERSHIP_MISMATCH");
  const recordHashes = [];
  for (const record of records) {
    validateVisualSkillProjection(record);
    if (!record.id.startsWith(manifest.projection_prefix)) throw invalid("VISUAL_SKILL_PROJECTION_ID_INVALID");
    if (!/^[a-f0-9]{64}$/u.test(String(record.embedding_input_sha256 ?? ""))) {
      throw invalid("VISUAL_SKILL_EMBEDDING_HASH_INVALID");
    }
    if (await sha256(record.embedding_input) !== record.embedding_input_sha256) {
      throw invalid("VISUAL_SKILL_EMBEDDING_HASH_MISMATCH");
    }
    const { record_sha256: observed, ...core } = record;
    if (await sha256(canonicalJson(core)) !== observed) throw invalid("VISUAL_SKILL_RECORD_HASH_MISMATCH");
    recordHashes.push({ id: record.id, record_sha256: observed });
  }
  if (canonicalJson(recordHashes) !== canonicalJson(manifest.record_hashes)) {
    throw invalid("VISUAL_SKILL_MANIFEST_HASH_MEMBERSHIP_MISMATCH");
  }
  const { manifest_sha256: observedManifestHash, ...manifestCore } = manifest;
  if (await sha256(canonicalJson(manifestCore)) !== observedManifestHash) {
    throw invalid("VISUAL_SKILL_MANIFEST_HASH_MISMATCH");
  }
}

function planReceipt(command, manifest, missingIds, unchangedIds, conflictIds) {
  return {
    command,
    verification: "passed",
    adds: missingIds.length,
    unchanged: unchangedIds.length,
    conflicts: conflictIds.length,
    ids: [...manifest.ids],
    conflict_ids: conflictIds,
    manifest_sha256: manifest.manifest_sha256,
  };
}

function assertRemovalBounds(manifest, records) {
  if (
    !manifest.projection_prefix.startsWith("visual-skill:")
    || manifest.ids.some((id) => !id.startsWith(manifest.projection_prefix))
    || records.some((record) => !manifest.ids.includes(record.id))
  ) throw invalid("VISUAL_SKILL_REMOVAL_SCOPE_INVALID");
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(code) {
  return Object.assign(new Error(code), { code });
}
