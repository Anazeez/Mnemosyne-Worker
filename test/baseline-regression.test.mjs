import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadWorker, scopedEnvironment } from "./helpers/load-worker.mjs";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/worker-baseline.json", import.meta.url),
  "utf8"
));

test("effective role capabilities and denials match the approved baseline", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://worker.invalid/v1/registry", {
      headers: { "X-Matrix-Key": "test-key" }
    }),
    scopedEnvironment("inspector")
  );

  assert.equal(response.status, 200);
  const registry = await response.json();
  assert.deepEqual(registry.roles, fixture.roles);

  const byRole = Object.fromEntries(
    registry.roles.map(role => [role.principal_id, role.capabilities])
  );

  assert.equal(byRole.specialist.includes(fixture.ariadne_capability), true);
  assert.equal(byRole.orchestrator.includes(fixture.ariadne_capability), true);
  assert.equal(byRole.portal.includes(fixture.ariadne_capability), false);
  assert.equal(byRole.dashboard.includes(fixture.ariadne_capability), false);
  assert.equal(byRole.inspector.includes(fixture.ariadne_capability), false);
});

test("every route present at the approved baseline remains represented", async () => {
  const source = await readFile(
    new URL("../src/index.js", import.meta.url),
    "utf8"
  );

  for (const [method, route] of fixture.routes) {
    const staticPath = route.replace(/:\w+/g, "");
    const pathFragments = staticPath.split("/").filter(Boolean);

    assert.match(source, new RegExp(`method\\s*===\\s*["']${method}["']`));
    for (const fragment of pathFragments) {
      assert.equal(
        source.includes(fragment),
        true,
        `${method} ${route} lost path fragment ${fragment}`
      );
    }
  }
});
