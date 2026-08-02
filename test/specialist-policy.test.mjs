import assert from "node:assert/strict";
import test from "node:test";

import {
  applySpecialistMigration,
  migratedSpecialistEnvironment,
} from "./helpers/d1-specialists.mjs";

test("specialist migration is repeatable and creates constrained tables", async () => {
  const env = await migratedSpecialistEnvironment();
  await applySpecialistMigration(env.DB);
  await applySpecialistMigration(env.DB);

  for (const table of [
    "specialist_principals",
    "specialist_assistant_bindings",
    "legacy_credentials",
    "mesh_messages",
    "security_preflights",
  ]) {
    assert.equal(await env.DB.hasTable(table), true, table);
  }
});
