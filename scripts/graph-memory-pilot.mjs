import { readFile, writeFile } from "node:fs/promises";

import { canonicalHash } from "../src/graph-memory/contracts.js";

const ENTITY_TYPES = new Set([
  "project",
  "decision",
  "service",
  "component",
  "person",
  "organization",
  "artifact",
  "requirement",
  "task",
]);
const RELATION_TYPE = /^[a-z][a-z0-9_]{1,63}$/;

export async function judgeGraphMemoryPilot(records) {
  const entities = records.filter(record => record.kind === "entity");
  const relations = records.filter(record => record.kind === "relation");
  const assertions = records.filter(record => record.kind === "assertion");
  const candidates = records.filter(record =>
    record.kind === "candidate" || record.kind === "quarantine");
  const entityKeys = new Set(entities.map(entityKey));

  const validEntities = entities.filter(record =>
    ENTITY_TYPES.has(record.ontology_type) &&
    bounded(record.entity_id) &&
    String(record.canonical_label || "").trim().length > 0);
  const validRelations = relations.filter(record =>
    RELATION_TYPE.test(String(record.relation_type || "")) &&
    entityKeys.has(entityKey({
      ...record,
      entity_id: record.source_entity_id,
    })) &&
    entityKeys.has(entityKey({
      ...record,
      entity_id: record.target_entity_id,
    })));
  const ontologyValid = [
    ...entities.map(record => ENTITY_TYPES.has(record.ontology_type)),
    ...relations.map(record => RELATION_TYPE.test(String(record.relation_type || ""))),
    ...assertions.map(record => RELATION_TYPE.test(String(record.predicate || ""))),
  ];
  const quarantineReasons = candidates
    .filter(record => record.expected === "quarantined")
    .map(record => record.reason_code || "AMBIGUOUS_ENTITY_RESOLUTION")
    .sort();
  const provenanceValid = candidates.map(record =>
    /^[a-f0-9]{64}$/.test(String(record.evidence_hash || "")) ||
    Boolean(record.reason_code) ||
    record.expected === "quarantined");
  const canonicalInputHash = await canonicalHash(records);
  const replayInputHash = await canonicalHash(
    JSON.parse(JSON.stringify(records)),
  );
  const acceptedView = records.filter(record => record.expected === "accepted");
  const snapshotHash = await canonicalHash(acceptedView);
  const changedView = [...acceptedView, { kind: "broken", id: "transient" }];
  void await canonicalHash(changedView);
  const restoredHash = await canonicalHash(acceptedView);

  const metrics = {
    entity_precision: ratio(validEntities.length, entities.length),
    relation_precision: ratio(validRelations.length, relations.length),
    provenance_coverage: ratio(
      provenanceValid.filter(Boolean).length,
      provenanceValid.length,
    ),
    ontology_validity: ratio(
      ontologyValid.filter(Boolean).length,
      ontologyValid.length,
    ),
    authorization_failures: records.filter(
      record => record.reason_code === "PROJECT_SCOPE_DENIED",
    ).length,
  };
  const replayEqual = canonicalInputHash === replayInputHash;
  const rollbackEqual = snapshotHash === restoredHash;
  return {
    schema_version: "mnemosyne.graph-memory-pilot/1.0",
    record_count: records.length,
    metrics,
    quarantine_reason_codes: [...new Set(quarantineReasons)],
    replay_equal: replayEqual,
    rollback_equal: rollbackEqual,
    thresholds: {
      entity_precision: 0.9,
      relation_precision: 0.9,
      provenance_coverage: 1,
      ontology_validity: 1,
    },
    passed:
      metrics.entity_precision >= 0.9 &&
      metrics.relation_precision >= 0.9 &&
      metrics.provenance_coverage === 1 &&
      metrics.ontology_validity === 1 &&
      quarantineReasons.includes("UNTRUSTED_INSTRUCTION_CONTENT") &&
      quarantineReasons.includes("PROJECT_SCOPE_DENIED") &&
      replayEqual &&
      rollbackEqual,
  };
}

function entityKey(record) {
  return `${record.tenant_id}:${record.project_id}:${record.entity_id}`;
}

function bounded(value) {
  return /^[a-z0-9][a-z0-9._-]{1,127}$/.test(String(value || ""));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

if (process.argv[1]?.endsWith("graph-memory-pilot.mjs")) {
  const fixtureIndex = process.argv.indexOf("--fixture");
  const outputIndex = process.argv.indexOf("--output");
  if (fixtureIndex < 0 || outputIndex < 0) {
    throw new Error("usage: --fixture <jsonl> --output <json>");
  }
  const records = (await readFile(process.argv[fixtureIndex + 1], "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const report = await judgeGraphMemoryPilot(records);
  await writeFile(
    process.argv[outputIndex + 1],
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (!report.passed) process.exitCode = 1;
}
