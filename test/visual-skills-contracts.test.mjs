import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VISUAL_SKILL_CONTRACT,
  buildVisualSkillProjection,
  projectionIdFor,
  validateVisualSkillProjection,
} from "../src/visual-skills/contracts.js";

const card = JSON.parse(await readFile(
  new URL("fixtures/visual-skills/accepted-card.json", import.meta.url),
  "utf8",
));

test("server contract fixes the exact owner, scope, consumers, and version", () => {
  assert.deepEqual(VISUAL_SKILL_CONTRACT, {
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    authority_owner: "haava",
    consumers: ["haava", "general-assistant"],
    source_sha256: "30a4f87a42821a21e633424ab333d6103b6a6ad911d963bd756fb9ca16ca715a",
    index_binding: "MATRIX_SKILLS",
    catalog_version: "2026-08-04.1",
    projection_prefix: "visual-skill:2026-08-04.1:",
  });
});

test("projection metadata is scalar, bounded, and server-owned", () => {
  const record = buildVisualSkillProjection(card, "general-assistant");
  assert.equal(record.id, "visual-skill:2026-08-04.1:general-assistant:cdv-guide-audience-through-chart");
  assert.deepEqual(record.metadata, {
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    authority_owner: "haava",
    consumer_id: "general-assistant",
    source_sha256: card.source_sha256,
    skill_id: card.skill_id,
    card_sha256: card.content_sha256,
    catalog_version: "2026-08-04.1",
    status: "accepted",
    source_pages: "16,136,142,148",
    citation_path: "references/storytelling.md#cdv-guide-audience-through-chart",
  });
  assert.ok(Object.values(record.metadata).every((value) => ["string", "number", "boolean"].includes(typeof value)));
  assert.ok(JSON.stringify(record.metadata).length <= 2048);
  assert.equal(validateVisualSkillProjection(record), record);
});

test("projection builder rejects scope injection and invalid accepted-card evidence", () => {
  assert.throws(
    () => buildVisualSkillProjection(card, "general-assistant", { project_id: "*" }),
    (error) => error.code === "CLIENT_SCOPE_OVERRIDE_DENIED",
  );
  assert.throws(
    () => buildVisualSkillProjection(card, "unknown-consumer"),
    (error) => error.code === "VISUAL_SKILL_CONSUMER_DENIED",
  );
  assert.throws(
    () => buildVisualSkillProjection({ ...card, status: "candidate" }, "haava"),
    (error) => error.code === "VISUAL_SKILL_NOT_ACCEPTED",
  );
  assert.throws(
    () => buildVisualSkillProjection({ ...card, source_sha256: "0".repeat(64) }, "haava"),
    (error) => error.code === "VISUAL_SKILL_SOURCE_MISMATCH",
  );
  assert.throws(
    () => buildVisualSkillProjection({ ...card, content_sha256: "bad" }, "haava"),
    (error) => error.code === "VISUAL_SKILL_CARD_HASH_INVALID",
  );
});

test("validator rejects non-Haava authority, wildcard scope, overlong metadata, and foreign IDs", () => {
  const baseline = buildVisualSkillProjection(card, "haava");
  for (const [field, value, code] of [
    ["authority_owner", "savae", "VISUAL_SKILL_AUTHORITY_MISMATCH"],
    ["project_id", "*", "VISUAL_SKILL_SCOPE_MISMATCH"],
    ["citation_path", `references/${"x".repeat(2050)}`, "VISUAL_SKILL_METADATA_TOO_LARGE"],
  ]) {
    const changed = structuredClone(baseline);
    changed.metadata[field] = value;
    assert.throws(() => validateVisualSkillProjection(changed), (error) => error.code === code);
  }
  assert.throws(
    () => validateVisualSkillProjection({ ...baseline, id: `other:${baseline.id}` }),
    (error) => error.code === "VISUAL_SKILL_PROJECTION_ID_INVALID",
  );
});

test("projection IDs are stable and reject wildcard or malformed identifiers", () => {
  assert.equal(
    projectionIdFor("haava", card.skill_id),
    "visual-skill:2026-08-04.1:haava:cdv-guide-audience-through-chart",
  );
  assert.throws(() => projectionIdFor("*", card.skill_id), /VISUAL_SKILL_CONSUMER_DENIED/u);
  assert.throws(() => projectionIdFor("haava", "../foreign"), /VISUAL_SKILL_ID_INVALID/u);
});
