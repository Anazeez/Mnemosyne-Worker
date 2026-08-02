#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { hashLegacyKey } from "../src/auth/legacy-credentials.js";

export async function buildLegacyCredentialSql(records, { pepper, createdAt }) {
  if (!Array.isArray(records)) throw new Error("LEGACY_INPUT_INVALID");
  const batches = [];
  for (const record of records) {
    const credentialId = String(record?.credential_id ?? "").trim();
    const principalId = String(record?.principal_id ?? "").trim();
    const rawKey = String(record?.key ?? record?.action_key ?? "");
    if (!credentialId || !principalId || rawKey.length < 20) {
      throw new Error(`LEGACY_RECORD_INVALID:${credentialId || "unknown"}`);
    }
    batches.push({
      sql: "INSERT INTO legacy_credentials (credential_id, principal_id, key_hash, active, created_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)",
      params: [
        credentialId,
        principalId,
        await hashLegacyKey(rawKey, pepper),
        createdAt,
        record.expires_at ?? null,
      ],
    });
  }
  return `${JSON.stringify({
    schema_version: "legacy-credential-hmac-batch-v1",
    batches,
  }, null, 2)}\n`;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const inputPath = argument("--input");
  const pepperPath = argument("--pepper-file");
  const outputPath = argument("--output");
  if (!inputPath || !pepperPath || !outputPath || outputPath === "-") {
    console.error("Usage: node scripts/migrate-legacy-credentials.mjs --input FILE --pepper-file FILE --output FILE");
    process.exitCode = 2;
  } else {
    try {
      const records = JSON.parse(await readFile(resolve(inputPath), "utf8"));
      const pepper = (await readFile(resolve(pepperPath), "utf8")).trim();
      const output = await buildLegacyCredentialSql(records, {
        pepper,
        createdAt: new Date().toISOString(),
      });
      await writeFile(resolve(outputPath), output, { encoding: "utf8", mode: 0o600 });
      console.log(`wrote ${records.length} hashed credential batches to ${resolve(outputPath)}`);
    } catch (error) {
      console.error(error.message ?? String(error));
      process.exitCode = 1;
    }
  }
}
