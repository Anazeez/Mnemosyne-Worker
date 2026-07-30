import { pathToFileURL } from "node:url";

const DEFAULT_EXCEPTION_SECONDS = 86_400;

export function buildGrantOperation(arguments_) {
  const values = [...arguments_];
  const command = values.shift();
  if (!["approve", "revoke", "list-active"].includes(command)) {
    throw new Error("command_required");
  }
  const options = parseOptions(values);
  const dryRun = options.has("dry-run");
  const now = iso(options.get("now") || new Date().toISOString(), "now");

  if (command === "approve") {
    const permanent = options.has("permanent");
    const expiresAt = permanent
      ? null
      : iso(
        options.get("expires-at") ||
          new Date(
            Date.parse(now) + DEFAULT_EXCEPTION_SECONDS * 1000,
          ).toISOString(),
        "expires_at",
      );
    return {
      command,
      dryRun,
      input: {
        tenant_id: required(options, "tenant"),
        owner_github_id: positiveInteger(options, "owner-github-id"),
        assistant_id: required(options, "assistant"),
        project_id: required(options, "project"),
        capabilities: required(options, "capabilities")
          .split(",")
          .map(item => item.trim())
          .filter(Boolean),
        approved_by:
          options.get("actor") ||
          `owner:${positiveInteger(options, "owner-github-id")}`,
        reason: required(options, "reason"),
        idempotency_key: required(options, "idempotency-key"),
        now,
        starts_at: iso(options.get("starts-at") || now, "starts_at"),
        expires_at: expiresAt,
        permanent,
      },
    };
  }

  if (command === "revoke") {
    return {
      command,
      dryRun,
      input: {
        grant_id: required(options, "grant-id"),
        actor_id: required(options, "actor"),
        reason: required(options, "reason", "reason_required"),
        now,
      },
    };
  }

  return {
    command,
    dryRun,
    input: {
      tenant_id: required(options, "tenant"),
      owner_github_id: positiveInteger(options, "owner-github-id"),
      assistant_id: required(options, "assistant"),
      now,
    },
  };
}

export function formatGrantOperation(value) {
  return JSON.stringify({
    grant_id: value.grant_id,
    assistant_id: value.assistant_id,
    project_id: value.project_id,
    status: value.status,
    expires_at: value.expires_at ?? null,
    receipt_hash: value.current_receipt_hash,
  }, null, 2);
}

export async function executeGrantOperation(
  operation,
  {
    baseUrl = process.env.MNEMOSYNE_ADMIN_URL,
    adminKey = process.env.MATRIX_AUTH_KEY,
    fetchImpl = fetch,
  } = {},
) {
  if (operation.dryRun) {
    return {
      grant_id: null,
      assistant_id: operation.input.assistant_id || null,
      project_id: operation.input.project_id || null,
      status: "dry-run",
      expires_at: operation.input.expires_at ?? null,
      current_receipt_hash: null,
    };
  }
  if (!baseUrl) throw new Error("admin_url_required");
  if (!adminKey || adminKey.length < 20) throw new Error("admin_key_required");
  const url = new URL("/internal/admin/memory/grants", baseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Matrix-Key": adminKey,
    },
    body: JSON.stringify(operation),
  });
  if (!response.ok) {
    throw new Error(`grant_operation_failed:${response.status}`);
  }
  return response.json();
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`invalid_argument:${token}`);
    const name = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(name, true);
    } else {
      options.set(name, next);
      index += 1;
    }
  }
  return options;
}

function required(options, name, code = `${name.replaceAll("-", "_")}_required`) {
  const value = String(options.get(name) || "").trim();
  if (!value) throw new Error(code);
  return value;
}

function positiveInteger(options, name) {
  const value = Number(required(options, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name.replaceAll("-", "_")}_invalid`);
  }
  return value;
}

function iso(value, name) {
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return new Date(parsed).toISOString();
}

async function main() {
  const operation = buildGrantOperation(process.argv.slice(2));
  const result = await executeGrantOperation(operation);
  process.stdout.write(`${formatGrantOperation(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}
