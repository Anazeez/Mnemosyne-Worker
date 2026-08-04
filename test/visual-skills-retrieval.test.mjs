import assert from "node:assert/strict";
import test from "node:test";

import { retrieveVisualSkills } from "../src/visual-skills/retrieval.js";
import { projectionIdFor } from "../src/visual-skills/contracts.js";
import {
  loadWorker,
  migrateTestPrincipalEnvironment,
} from "./helpers/worker-harness.mjs";

const metadata = {
  tenant_id: "personal",
  project_id: "project-infinitum",
  domain_id: "visual-design-expression",
  authority_owner: "haava",
  consumer_id: "haava",
  source_sha256: "30a4f87a42821a21e633424ab333d6103b6a6ad911d963bd756fb9ca16ca715a",
  skill_id: "cdv-guide-audience-through-chart",
  card_sha256: "3817be65a9f26852a87bb95433f76cfd7e97c6887126c7a06a9447b1127e75cb",
  catalog_version: "2026-08-04.1",
  status: "accepted",
  source_pages: "16,136,142,148",
  citation_path: "references/storytelling.md#cdv-guide-audience-through-chart",
};

const haava = {
  tenant_id: "personal",
  credential_id: "haava",
  role: "specialist",
  specialist_id: "haava",
  project_ids: ["project-infinitum"],
  domain_ids: ["visual-design-expression"],
  identity_ids: ["haava"],
  capabilities: ["memory.search"],
};
const generalAssistant = {
  tenant_id: "personal",
  credential_id: "github-1",
  role: "portal",
  assistant_id: "oauth-0123456789abcdef0123456789abcdef",
  project_ids: ["project-infinitum"],
  domain_ids: ["visual-design-expression"],
  consumer_ids: ["general-assistant"],
  capabilities: ["memory.search"],
};

function environment(matches = [{ id: projectionIdFor("haava", metadata.skill_id), score: 0.91, metadata }]) {
  const calls = { ai: 0, query: 0, filter: null };
  return {
    calls,
    AI: {
      async run() {
        calls.ai += 1;
        return { data: [[0.1, 0.2]] };
      },
    },
    MATRIX_SKILLS: {
      async query(_vector, options) {
        calls.query += 1;
        calls.filter = options.filter;
        return { matches: structuredClone(matches) };
      },
    },
  };
}

function input(extra = {}) {
  return {
    query: "explain a chart to clinic leaders",
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    threshold: 0.65,
    ...extra,
  };
}

test("Haava retrieves a grounded visual card with her inherited consumer filter", async () => {
  const env = environment();
  const result = await retrieveVisualSkills({ env, principal: haava, input: input() });
  assert.equal(result.state, "results");
  assert.equal(result.results[0].skill_id, metadata.skill_id);
  assert.equal(result.results[0].authority_owner, "haava");
  assert.deepEqual(result.results[0].source_pages, [16, 136, 142, 148]);
  assert.equal(result.results[0].citation, metadata.citation_path);
  assert.deepEqual(env.calls.filter, {
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    consumer_id: "haava",
  });
});

test("approved general assistant retrieves the same card through its own scalar projection", async () => {
  const generalMetadata = { ...metadata, consumer_id: "general-assistant" };
  const env = environment([{
    id: projectionIdFor("general-assistant", metadata.skill_id),
    score: 0.91,
    metadata: generalMetadata,
  }]);
  const result = await retrieveVisualSkills({ env, principal: generalAssistant, input: input() });
  assert.equal(result.results[0].skill_id, metadata.skill_id);
  assert.equal(env.calls.filter.consumer_id, "general-assistant");
  assert.equal(result.results[0].consumer_id, undefined);
});

