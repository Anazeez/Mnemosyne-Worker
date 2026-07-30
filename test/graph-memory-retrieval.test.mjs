import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPH_TRAVERSAL_LIMITS,
  rehydrateAcceptedMemory,
  searchAcceptedMemory,
  traverseAcceptedMemory
} from "../src/graph-memory/retrieval.js";
import { migratedGraphMemoryEnvironment } from "./helpers/d1-graph-memory.mjs";

function portal(overrides = {}) {
  return {
    tenant_id: "tenant-a",
    credential_id: "portal-a",
    assistant_id: "chatgpt-work",
    project_ids: ["project.one"],
    identity_ids: ["assistant-a"],
    capabilities: ["memory.read", "memory.search", "continuity.read"],
    ...overrides
  };
}

async function seedAcceptedGraph(env) {
  const db = env.DB.database;
  for (const [entityId, label] of [
    ["project-one", "Project One"],
    ["decision-auth", "Scoped OAuth"],
    ["service-memory", "Mnemosyne Memory"]
  ]) {
    db.prepare(`
      INSERT INTO memory_entities (
        entity_id, tenant_id, project_id, ontology_type, lifecycle_state,
        canonical_label, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'project.one', 'entity', 'accepted', ?, ?, ?)
    `).run(
      entityId,
      label,
      "2026-07-27T00:00:00.000Z",
      "2026-07-27T00:00:00.000Z"
    );
  }
  for (const [relationId, source, type, target] of [
    ["relation-one", "project-one", "has_decision", "decision-auth"],
    ["relation-two", "decision-auth", "uses_service", "service-memory"]
  ]) {
    db.prepare(`
      INSERT INTO memory_relations (
        relation_id, tenant_id, project_id, source_entity_id, relation_type,
        target_entity_id, lifecycle_state, confidence, valid_from, created_at
      ) VALUES (?, 'tenant-a', 'project.one', ?, ?, ?, 'accepted', 0.98, ?, ?)
    `).run(
      relationId,
      source,
      type,
      target,
      "2026-07-27T00:00:00.000Z",
      "2026-07-27T00:00:00.000Z"
    );
  }
  for (const [assertionId, object, validFrom, validTo, evidenceId] of [
    ["assertion-old", "planning", "2026-07-01T00:00:00.000Z", "2026-07-30T00:00:00.000Z", "evidence-old"],
    ["assertion-new", "implementation", "2026-07-15T00:00:00.000Z", null, "evidence-new"]
  ]) {
    db.prepare(`
      INSERT INTO memory_assertions (
        assertion_id, tenant_id, project_id, subject_entity_id, predicate,
        object_json, confidence, lifecycle_state, valid_from, valid_to,
        observed_at, created_at, accepted_generation
      ) VALUES (?, 'tenant-a', 'project.one', 'project-one', 'status', ?,
        0.95, 'candidate', ?, ?, ?, ?, 2)
    `).run(
      assertionId,
      JSON.stringify(object),
      validFrom,
      validTo,
      validFrom,
      validFrom
    );
    db.prepare(`
      INSERT INTO memory_evidence (
        evidence_id, tenant_id, project_id, source_ref, content_hash,
        observed_at, producer_credential_id, authorization_labels_json,
        citation_json, created_at
      ) VALUES (?, 'tenant-a', 'project.one', ?, ?, ?, 'reviewer-a', '[]', ?, ?)
    `).run(
      evidenceId,
      `source:${evidenceId}`,
      (assertionId === "assertion-old" ? "a" : "b").repeat(64),
      validFrom,
      JSON.stringify({ source_ref: `source:${evidenceId}` }),
      validFrom
    );
    db.prepare(`
      INSERT INTO memory_assertion_evidence (
        tenant_id, project_id, assertion_id, evidence_id
      ) VALUES ('tenant-a', 'project.one', ?, ?)
    `).run(assertionId, evidenceId);
    db.prepare(`
      INSERT INTO memory_decisions (
        decision_id, tenant_id, project_id, assertion_id, decision_type,
        outcome, receipt_hash, decided_by_credential_id, created_at
      ) VALUES (?, 'tenant-a', 'project.one', ?, 'review', 'accepted', ?,
        'reviewer-a', ?)
    `).run(
      `decision-${assertionId}`,
      assertionId,
      (assertionId === "assertion-old" ? "c" : "d").repeat(64),
      validFrom
    );
    db.prepare(`
      UPDATE memory_assertions SET lifecycle_state = 'accepted'
       WHERE assertion_id = ?
    `).run(assertionId);
  }
}

test("search returns accepted evidence and material temporal conflicts", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);
  const result = await searchAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      query: "status",
      as_of: "2026-07-27T12:00:00.000Z",
      top_k: 10
    }
  });

  assert.equal(result.assertions.length, 2);
  assert.equal(result.assertions.every(item => item.state === "accepted"), true);
  assert.equal(result.assertions.every(item => item.evidence.length === 1), true);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.accepted_generation, 2);
});

test("search matches compound terms across accepted assertion fields", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);

  const result = await searchAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      query: "Project One implementation",
      top_k: 10
    }
  });

  assert.deepEqual(
    result.assertions.map(assertion => assertion.assertion_id),
    ["assertion-new"]
  );
  assert.equal(result.accepted_generation, 2);
  assert.equal(result.retrieval.lexical_used, true);
});

