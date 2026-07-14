import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  scopedEnvironment
} from "./helpers/worker-harness.mjs";

function recordingDatabase() {
  const statements = [];
  const counts = [4, 3];

  return {
    statements,
    prepare(sql) {
      statements.push(sql.trim());
      const index = statements.length - 1;
      return {
        bind() {
          return this;
        },
        async first() {
          return { count: counts[index] };
        }
      };
    }
  };
}

test("dashboard key returns only minimized aggregate overview fields", async () => {
  const worker = await loadWorker();
  const DB = recordingDatabase();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/dashboard/overview", {
      headers: { "X-Matrix-Key": "dashboard-test-key" }
    }),
    { MATRIX_DASHBOARD_KEY: "dashboard-test-key", DB }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    pending_acknowledgements: 4,
    recent_activity_count: 3,
    attention_count: 4
  });
  assert.equal(DB.statements.length, 2);

  for (const sql of DB.statements) {
    assert.match(sql, /^SELECT\b/i);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i);
  }
});

test("dashboard overview has no mutation-capable dependency when D1 is absent", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/dashboard/overview", {
      headers: { "X-Matrix-Key": "dashboard-test-key" }
    }),
    { MATRIX_DASHBOARD_KEY: "dashboard-test-key" }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    pending_acknowledgements: 0,
    recent_activity_count: 0,
    attention_count: 0
  });
});

test("missing dashboard authentication returns 401", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/dashboard/overview"),
    {}
  );

  assert.equal(response.status, 401);
});

test("a scoped role without dashboard capability receives structured 403", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    authenticatedRequest("/v1/dashboard/overview"),
    scopedEnvironment("portal")
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Role lacks capability: dashboard.overview");
});
