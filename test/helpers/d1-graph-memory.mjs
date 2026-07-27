import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const continuityMigration = new URL(
  "../../migrations/002_contextual_continuity.sql",
  import.meta.url
);
const graphMigration = new URL(
  "../../migrations/003_graph_memory.sql",
  import.meta.url
);
const privateGrantMigration = new URL(
  "../../migrations/004_private_memory_grants.sql",
  import.meta.url
);
const hybridRetrievalMigration = new URL(
  "../../migrations/005_hybrid_retrieval.sql",
  import.meta.url
);
const humanReviewMigration = new URL(
  "../../migrations/006_human_review.sql",
  import.meta.url
);
const memoryResolutionMigration = new URL(
  "../../migrations/007_memory_resolution_receipts.sql",
  import.meta.url
);

export async function migratedGraphMemoryEnvironment(overrides = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(continuityMigration, "utf8"));
  database.exec(await readFile(graphMigration, "utf8"));
  database.exec(await readFile(privateGrantMigration, "utf8"));
  database.exec(await readFile(hybridRetrievalMigration, "utf8"));
  database.exec(await readFile(humanReviewMigration, "utf8"));
  database.exec(await readFile(memoryResolutionMigration, "utf8"));
  return {
    DB: new GraphMemoryD1(database),
    ...overrides
  };
}

export class GraphMemoryD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new GraphMemoryStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async count(table, where = "1 = 1") {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`
    ).get();
    return Number(row.count);
  }
}

class GraphMemoryStatement {
  constructor(database, sql) {
    this.statement = database.prepare(sql);
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.statement.get(...this.values) || null;
  }

  async all() {
    return { results: this.statement.all(...this.values) };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }
}
