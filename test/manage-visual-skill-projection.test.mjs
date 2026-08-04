import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { manageVisualSkillProjection } from "../src/visual-skills/management.js";
import { prepareVisualSkillProjection } from "../src/visual-skills/projection.js";
import {
  createOAuthDefaultHandler,
  deriveVisualSkillAdminKey,
} from "../src/oauth.js";

const card = JSON.parse(await readFile(
  new URL("fixtures/visual-skills/accepted-card.json", import.meta.url),
  "utf8",
));
const installedSkillHash = "f7f1069e200d4f22e03dd8de219dfbec897817da18bebc2a6a44c908f484e5ea";
const provenance = {
  source: { source_sha256: card.source_sha256 },
  summary: { accepted_cards: 1 },
};
const packet = await prepareVisualSkillProjection({
  cards: [card], provenance, installedSkillHash, catalogVersion: "2026-08-04.1",
});
const productionManifest = JSON.parse(await readFile(
  new URL("../artifacts/visual-skills/2026-08-04.1/projection-manifest.json", import.meta.url),
  "utf8",
));
const productionRecords = (await readFile(
  new URL("../artifacts/visual-skills/2026-08-04.1/projection-records.jsonl", import.meta.url),
  "utf8",
)).trim().split("\n").map(JSON.parse);

function bindings(seed = []) {
  const stored = new Map(seed.map((item) => [item.id, structuredClone(item)]));
  const calls = { ai: 0, upsert: 0, delete: 0 };
  return {
    calls,
    stored,
    AI: {
      async run(_model, { text }) {
        calls.ai += 1;
        return { data: text.map(() => [0.1, 0.2, 0.3]) };
      },
    },
    MATRIX_SKILLS: {
      async getByIds(ids) {
        return ids.map((id) => stored.get(id)).filter(Boolean).map((item) => structuredClone(item));
      },
      async upsert(items) {
        calls.upsert += 1;
        for (const item of items) stored.set(item.id, structuredClone(item));
        return { count: items.length };
      },
      async deleteByIds(ids) {
        calls.delete += 1;
        for (const id of ids) stored.delete(id);
        return { count: ids.length };
      },
    },
  };
}

function options(extra = {}) {
  return {
    records: packet.records,
    manifest: packet.manifest,
    expectedCatalogVersion: "2026-08-04.1",
    expectedInstalledSkillHash: installedSkillHash,
    environment: "production",
    ...extra,
  };
}

test("plan is default, read-only, and reports exact missing IDs", async () => {
  const env = bindings();
  const receipt = await manageVisualSkillProjection(options({ bindings: env }));
  assert.equal(receipt.command, "plan");
  assert.equal(receipt.verification, "passed");
  assert.equal(receipt.adds, 2);
  assert.equal(receipt.unchanged, 0);
  assert.equal(receipt.conflicts, 0);
  assert.deepEqual(receipt.ids, packet.manifest.ids);
  assert.deepEqual(env.calls, { ai: 0, upsert: 0, delete: 0 });
});

test("production packet reads Vectorize in bounded batches", async () => {
  const batches = [];
  const receipt = await manageVisualSkillProjection(options({
    records: productionRecords,
    manifest: productionManifest,
    bindings: {
      MATRIX_SKILLS: {
        async getByIds(ids) {
          assert.ok(ids.length <= 20);
          batches.push(ids);
          return [];
        },
      },
    },
  }));
  assert.equal(receipt.adds, 48);
  assert.deepEqual(batches.map((ids) => ids.length), [20, 20, 8]);
});

test("upsert embeds each unique document once and replay is a no-op", async () => {
  const env = bindings();
  const first = await manageVisualSkillProjection(options({ command: "upsert", apply: true, bindings: env }));
  assert.equal(first.verification, "passed");
  assert.equal(first.applied, 2);
  assert.equal(env.calls.ai, 1);
  assert.equal(env.calls.upsert, 1);

  const replay = await manageVisualSkillProjection(options({ command: "upsert", apply: true, bindings: env }));
  assert.equal(replay.verification, "passed");
  assert.equal(replay.applied, 0);
  assert.equal(replay.unchanged, 2);
  assert.equal(env.calls.ai, 1);
  assert.equal(env.calls.upsert, 1);
});

