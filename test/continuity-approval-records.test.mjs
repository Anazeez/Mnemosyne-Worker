import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const relationshipIds = [
  "root-continuity-read",
  "root-continuity-write",
  "root-continuity-publish",
  "root-continuity-invalidate",
  "root-continuity-audit",
  "orchestrator-continuity-read",
  "orchestrator-continuity-write",
  "orchestrator-continuity-publish",
  "orchestrator-continuity-audit",
  "specialist-continuity-read",
  "specialist-continuity-write",
  "portal-continuity-read",
  "inspector-continuity-read",
  "inspector-continuity-audit",
];

test("every approved continuity grant has an independent scoped approval", async () => {
  const source = await readFile("docs/proposals/privileges/continuity-role-grants.yaml", "utf8");
  assert.match(source, /activation_approved: true/);
  assert.match(source, /deployment_approved: true/);
  assert.match(source, /binding_activation_approved: false/);
  assert.match(source, /automatic_backfill_publication_approved: false/);
  for (const relationshipId of relationshipIds) {
    const start = source.indexOf(`relationship_id: ${relationshipId}`);
    assert.notEqual(start, -1, relationshipId);
    const next = source.indexOf("\n  - relationship_id:", start + 1);
    const record = source.slice(start, next === -1 ? source.indexOf("\npreserved_absences:", start) : next);
    assert.match(record, new RegExp(`approval_id: approval\\.worker\\.${relationshipId.replaceAll("-", "\\-")}`));
    assert.match(record, /approval_state: approved/);
    assert.match(record, /authority_identity: architectus/);
    assert.match(record, /source_commit: 82cccaf86633abdd24f39e14a0fe96a4f2a96137/);
    assert.match(record, /approval_scope: exact-role-capability-relationship/);
  }
});
