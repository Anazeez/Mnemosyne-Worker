#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { assistantIdForOAuthClient } from "../src/oauth.js";

export async function buildVisualConsumerOperation(argv) {
  const values = [...argv];
  const command = values[0]?.startsWith("--") ? "plan" : values.shift() || "plan";
  if (!["plan", "approve", "inspect", "revoke"].includes(command)) {
    throw new Error("VISUAL_SKILL_CONSUMER_COMMAND_INVALID");
  }
  const options = parseOptions(values);
  const clientId = required(options, "oauth-client-id");
  const assistantId = await assistantIdForOAuthClient(clientId);
  const apply = options.has("apply");
  if (["approve", "revoke"].includes(command) && !apply) {
    return {
      command: "plan",
      planned_command: command,
      apply: false,
      assistant_id: assistantId,
      consumer_id: "general-assistant",
      project_id: "project-infinitum",
      domain_id: "visual-design-expression",
      allowed_scopes: ["identity:read", "memory:read", "memory:search"],
    };
  }
  return {
    command,
    apply,
    assistant_id: assistantId,
    actor_id: options.get("actor") || "owner:architectus",
    reason: options.get("reason") || "inspect approved visual skill consumer",
    now: options.get("now") || new Date().toISOString(),
  };
}

export async function executeVisualConsumerOperation(operation, {
  baseUrl = process.env.MNEMOSYNE_ADMIN_URL,
  adminKey = process.env.MATRIX_AUTH_KEY,
  fetchImpl = fetch,
} = {}) {
  if (operation.command === "plan") return operation;
  if (!baseUrl) throw new Error("VISUAL_SKILL_ADMIN_URL_REQUIRED");
  if (!adminKey || adminKey.length < 20) throw new Error("VISUAL_SKILL_ADMIN_KEY_REQUIRED");
  const response = await fetchImpl(new URL("/internal/admin/visual-skills/consumers", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Matrix-Key": adminKey,
    },
    body: JSON.stringify(operation),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || ("VISUAL_SKILL_CONSUMER_OPERATION_FAILED:" + response.status));
  return result;
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error("VISUAL_SKILL_CONSUMER_ARGUMENT_INVALID");
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
  if (!value) throw new Error("VISUAL_SKILL_" + key.toUpperCase().replaceAll("-", "_") + "_REQUIRED");
  return value;
}

async function main() {
  const operation = await buildVisualConsumerOperation(process.argv.slice(2));
  const result = await executeVisualConsumerOperation(operation);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
