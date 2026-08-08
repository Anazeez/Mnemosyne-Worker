# MCP and Shadow-Delta Handoff Slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose the approved handoff save-file boundary through MCP while keeping local draft recovery separate from accepted memory.

**Architecture:** `mcp.readResource` reads the latest scope-authorized accepted handoff package. `mcp.callTool` with `handoff.propose` validates a complete `handoff.v1` local draft and returns a deterministic pending-confirmation receipt; it does not write D1 or accept memory. A local shadow-delta adapter maintains a bounded hash chain and can compile its last complete checkpoint into a new handoff draft after interruption.

**Constraints:** Preserve tenant/project authorization, never persist raw conversation or secrets, keep approval human-controlled, do not enable deployment, remote migration, commit, push, or accepted-memory writes.

## Task 1: Add the local shadow-delta adapter

**Files:**
- Create `src/handoff/shadow.js`
- Create `test/handoff-shadow.test.mjs`

- [x] Define and validate `shadow_delta.v1` with bounded sequence, parent revision, changed fields, designated files, verification deltas, checkpoint state, timestamp, and previous hash.
- [x] Hash each normalized delta without its derived hash and enforce contiguous sequence plus hash-chain continuity when appending.
- [x] Keep the log client-local and bounded; never call D1 or an accepted-memory service.
- [x] Compile the last complete checkpoint against a required validated base envelope into a new interruption handoff draft with a deterministic ID and idempotency key.
- [x] Test chain integrity, partial-tail recovery, secret/instruction rejection, and no-acceptance behavior.

## Task 2: Add the MCP handoff resource and proposal boundary

**Files:**
- Create `src/handoff/mcp.js`
- Modify `src/mcp.js`
- Modify `src/graph-memory/flags.js`
- Create `test/handoff-mcp-boundary.test.mjs`
- Modify `test/mcp.test.mjs`

- [x] Read `mnemosyne://{tenant_id}/{project_id}/handoff/latest` through the existing accepted-memory capability and return the bounded latest epoch/snapshot, active handoff, generation, lineage, truncation, and conflicts package.
- [x] Register `handoff.propose` with a strict target plus `local_draft` schema; normalize and hash it, enforce scope, and return `pending_confirmation` without D1 mutation.
- [x] Gate resource reads with `GRAPH_MEMORY_READ_ENABLED` and proposals with `GRAPH_MEMORY_PROPOSE_ENABLED` while preserving the existing five memory tools.
- [x] Test authorization, scope mismatch, deterministic proposal receipts, accepted-resource rehydration, and empty-scope behavior.

## Task 3: Verify the slice without production effects

**Files:**
- Verify all files changed by Tasks 1–2.

- [x] Run focused shadow and handoff-boundary tests: 25 passed, including lineage regression coverage.
- [x] Run MCP tests with the exact declared SDK in a temporary ignored dependency overlay: 9 passed; repository `npm`/`corepack` remain unavailable.
- [x] Run `node --check` for changed JavaScript and `git diff --check`.
- [x] Inspect the complete diff for approval gating, no direct accepted write, scope isolation, bounded payloads, and no route/flag enablement.
