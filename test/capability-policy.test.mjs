import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadWorker } from "./helpers/worker-harness.mjs";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/main-policy.json", import.meta.url),
  "utf8"
));

async function effectiveRoles() {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/registry", {
      headers: { "X-Matrix-Key": "root-test-key" }
    }),
    { MATRIX_AUTH_KEY: "root-test-key" }
  );

  assert.equal(response.status, 200);
  return (await response.json()).roles;
}

test("effective capability policy differs from main only by declared proposals", async () => {
  const actual = await effectiveRoles();
  const baselineByRole = new Map(fixture.roles.map(role => [role.principal_id, role]));
  const actualByRole = new Map(actual.map(role => [role.principal_id, role]));

  assert.deepEqual([...actualByRole.keys()], [
    "root", "orchestrator", "specialist", "portal", "dashboard", "inspector"
  ]);

  for (const baseline of fixture.roles) {
    const current = actualByRole.get(baseline.principal_id);
    assert.deepEqual(current.memory_domains, baseline.memory_domains);
    assert.equal(current.receives_mandates, baseline.receives_mandates);
  }

  const actualGrants = [];
  for (const [role, current] of actualByRole) {
    const baseline = baselineByRole.get(role);
    const baselineCapabilities = new Set(baseline?.capabilities || []);
    for (const capability of current.capabilities) {
      if (!baselineCapabilities.has(capability)) {
        actualGrants.push([role, capability]);
      }
    }
  }

  assert.deepEqual(actualGrants, fixture.proposed_grants);

  for (const [role, capability] of fixture.preserved_absences) {
    assert.equal(actualByRole.get(role).capabilities.includes(capability), false);
  }
  assert.equal(fixture.missing_permission_semantics, "not-an-explicit-prohibition");
});

test("every role preserves its complete main capability array", async () => {
  const actualByRole = new Map((await effectiveRoles()).map(role => [role.principal_id, role]));
  const baselineByRole = new Map(fixture.roles.map(role => [role.principal_id, role]));

  for (const [role, baseline] of baselineByRole) {
    const actual = actualByRole.get(role);
    for (const capability of baseline.capabilities) {
      assert.equal(
        actual.capabilities.includes(capability),
        true,
        `${role} lost ${capability}`
      );
    }
  }
});