test("conflicting existing IDs fail closed before embedding or mutation", async () => {
  const existing = {
    id: packet.records[0].id,
    values: [9],
    metadata: { ...packet.records[0].metadata, source_sha256: "0".repeat(64) },
  };
  const env = bindings([existing]);
  await assert.rejects(
    manageVisualSkillProjection(options({ command: "upsert", apply: true, bindings: env })),
    /VISUAL_SKILL_PROJECTION_CONFLICT/u,
  );
  assert.equal(env.calls.ai, 0);
  assert.equal(env.calls.upsert, 0);
});

test("verify compares every manifest ID and all authorization metadata", async () => {
  const env = bindings(packet.records.map((record) => ({
    id: record.id,
    values: [0.1],
    metadata: structuredClone(record.metadata),
  })));
  const receipt = await manageVisualSkillProjection(options({ command: "verify", bindings: env }));
  assert.equal(receipt.verification, "passed");
  assert.equal(receipt.verified, 2);

  env.stored.get(packet.records[1].id).metadata.consumer_id = "general-assistant";
  const failed = await manageVisualSkillProjection(options({ command: "verify", bindings: env }));
  assert.equal(failed.verification, "failed");
  assert.deepEqual(failed.mismatched_ids, [packet.records[1].id]);
});

test("remove-version deletes only exact manifest IDs and requires explicit apply", async () => {
  const env = bindings(packet.records.map((record) => ({ id: record.id, values: [0.1], metadata: record.metadata })));
  await assert.rejects(
    manageVisualSkillProjection(options({ command: "remove-version", bindings: env })),
    /VISUAL_SKILL_APPLY_REQUIRED/u,
  );
  const receipt = await manageVisualSkillProjection(options({
    command: "remove-version", apply: true, bindings: env,
  }));
  assert.equal(receipt.verification, "passed");
  assert.equal(receipt.removed, 2);
  assert.equal(env.stored.size, 0);
  assert.equal(env.calls.delete, 1);
});

test("management rejects hash drift, foreign environments, broad prefixes, and undeclared records", async () => {
  const env = bindings();
  for (const changed of [
    { expectedInstalledSkillHash: "0".repeat(64) },
    { environment: "preview", command: "upsert", apply: true },
    { manifest: { ...packet.manifest, projection_prefix: "*" } },
    { records: packet.records.slice(0, 1) },
  ]) {
    await assert.rejects(
      manageVisualSkillProjection(options({ bindings: env, ...changed })),
      /VISUAL_SKILL_/u,
    );
  }
});

test("owner-protected projection endpoint applies only the exact reviewed packet", async () => {
  const env = bindings();
  env.GRANT_RESOLVER_TOKEN = "resolver-token-with-at-least-32-characters";
  env.ENVIRONMENT = "production";
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  const response = await handler.fetch(
    new Request("https://memory.example/internal/admin/visual-skills/projection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-Key": await deriveVisualSkillAdminKey(env.GRANT_RESOLVER_TOKEN),
      },
      body: JSON.stringify({
        command: "upsert",
        records: packet.records,
        manifest: packet.manifest,
        expected_catalog_version: "2026-08-04.1",
        expected_installed_skill_hash: installedSkillHash,
        environment: "production",
        apply: true,
      }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).applied, 2);
  assert.equal(env.stored.size, 2);
});

test("visual admin derivation never accepts the resolver token itself or a foreign key", async () => {
  const env = bindings();
  env.GRANT_RESOLVER_TOKEN = "resolver-token-with-at-least-32-characters";
  env.ENVIRONMENT = "production";
  const handler = createOAuthDefaultHandler({
    legacyWorker: { fetch: () => new Response("legacy") },
  });
  for (const supplied of [env.GRANT_RESOLVER_TOKEN, "0".repeat(64)]) {
    const response = await handler.fetch(
      new Request("https://memory.example/internal/admin/visual-skills/projection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Matrix-Key": supplied,
        },
        body: JSON.stringify({ command: "plan" }),
      }),
      env,
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "visual_skill_admin_denied");
  }
  assert.equal(env.calls.ai, 0);
  assert.equal(env.calls.upsert, 0);
});
