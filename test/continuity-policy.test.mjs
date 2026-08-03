import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  scopedEnvironment
} from "./helpers/worker-harness.mjs";

const EXPECTED_CONTINUITY_GRANTS = Object.freeze({
  root: [
    "continuity.read",
    "continuity.write",
    "continuity.publish",
    "continuity.invalidate",
    "continuity.audit"
  ],
  orchestrator: [
    "continuity.read",
    "continuity.write",
    "continuity.publish",
    "continuity.audit"
  ],
  specialist: ["continuity.read", "continuity.write"],
  portal: ["continuity.read"],
  dashboard: [],
  inspector: ["continuity.read", "continuity.audit"]
});

async function registryRoles() {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/registry", {
      headers: { "X-Matrix-Key": "root-key" }
    }),
    { MATRIX_AUTH_KEY: "root-key" }
  );

  assert.equal(response.status, 200);
  return new Map((await response.json()).roles.map(role => [role.principal_id, role]));
}

test("continuity capabilities are explicit per role and never inherited from memory search", async () => {
  const roles = await registryRoles();

  for (const [roleId, expected] of Object.entries(EXPECTED_CONTINUITY_GRANTS)) {
    const actual = roles.get(roleId).capabilities.filter(capability =>
      capability.startsWith("continuity.")
    );
    assert.deepEqual(actual, expected, roleId);
  }

  assert.equal(roles.get("portal").capabilities.includes("memory.search"), true);
  assert.equal(roles.get("portal").capabilities.includes("continuity.write"), false);
  assert.equal(roles.get("dashboard").capabilities.includes("continuity.write"), false);
});

test("specialist credentials expose only server-bound normalized project scopes", async () => {
  const worker = await loadWorker();
  const absent = await worker.fetch(
    authenticatedRequest("/v1/memory/self"),
    scopedEnvironment("specialist")
  );
  const explicit = await worker.fetch(
    authenticatedRequest("/v1/memory/self"),
    scopedEnvironment("specialist", {
      MATRIX_PRINCIPAL_KEYS: {
        "test-key": {
          credential_id: "ariadne",
          principal_id: "specialist",
          project_ids: [" Project-Infinitum ", "invalid/project", "project-infinitum"]
        }
      }
    })
  );

  assert.equal(absent.status, 200);
  assert.deepEqual((await absent.json()).project_ids, ["project-infinitum"]);
  assert.equal(explicit.status, 200);
  assert.deepEqual((await explicit.json()).project_ids, ["project-infinitum"]);
});

test("root bootstrap scope is explicit and does not depend on credential metadata", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/memory/self", {
      headers: { "X-Matrix-Key": "root-key" }
    }),
    { MATRIX_AUTH_KEY: "root-key" }
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).project_ids, ["*"]);
});