test("search reports project generation when no assertion matches", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);

  const result = await searchAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      query: "does not exist",
      top_k: 10
    }
  });

  assert.deepEqual(result.assertions, []);
  assert.equal(result.accepted_generation, 2);
});

test("traversal returns an authorized bounded two-hop path", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);
  const result = await traverseAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      start_entity_id: "project-one",
      max_depth: 2
    }
  });

  assert.deepEqual(result.nodes.map(node => node.entity_id), [
    "project-one",
    "decision-auth",
    "service-memory"
  ]);
  assert.equal(result.edges.length, 2);
  assert.equal(result.truncated, false);
});

test("traversal rejects excessive depth before querying", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await assert.rejects(
    traverseAcceptedMemory({
      env,
      principal: portal(),
      body: {
        tenant_id: "tenant-a",
        project_id: "project.one",
        start_entity_id: "project-one",
        max_depth: GRAPH_TRAVERSAL_LIMITS.max_depth + 1
      }
    }),
    error => error.code === "TRAVERSAL_LIMIT_EXCEEDED"
  );
});

test("rehydration records the accepted generation and selected assertions", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);
  const result = await rehydrateAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      query: "status",
      as_of: "2026-07-27T12:00:00.000Z",
      invocation_id: "memory-invocation-one"
    },
    now: () => new Date("2026-07-27T12:00:00.000Z")
  });

  assert.equal(result.accepted_generation, 2);
  assert.equal(result.assertions.length, 2);
  assert.ok(result.context_package.estimated_tokens <= 2_000);
  assert.equal(result.context_package.budget_tokens, 2_000);
  assert.equal(await env.DB.count("memory_invocations"), 1);
});

test("rehydration rejects a context budget above the hard cap", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);

  await assert.rejects(
    rehydrateAcceptedMemory({
      env,
      principal: portal(),
      body: {
        tenant_id: "tenant-a",
        project_id: "project.one",
        query: "status",
        invocation_id: "memory-invocation-over-budget",
        budget_tokens: 2_001
      }
    }),
    error => error.code === "CONTEXT_BUDGET_EXCEEDED"
  );
});

test("rehydration reports a stable receipt-write failure without leaking D1 details", async () => {
  const env = await migratedGraphMemoryEnvironment();
  await seedAcceptedGraph(env);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes("INSERT INTO memory_invocations")) return statement;
    statement.run = async () => {
      throw new Error("D1_ERROR: secret internal receipt failure");
    };
    return statement;
  };

  await assert.rejects(
    rehydrateAcceptedMemory({
      env,
      principal: portal(),
      body: {
        tenant_id: "tenant-a",
        project_id: "project.one",
        query: "status",
        invocation_id: "memory-invocation-write-failure"
      }
    }),
    error => (
      error.code === "REHYDRATE_RECEIPT_WRITE_FAILED" &&
      !error.message.includes("secret internal receipt failure")
    )
  );
});

test("cross-tenant search fails before semantic retrieval", async () => {
  let embeddingCalls = 0;
  let vectorCalls = 0;
  const env = await migratedGraphMemoryEnvironment({
    AI: {
      async run() {
        embeddingCalls += 1;
        return { data: [[0.1]] };
      }
    },
    MATRIX_KNOWLEDGE: {
      async query() {
        vectorCalls += 1;
        return { matches: [] };
      }
    }
  });
  await assert.rejects(
    searchAcceptedMemory({
      env,
      principal: portal(),
      body: {
        tenant_id: "tenant-b",
        project_id: "project.one",
        query: "status"
      }
    }),
    error => error.code === "TENANT_SCOPE_DENIED"
  );
  assert.equal(embeddingCalls, 0);
  assert.equal(vectorCalls, 0);
});

test("semantic retrieval finds an accepted paraphrase missed by lexical search", async () => {
  const env = await migratedGraphMemoryEnvironment({
    AI: {
      async run() {
        return { data: [[0.1, 0.2]] };
      }
    },
    MATRIX_KNOWLEDGE: {
      async query(vector, options) {
        assert.deepEqual(vector, [0.1, 0.2]);
        assert.deepEqual(options.filter, {
          tenant_id: "tenant-a",
          project_id: "project.one"
        });
        return {
          matches: [{
            id: "assertion:tenant-a:project.one:assertion-new",
            score: 0.91,
            metadata: { assertion_id: "assertion-new" }
          }]
        };
      }
    }
  });
  await seedAcceptedGraph(env);

  const result = await searchAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      query: "the project has moved into the building phase",
      top_k: 10
    }
  });

  assert.deepEqual(
    result.assertions.map(assertion => assertion.assertion_id),
    ["assertion-new"]
  );
  assert.equal(result.retrieval.semantic_used, true);
});

test("embedding failure degrades explicitly to authorized D1 results", async () => {
  const env = await migratedGraphMemoryEnvironment({
    AI: {
      async run() {
        throw new Error("embedding unavailable");
      }
    },
    MATRIX_KNOWLEDGE: { async query() { return { matches: [] }; } }
  });
  await seedAcceptedGraph(env);

  const result = await searchAcceptedMemory({
    env,
    principal: portal(),
    body: {
      tenant_id: "tenant-a",
      project_id: "project.one",
      query: "status",
      as_of: "2026-07-27T12:00:00.000Z",
      top_k: 10
    }
  });

  assert.equal(result.assertions.length, 2);
  assert.deepEqual(result.retrieval, {
    lexical_used: true,
    semantic_used: false,
    semantic_reason: "EMBEDDING_SERVICE_UNAVAILABLE"
  });
});
