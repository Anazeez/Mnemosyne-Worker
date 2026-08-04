#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  contentHash,
  prepareVisualSkillProjection,
} from "../src/visual-skills/projection.js";

const options = parseArgs(process.argv.slice(2));
const skillRoot = resolve(required(options, "skill-root"));
const expectedSkillHash = required(options, "expected-skill-hash");
const catalogVersion = required(options, "catalog-version");
const output = resolve(required(options, "output"));

const observedSkillHash = await contentHash(skillRoot);
if (observedSkillHash !== expectedSkillHash) throw new Error("VISUAL_SKILL_INSTALLED_HASH_MISMATCH");
const catalog = JSON.parse(await readFile(join(skillRoot, "references/catalog.json"), "utf8"));
const provenance = JSON.parse(await readFile(join(skillRoot, "references/provenance.json"), "utf8"));
const packet = await prepareVisualSkillProjection({
  cards: catalog.cards,
  provenance,
  installedSkillHash: observedSkillHash,
  catalogVersion,
});
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(
    join(output, "projection-records.jsonl"),
    `${packet.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  ),
  writeFile(join(output, "projection-manifest.json"), `${JSON.stringify(packet.manifest, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({
  verification: "passed",
  installed_skill_hash: observedSkillHash,
  card_count: packet.manifest.card_count,
  projection_count: packet.manifest.projection_count,
  manifest_sha256: packet.manifest.manifest_sha256,
})}\n`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) throw new Error("INVALID_ARGUMENTS");
    parsed[key.slice(2)] = argv[index + 1];
  }
  return parsed;
}

function required(options, key) {
  const value = String(options[key] ?? "").trim();
  if (!value) throw new Error(`MISSING_${key.toUpperCase().replaceAll("-", "_")}`);
  return value;
}
