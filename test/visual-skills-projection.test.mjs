import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildEmbeddingDocument,
  prepareVisualSkillProjection,
} from "../src/visual-skills/projection.js";

const card = JSON.parse(await readFile(
  new URL("fixtures/visual-skills/accepted-card.json", import.meta.url),
  "utf8",
));
const provenance = {
  schema: "communicating-data-visually-provenance-v1",
  source: { source_sha256: card.source_sha256 },
  summary: { accepted_cards: 1 },
};
const installedSkillHash = "f7f1069e200d4f22e03dd8de219dfbec897817da18bebc2a6a44c908f484e5ea";

test("embedding input is deterministic, bounded, and excludes raw source text", () => {
  const document = buildEmbeddingDocument(card);
  assert.equal(document, [
    "Capability: Guide the audience through a chart",
    "Triggers: presenting a chart; explaining findings; designing for client questions",
    "Method: 1. Start from what the audience already knows, does not know, and is trying to decide. 2. Introduce the chart context before asking viewers to interpret marks. 3. Direct attention progressively to the decisive points and reinforce the message with suitable narration.",
    "Constraints: Never show a chart without context or an explanation of why it matters.",
    "Citation: cdv-guide-audience-through-chart | pages 16, 136, 142, 148 | references/storytelling.md#cdv-guide-audience-through-chart",
  ].join("\n"));
  assert.ok(document.length < 2000);
  assert.doesNotMatch(document, /Almost every aspect of our daily routine generates data/u);
});

test("preparation emits stable sorted consumer projections and exact manifest membership", async () => {
  const packet = await prepareVisualSkillProjection({
    cards: [card], provenance, installedSkillHash, catalogVersion: "2026-08-04.1",
  });
  assert.equal(packet.records.length, 2);
  assert.deepEqual(packet.manifest.ids, [
    "visual-skill:2026-08-04.1:general-assistant:cdv-guide-audience-through-chart",
    "visual-skill:2026-08-04.1:haava:cdv-guide-audience-through-chart",
  ]);
  assert.equal(packet.manifest.card_count, 1);
  assert.equal(packet.manifest.projection_count, 2);
  assert.equal(packet.manifest.installed_skill_hash, installedSkillHash);
  assert.equal(packet.manifest.record_hashes.length, 2);
  assert.equal(packet.records[0].embedding_input, packet.records[1].embedding_input);
  assert.equal(packet.records[0].embedding_input_sha256, packet.records[1].embedding_input_sha256);
  assert.deepEqual(packet.records.map((item) => item.id), packet.manifest.ids);
});

test("projection preparation is byte-stable on replay", async () => {
  const options = { cards: [card], provenance, installedSkillHash, catalogVersion: "2026-08-04.1" };
  const first = await prepareVisualSkillProjection(options);
  const second = await prepareVisualSkillProjection(structuredClone(options));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("preparation rejects duplicate cards, changed card evidence, and foreign versions", async () => {
  await assert.rejects(
    prepareVisualSkillProjection({ cards: [card, card], provenance, installedSkillHash, catalogVersion: "2026-08-04.1" }),
    /VISUAL_SKILL_DUPLICATE_CARD/u,
  );
  await assert.rejects(
    prepareVisualSkillProjection({
      cards: [{ ...card, name: "Changed without rehash" }], provenance, installedSkillHash,
      catalogVersion: "2026-08-04.1",
    }),
    /VISUAL_SKILL_CARD_HASH_MISMATCH/u,
  );
  await assert.rejects(
    prepareVisualSkillProjection({ cards: [card], provenance, installedSkillHash, catalogVersion: "2026-08-05.1" }),
    /VISUAL_SKILL_CATALOG_VERSION_MISMATCH/u,
  );
});

test("production manifest pins the exact independently verified global package hash", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../artifacts/visual-skills/2026-08-04.1/projection-manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.installed_skill_hash, installedSkillHash);
  assert.equal(manifest.catalog_version, "2026-08-04.1");
  assert.equal(manifest.projection_count, 48);
});
