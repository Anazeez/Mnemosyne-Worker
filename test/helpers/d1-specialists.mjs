import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { GraphMemoryD1 } from "./d1-graph-memory.mjs";

const specialistMigration = new URL(
  "../../migrations/010_specialist_enforcement.sql",
  import.meta.url,
);

export class SpecialistD1 extends GraphMemoryD1 {
  async exec(sql) {
    this.database.exec(sql);
  }

  async hasTable(name) {
    const row = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
    return row?.name === name;
  }
}

export async function migratedSpecialistEnvironment(overrides = {}) {
  return {
    DB: new SpecialistD1(new DatabaseSync(":memory:")),
    ...overrides,
  };
}

export async function applySpecialistMigration(db) {
  const sql = await readFile(specialistMigration, "utf8");
  if (typeof db.exec === "function") await db.exec(sql);
  else db.database.exec(sql);
}
