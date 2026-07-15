import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/002_contextual_continuity.sql",
  import.meta.url
);

async function migrationSource() {
  return readFile(migrationUrl, "utf8");
}

const REQUIRED_TABLES = [
  "context_runways",
  "context_runway_heads",
  "context_runway_records",
  "context_runway_validations",
  "context_retrieval_receipts",
  "context_publication_attempts",
  "context_runway_invalidations",
  "context_invocations"
];

const REQUIRED_STATES = [
  "candidate",
  "validated",
  "sealed",
  "indexing",
  "published",
  "superseded",
  "rejected",
  "quarantined",
  "invalidated",
  "publication_failed"
];

test("continuity migration defines the complete D1 persistence surface", async () => {
  const source = await migrationSource();

  for (const table of REQUIRED_TABLES) {
    assert.match(
      source,
      new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, "i"),
      `missing table: ${table}`
    );
  }

  assert.match(source, /idx_context_runways_scope_generation/i);
  assert.match(source, /idx_context_runways_published_scope_generation/i);
  assert.doesNotMatch(
    source,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_context_runways_scope_generation/i,
    "candidate successors from the same predecessor must be retained"
  );
  assert.match(
    source,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_context_runways_published_scope_generation[\s\S]+WHERE state = 'published'/i
  );
  assert.match(source, /idx_context_runways_scope_state_created/i);
  assert.match(source, /idx_context_runways_idempotency/i);
  assert.match(
    source,
    /created_by_credential_id\s*,\s*idempotency_key/i,
    "idempotency must be scoped to the creating credential"
  );
});

test("continuity migration preserves the closed state and domain vocabularies", async () => {
  const source = await migrationSource();

  for (const state of REQUIRED_STATES) {
    assert.equal(source.includes(`'${state}'`), true, `missing state: ${state}`);
  }

  for (const domain of ["knowledge", "agents", "skills", "files", "library"]) {
    assert.equal(source.includes(`'${domain}'`), true, `missing domain: ${domain}`);
  }

  assert.doesNotMatch(source, /vectorize/i);
});

test("continuity migration makes sealed content immutable and head promotion atomic", async () => {
  const source = await migrationSource();

  assert.match(source, /CREATE TRIGGER\s+context_runways_reject_sealed_content_update/i);
  assert.match(source, /RAISE\s*\(\s*ABORT\s*,\s*'sealed runway content is immutable'/i);
  assert.match(source, /CREATE TRIGGER\s+context_runway_heads_publish_insert/i);
  assert.match(source, /CREATE TRIGGER\s+context_runway_heads_publish_update/i);
  assert.match(source, /UPDATE\s+context_runways[\s\S]+state\s*=\s*'published'/i);
  assert.match(source, /UPDATE\s+context_runways[\s\S]+state\s*=\s*'superseded'/i);
});

test("continuity rollback is forward repair and never drops historical records", async () => {
  const source = await migrationSource();

  assert.doesNotMatch(source, /\bDROP\s+(?:TABLE|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(source, /ON\s+DELETE\s+CASCADE[\s\S]*context_runways/i);
});
