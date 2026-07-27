import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGrantOperation,
  formatGrantOperation,
} from "../scripts/manage-memory-grants.mjs";

const ASSISTANT = "oauth-0123456789abcdef0123456789abcdef";

test("approve dry-run defaults exceptional access to 24 hours", () => {
  const operation = buildGrantOperation([
    "approve",
    "--tenant", "personal",
    "--owner-github-id", "277895262",
    "--assistant", ASSISTANT,
    "--project", "project-alpha",
    "--capabilities", "memory.read,memory.search",
    "--reason", "owner approved temporary project access",
    "--idempotency-key", "grant-project-alpha",
    "--now", "2026-07-27T12:00:00.000Z",
    "--dry-run",
  ]);
  assert.equal(operation.command, "approve");
  assert.equal(operation.input.expires_at, "2026-07-28T12:00:00.000Z");
  assert.equal(operation.input.permanent, false);
  assert.equal(operation.dryRun, true);
});

test("approve requires explicit permanent and returns no expiry", () => {
  const operation = buildGrantOperation([
    "approve",
    "--tenant", "personal",
    "--owner-github-id", "277895262",
    "--assistant", ASSISTANT,
    "--project", "*",
    "--capabilities", "memory.read,memory.search",
    "--reason", "owner approved orchestrator project access",
    "--idempotency-key", "grant-orchestrator-all",
    "--now", "2026-07-27T12:00:00.000Z",
    "--permanent",
    "--dry-run",
  ]);
  assert.equal(operation.input.permanent, true);
  assert.equal(operation.input.expires_at, null);
});

test("revoke requires an explicit reason", () => {
  assert.throws(
    () => buildGrantOperation([
      "revoke",
      "--grant-id", "grant_0123456789abcdef0123456789abcdef",
      "--actor", "owner:277895262",
      "--now", "2026-07-27T12:00:00.000Z",
      "--dry-run",
    ]),
    /reason_required/,
  );
});

test("formatted grant operations never expose provider credentials", () => {
  const output = formatGrantOperation({
    grant_id: "grant_0123456789abcdef0123456789abcdef",
    assistant_id: ASSISTANT,
    project_id: "project-alpha",
    status: "active",
    expires_at: null,
    current_receipt_hash: "a".repeat(64),
    GITHUB_CLIENT_SECRET: "do-not-print",
    access_token: "do-not-print",
  });
  assert.doesNotMatch(output, /do-not-print|client_secret|access_token/i);
  assert.deepEqual(JSON.parse(output), {
    grant_id: "grant_0123456789abcdef0123456789abcdef",
    assistant_id: ASSISTANT,
    project_id: "project-alpha",
    status: "active",
    expires_at: null,
    receipt_hash: "a".repeat(64),
  });
});