test("other specialists, unbound portals, and caller impersonation fail before embedding", async () => {
  const principals = [
    { ...haava, specialist_id: "synn", domain_ids: ["security-compliance-preflight"], identity_ids: ["synn"] },
    { ...generalAssistant, consumer_ids: [], domain_ids: [] },
  ];
  for (const principal of principals) {
    const env = environment();
    await assert.rejects(
      retrieveVisualSkills({ env, principal, input: input() }),
      (error) => ["VISUAL_SKILL_SCOPE_DENIED", "VISUAL_SKILL_CONSUMER_DENIED"].includes(error.code),
    );
    assert.equal(env.calls.ai, 0);
  }
  const env = environment();
  await assert.rejects(
    retrieveVisualSkills({
      env,
      principal: generalAssistant,
      input: input({ consumer_id: "haava" }),
    }),
    (error) => error.code === "VISUAL_SKILL_CONSUMER_DENIED",
  );
  assert.equal(env.calls.ai, 0);
});

test("cross-project and cross-domain requests fail before embedding", async () => {
  for (const changed of [
    { project_id: "other-project" },
    { domain_id: "software-formal-logic" },
  ]) {
    const env = environment();
    await assert.rejects(
      retrieveVisualSkills({ env, principal: generalAssistant, input: input(changed) }),
      (error) => error.code === "VISUAL_SKILL_SCOPE_DENIED",
    );
    assert.equal(env.calls.ai, 0);
  }
});

test("empty, below-threshold, and unavailable retrieval states stay distinct", async () => {
  const empty = await retrieveVisualSkills({
    env: environment([]),
    principal: haava,
    input: input(),
  });
  assert.equal(empty.state, "empty");
  assert.equal(empty.results.length, 0);

  const below = await retrieveVisualSkills({
    env: environment([{
      id: projectionIdFor("haava", metadata.skill_id),
      score: 0.51,
      metadata,
    }]),
    principal: haava,
    input: input({ threshold: 0.8 }),
  });
  assert.equal(below.state, "below-threshold");
  assert.equal(below.results.length, 0);

  const env = environment();
  env.MATRIX_SKILLS.query = async () => { throw new Error("index offline"); };
  const unavailable = await retrieveVisualSkills({ env, principal: haava, input: input() });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.verification, "unavailable");
  assert.equal(unavailable.results.length, 0);
});

test("tampered provenance metadata is discarded even when Vectorize returns it", async () => {
  const env = environment([{
    id: projectionIdFor("haava", metadata.skill_id),
    score: 0.99,
    metadata: {
      ...metadata,
      card_sha256: "bad",
      source_pages: "not-pages",
      citation_path: "foreign",
    },
  }]);
  const result = await retrieveVisualSkills({ env, principal: haava, input: input() });
  assert.equal(result.state, "empty");
  assert.deepEqual(result.results, []);
});

test("legacy Haava skills route uses the visual contract and returns bounded provenance", async () => {
  const worker = await loadWorker();
  const env = migrateTestPrincipalEnvironment({
    MATRIX_PRINCIPAL_KEYS: {
      "haava-key-with-enough-entropy": {
        credential_id: "haava",
        principal_id: "specialist",
        project_ids: ["project-infinitum"],
      },
    },
    ...environment(),
  });
  const response = await worker.fetch(new Request("https://worker.invalid/v1/skills/retrieval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": "haava-key-with-enough-entropy",
    },
    body: JSON.stringify(input()),
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "results");
  assert.equal(body.results[0].skill_id, metadata.skill_id);
  assert.equal(body.results[0].consumer_id, undefined);
});

test("legacy non-Haava visual request is denied before embedding", async () => {
  const worker = await loadWorker();
  let embeddingCalls = 0;
  const env = migrateTestPrincipalEnvironment({
    MATRIX_PRINCIPAL_KEYS: {
      "synn-key-with-enough-entropy": {
        credential_id: "synn",
        principal_id: "specialist",
        project_ids: ["project-infinitum"],
      },
    },
    AI: { async run() { embeddingCalls += 1; return { data: [[0.1]] }; } },
    MATRIX_SKILLS: { async query() { return { matches: [] }; } },
  });
  const response = await worker.fetch(new Request("https://worker.invalid/v1/skills/retrieval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": "synn-key-with-enough-entropy",
    },
    body: JSON.stringify(input()),
  }), env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "VISUAL_SKILL_CONSUMER_DENIED");
  assert.equal(embeddingCalls, 0);
});
