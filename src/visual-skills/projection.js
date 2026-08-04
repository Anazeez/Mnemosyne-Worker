import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  VISUAL_SKILL_CONTRACT,
  buildVisualSkillProjection,
} from "./contracts.js";

export function buildEmbeddingDocument(card) {
  return [
    `Capability: ${bounded(card.name, 180, "VISUAL_SKILL_NAME_INVALID")}`,
    `Triggers: ${boundedList(card.triggers, 8, 240, "VISUAL_SKILL_TRIGGERS_INVALID").join("; ")}`,
    `Method: ${boundedList(card.method, 8, 500, "VISUAL_SKILL_METHOD_INVALID")
      .map((item, index) => `${index + 1}. ${item}`).join(" ")}`,
    `Constraints: ${boundedList(card.constraints, 8, 400, "VISUAL_SKILL_CONSTRAINTS_INVALID").join("; ")}`,
    `Citation: ${card.skill_id} | pages ${card.source_pages.join(", ")} | references/${card.primary_family}.md#${card.skill_id}`,
  ].join("\n");
}

export async function prepareVisualSkillProjection({
  cards,
  provenance,
  installedSkillHash,
  catalogVersion,
}) {
  if (catalogVersion !== VISUAL_SKILL_CONTRACT.catalog_version) {
    throw invalid("VISUAL_SKILL_CATALOG_VERSION_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(installedSkillHash ?? ""))) {
    throw invalid("VISUAL_SKILL_INSTALLED_HASH_INVALID");
  }
  if (provenance?.source?.source_sha256 !== VISUAL_SKILL_CONTRACT.source_sha256) {
    throw invalid("VISUAL_SKILL_SOURCE_MISMATCH");
  }
  if (!Array.isArray(cards) || cards.length === 0) throw invalid("VISUAL_SKILL_CARDS_REQUIRED");
  const ids = cards.map((card) => card?.skill_id);
  if (new Set(ids).size !== ids.length) throw invalid("VISUAL_SKILL_DUPLICATE_CARD");
  if (provenance?.summary?.accepted_cards !== cards.length) {
    throw invalid("VISUAL_SKILL_CARD_COUNT_MISMATCH");
  }

  const records = [];
  for (const card of [...cards].sort((left, right) => left.skill_id.localeCompare(right.skill_id))) {
    verifyCardHash(card);
    const embeddingInput = buildEmbeddingDocument(card);
    const embeddingInputSha256 = sha256(embeddingInput);
    for (const consumer of VISUAL_SKILL_CONTRACT.consumers) {
      const projection = buildVisualSkillProjection(card, consumer);
      const core = {
        ...projection,
        embedding_input: embeddingInput,
        embedding_input_sha256: embeddingInputSha256,
      };
      records.push({ ...core, record_sha256: sha256(canonicalJson(core)) });
    }
  }
  records.sort((left, right) => left.id.localeCompare(right.id));
  const recordHashes = records.map((record) => ({ id: record.id, record_sha256: record.record_sha256 }));
  const manifestCore = {
    schema: "mnemosyne-visual-skill-projection-v1",
    catalog_version: VISUAL_SKILL_CONTRACT.catalog_version,
    projection_prefix: VISUAL_SKILL_CONTRACT.projection_prefix,
    index_binding: VISUAL_SKILL_CONTRACT.index_binding,
    source_sha256: VISUAL_SKILL_CONTRACT.source_sha256,
    installed_skill_hash: installedSkillHash,
    card_count: cards.length,
    projection_count: records.length,
    ids: records.map((record) => record.id),
    record_hashes: recordHashes,
  };
  return {
    records,
    manifest: {
      ...manifestCore,
      manifest_sha256: sha256(canonicalJson(manifestCore)),
    },
  };
}

export async function contentHash(root) {
  const base = resolve(root);
  const files = await walk(base);
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(relative(base, path).split("\\").join("/"));
    digest.update("\0");
    digest.update(await readFile(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function verifyCardHash(card) {
  const { content_sha256: observed, ...core } = card ?? {};
  if (!/^[a-f0-9]{64}$/u.test(String(observed ?? ""))) {
    throw invalid("VISUAL_SKILL_CARD_HASH_INVALID");
  }
  if (sha256(JSON.stringify(core)) !== observed) {
    throw invalid("VISUAL_SKILL_CARD_HASH_MISMATCH");
  }
}

async function walk(root) {
  const output = [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".pyc") && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "__pycache__" && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of files) output.push(join(root, entry.name));
  for (const entry of directories) {
    output.push(...await walk(join(root, entry.name)));
  }
  return output;
}

function bounded(value, maximum, code) {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum) throw invalid(code);
  return normalized;
}

function boundedList(value, maximumItems, maximumItemLength, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) throw invalid(code);
  return value.map((item) => bounded(item, maximumItemLength, code));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(code) {
  return Object.assign(new Error(code), { code });
}
