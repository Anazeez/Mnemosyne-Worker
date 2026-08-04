#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildProjectionOperation(argv) {
  const values = [...argv];
  const command = values[0]?.startsWith("--") ? "plan" : values.shift() || "plan";
  if (!["plan", "upsert", "verify", "remove-version"].includes(command)) {
    throw new Error("VISUAL_SKILL_COMMAND_INVALID");
  }
  const options = parseOptions(values);
  const manifestPath = resolve(required(options, "manifest"));
  const recordsPath = resolve(options.get("records") || join(dirname(manifestPath), "projection-records.jsonl"));
  return {
    command,
    manifest_path: manifestPath,
    records_path: recordsPath,
    expected_catalog_version: required(options, "expected-catalog-version"),
    expected_installed_skill_hash: required(options, "expected-installed-skill-hash"),
    environment: required(options, "environment"),
    apply: options.has("apply"),
  };
}

export async function executeProjectionOperation(operation, {
  baseUrl = process.env.MNEMOSYNE_ADMIN_URL,
  adminKey = process.env.MATRIX_AUTH_KEY,
  fetchImpl = fetch,
} = {}) {
  const [manifest, recordText] = await Promise.all([
    readFile(operation.manifest_path, "utf8").then(JSON.parse),
    readFile(operation.records_path, "utf8"),
  ]);
  const records = recordText.split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  if (!baseUrl) throw new Error("VISUAL_SKILL_ADMIN_URL_REQUIRED");
  if (!adminKey || adminKey.length < 20) throw new Error("VISUAL_SKILL_ADMIN_KEY_REQUIRED");
  const response = await fetchImpl(new URL("/internal/admin/visual-skills/projection", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Matrix-Key": adminKey,
    },
    body: JSON.stringify({
      command: operation.command,
      records,
      manifest,
      expected_catalog_version: operation.expected_catalog_version,
      expected_installed_skill_hash: operation.expected_installed_skill_hash,
      environment: operation.environment,
      apply: operation.apply,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || ("VISUAL_SKILL_OPERATION_FAILED:" + response.status));
  }
  return result;
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error("VISUAL_SKILL_ARGUMENT_INVALID");
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) options.set(key, true);
    else {
      options.set(key, next);
      index += 1;
    }
  }
  return options;
}

function required(options, key) {
  const value = String(options.get(key) ?? "").trim();
  if (!value) {
    throw new Error("VISUAL_SKILL_" + key.toUpperCase().replaceAll("-", "_") + "_REQUIRED");
  }
  return value;
}

async function main() {
  const operation = buildProjectionOperation(process.argv.slice(2));
  const result = await executeProjectionOperation(operation);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
