import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const continuityMigration = new URL(
  "../migrations/002_contextual_continuity.sql",
  import.meta.url
);
const graphMigration = new URL(
  "../migrations/003_graph_memory.sql",
  import.meta.url
);
const goldenFixture = new URL(
  "../migrations/fixtures/graph-memory-golden.jsonl",
  import.meta.url
);

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(continuityMigration, "utf8"));
  seedLegacyContinuity(db);
  db.exec(await readFile(graphMigration, "utf8"));
  return db;
}

function seedLegacyContinuity(db) {
  db.prepare(`
    INSERT INTO context_runways (
      runway_id, schema_version, identity_id, project_id, scope_key,
      generation, state, context_status, summary, payload_json,
      manifest_hash, source_hashes_json, integrity_state,
      created_by_credential_id, idempotency_key, indexing_state,
      created_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-runway", "mnemosyne.context-runway/1.0", "ariadne", "shared",
    "project", 1, "published", "current", "legacy", "{}",
    "a".repeat(64), "[]", "verified", "ariadne", "legacy-key",
    "complete", "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"
  );
  db.prepare(`
    INSERT INTO context_runway_heads (
      identity_id, project_id, scope_key, runway_id, generation,
      manifest_hash, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ariadne", "shared", "project", "legacy-runway", 1,
    "a".repeat(64), "2026-07-15T00:00:00.000Z"
  );
}

function insertRunway(db, tenantId, runwayId) {
  db.prepare(`
    INSERT INTO context_runways (
      runway_id, tenant_id, schema_version, identity_id, project_id,
      scope_key, generation, state, context_status, summary, payload_json,
      manifest_hash, source_hashes_json, integrity_state,
      created_by_credential_id, idempotency_key, indexing_state,
      created_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runwayId, tenantId, "mnemosyne.context-runway/1.0", "assistant", "shared",
    "project", 1, "published", "current", tenantId, "{}",
    tenantId.padEnd(64, "a").slice(0, 64), "[]", "verified",
    `${tenantId}-credential`, `${tenantId}-key`, "complete",
    "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"
  );
  db.prepare(`
    INSERT INTO context_runway_heads (
      tenant_id, identity_id, project_id, scope_key, runway_id, generation,
      manifest_hash, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId, "assistant", "shared", "project", runwayId, 1,
    tenantId.padEnd(64, "a").slice(0, 64), "2026-07-27T00:00:00.000Z"
  );
}

test("migration backfills every legacy continuity scope to personal", async () => {
  const db = await migratedDatabase();
  const runway = db.prepare(
    "SELECT tenant_id FROM context_runways WHERE runway_id = ?"
  ).get("legacy-runway");
  const head = db.prepare(
    "SELECT tenant_id FROM context_runway_heads WHERE runway_id = ?"
  ).get("legacy-runway");

  assert.equal(runway.tenant_id, "personal");
  assert.equal(head.tenant_id, "personal");

  for (const table of [
    "context_runways",
    "context_runway_heads",
    "context_runway_records",
    "context_runway_validations",
    "context_retrieval_receipts",
    "context_publication_attempts",
    "context_runway_invalidations",
    "context_invocations"
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    assert.equal(
      columns.some(column => column.name === "tenant_id"),
      true,
      `${table} must include tenant_id`
    );
  }
});

test("continuity heads with identical project scopes remain tenant isolated", async () => {
  const db = await migratedDatabase();
  insertRunway(db, "tenant-a", "tenant-a-runway");
  insertRunway(db, "tenant-b", "tenant-b-runway");

  const rows = db.prepare(`
    SELECT tenant_id, runway_id
      FROM context_runway_heads
     WHERE identity_id = 'assistant'
       AND project_id = 'shared'
       AND scope_key = 'project'
     ORDER BY tenant_id
  `).all().map(row => ({ ...row }));

  assert.deepEqual(rows, [
    { tenant_id: "tenant-a", runway_id: "tenant-a-runway" },
    { tenant_id: "tenant-b", runway_id: "tenant-b-runway" }
  ]);
});

test("candidate idempotency is tenant credential key and payload bound", async () => {
  const db = await migratedDatabase();
  const insert = db.prepare(`
    INSERT INTO memory_candidates (
      candidate_id, tenant_id, project_id, submitted_by_credential_id,
      idempotency_key, payload_json, payload_hash, confidence, state,
      submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    "candidate-a", "tenant-a", "shared", "portal-a", "proposal-001",
    "{}", "a".repeat(64), 0.9, "pending_validation",
    "2026-07-27T00:00:00.000Z"
  );

  assert.throws(
    () => insert.run(
      "candidate-b", "tenant-a", "shared", "portal-a", "proposal-001",
      "{}", "b".repeat(64), 0.9, "pending_validation",
      "2026-07-27T00:00:01.000Z"
    ),
    /UNIQUE constraint failed/
  );
});

test("accepted assertions require linked evidence and decision", async () => {
  const db = await migratedDatabase();
  db.prepare(`
    INSERT INTO memory_entities (
      entity_id, tenant_id, project_id, ontology_type, lifecycle_state,
      canonical_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "entity-a", "tenant-a", "shared", "project", "candidate", "Entity A",
    "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"
  );
  db.prepare(`
    INSERT INTO memory_assertions (
      assertion_id, tenant_id, project_id, subject_entity_id, predicate,
      object_json, confidence, lifecycle_state, valid_from, observed_at,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "assertion-a", "tenant-a", "shared", "entity-a", "status", "\"active\"",
    0.95, "candidate", "2026-07-27T00:00:00.000Z",
    "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"
  );

  assert.throws(
    () => db.prepare(`
      UPDATE memory_assertions
         SET lifecycle_state = 'accepted'
       WHERE assertion_id = 'assertion-a'
    `).run(),
    /accepted assertion requires evidence and decision/
  );
});

test("golden pilot fixture is representative and bounded", async () => {
  const rows = (await readFile(goldenFixture, "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const kinds = new Set(rows.map(row => row.kind));

  assert.equal(rows.length >= 10 && rows.length <= 50, true);
  for (const kind of [
    "entity",
    "relation",
    "assertion",
    "candidate",
    "quarantine"
  ]) {
    assert.equal(kinds.has(kind), true, `missing fixture kind: ${kind}`);
  }
  assert.equal(new Set(rows.map(row => row.tenant_id)).size >= 2, true);
  assert.equal(rows.some(row => row.temporal_conflict === true), true);
  assert.equal(
    rows.some(row => row.reason_code === "UNTRUSTED_INSTRUCTION_CONTENT"),
    true
  );
});
