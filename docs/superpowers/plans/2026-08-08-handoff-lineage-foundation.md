# Handoff Lineage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first production-safe Mnemosyne save-file slice: a validated `handoff.v1` envelope, scoped D1 handoff storage, DAG lineage closure, and an approval-gated acceptance primitive.

**Architecture:** Handoff payloads are stored as immutable, scope-bound records. Direct `handoff_edges` are authoritative; `handoff_lineage` is a rebuildable, transactionally refreshed closure projection with canonical shortest-path metadata. The data layer can create candidates and can accept one only with a verified approval receipt; no public MCP or remote D1 write is enabled in this slice.

**Tech Stack:** Cloudflare Worker JavaScript, D1/SQLite forward-only migrations, Node `node:test`, Node `node:sqlite`, Web Crypto SHA-256.

## Global Constraints

- Use migration `010_handoff_lineage.sql`; do not rewrite or delete earlier migrations.
- Every handoff relationship is keyed by `(tenant_id, project_id)` and references the composite handoff identity.
- `handoff_id` is the newer/child node; `related_handoff_id` is its prior parent or superseded node.
- Direct edges remain authoritative; closure rows are derived and rebuildable.
- Self-edges and cycles fail closed with stable lineage error codes.
- Accepted history is preserved with `ON DELETE RESTRICT`; no cascade deletion is introduced.
- `pending_confirmation` and `local_draft` remain client-local; D1 stores only governed candidates and accepted history.
- No public MCP write, production deployment, remote migration, accepted-memory write, commit, or push is performed by this plan.
- Verification must report `passed`, `failed`, `skipped`, or `unavailable` with evidence.

---

### Task 1: Add the forward-only D1 handoff and lineage schema

**Files:**
- Create: `migrations/010_handoff_lineage.sql`
- Modify: `test/helpers/d1-graph-memory.mjs`
- Modify: `test/graph-memory-migration.test.mjs`

**Interfaces:**
- Produces tables `handoffs`, `handoff_edges`, and `handoff_lineage`.
- Produces scoped indexes for edge lookup and ancestor/descendant traversal.
- Produces stable SQLite errors `HANDOFF_LINEAGE_SELF_EDGE` and `HANDOFF_LINEAGE_CYCLE`.

- [x] Write migration contract tests that load migration 010 after migrations 002–009 and assert the three tables, composite primary keys, `ON DELETE RESTRICT`, state checks, path metadata, and scoped indexes.
- [x] Add a direct-edge trigger test that rejects `handoff_id = related_handoff_id` and a recursive-cycle test that rejects a proposed edge when the child already reaches the proposed parent.
- [x] Run `node --test test/graph-memory-migration.test.mjs` and confirm the new assertions fail because migration 010 is absent.
- [x] Add `migrations/010_handoff_lineage.sql` with a parent `handoffs` table containing `handoff.v1` metadata, state, generation, compaction level, retention fields, payload hash, approval receipt fields, and immutable payload columns.
- [x] Add `handoff_edges` with composite tenant/project foreign keys, relation-type and self-edge checks, append-only delete protection, and the recursive cycle trigger.
- [x] Add `handoff_lineage` with self rows, non-negative depth, canonical path hash, path count, composite foreign keys, `ON DELETE RESTRICT`, and the four scope-aware indexes.
- [x] Load migration 010 in `migratedGraphMemoryEnvironment` and the migration test fixture.
- [x] Re-run the migration tests and confirm the schema and trigger tests pass.

The essential schema shape is:

```sql
PRIMARY KEY (tenant_id, project_id, handoff_id)

PRIMARY KEY (
  tenant_id, project_id, handoff_id, related_handoff_id, relation_type
)

PRIMARY KEY (
  tenant_id, project_id, ancestor_handoff_id, descendant_handoff_id
)
```

### Task 2: Implement strict `handoff.v1` normalization and hashing

**Files:**
- Create: `src/handoff/contracts.js`
- Create: `test/handoff-contracts.test.mjs`

**Interfaces:**
- Produces `HANDOFF_SCHEMA` equal to `handoff.v1`.
- Produces `normalizeHandoffEnvelope(input)` returning a bounded normalized envelope or throwing `HandoffError`.
- Produces `handoffPayloadHash(envelope)` returning a lowercase SHA-256 digest.

- [x] Write failing tests for valid normalization, tenant/project scope validation, required boundary/progress/project/source fields, structured change records, reproducible verification commands, retention fields, and rejection of secret-bearing content.
- [x] Run `node --test test/handoff-contracts.test.mjs` and confirm failure because the module is absent.
- [x] Implement the validator using the existing `canonicalJson` and `sha256Hex` helpers from `src/continuity.js`.
- [x] Enforce bounded IDs, ISO timestamps, controlled boundary and compaction values, explicit completed/remaining progress, project objective and success criteria, revision-bound designated files, and `changes` records with path/operation/summary/diff reference.
- [x] Require each verification record to include `command` or `reproduction_step`, plus one of the controlled statuses `passed`, `failed`, `skipped`, or `unavailable`.
- [x] Normalize `memory.retention_class`, derive `expires_at` from `ttl_seconds` when supplied, and reject expired transient input at candidate creation.
- [x] Reuse the repository’s secret and instruction-content rejection patterns without persisting raw conversation or credentials.
- [x] Re-run the focused contract tests and confirm they pass.

### Task 3: Implement candidate persistence, approval-gated acceptance, and DAG closure rebuild

**Files:**
- Create: `src/handoff/lineage.js`
- Create: `test/handoff-lineage.test.mjs`

**Interfaces:**
- Produces `createHandoffCandidate({ env, envelope, now, randomUUID })`.
- Produces `acceptHandoffCandidate({ env, tenantId, projectId, handoffId, approval, now })`.
- Produces `getHandoffLineage({ env, tenantId, projectId, handoffId, direction })`.
- Produces `rebuildHandoffLineage({ env, tenantId, projectId })` for deterministic repair/replay.

- [x] Write failing tests for a root candidate, parent and supersedes edges, forked descendants, idempotent replay, cross-tenant rejection, self-edge rejection, cycle rejection, canonical shortest paths, alternate `path_count`, rollback traversal, missing approval, and successful approval-gated acceptance.
- [x] Run `node --test test/handoff-lineage.test.mjs` and confirm failure because the module is absent.
- [x] Implement candidate creation as one `env.DB.batch()` operation: insert the normalized handoff, insert direct edges, and replace the affected scope’s derived closure rows atomically.
- [x] Build the closure in memory from authoritative direct edges with deterministic breadth-first traversal, shortest depth, lexicographically canonical edge path, and count of all known paths.
- [x] Hash each canonical path with SHA-256 and insert self rows `(handoff_id, handoff_id, 0)` for every scoped handoff.
- [x] Treat an existing identical `handoff_id` and payload hash as an idempotent replay; reject the same ID with a different payload hash.
- [x] Require `approval.approved === true`, a bounded approving credential ID, and a valid approval receipt hash before changing `candidate` to `accepted`; record the receipt fields and acceptance timestamp.
- [x] Keep authorization ownership above this data primitive: the caller must supply a receipt already verified by the owner-controlled review path.
- [x] Implement scoped ancestor/descendant reads ordered by depth and stable IDs.
- [x] Re-run the focused lineage tests and confirm they pass.

### Task 4: Verify the vertical slice without enabling production effects

**Files:**
- Verify all files changed by Tasks 1–3.

**Interfaces:**
- Produces a local, reproducible implementation slice with no remote side effects.

- [x] Run `node --test test/graph-memory-migration.test.mjs test/handoff-contracts.test.mjs test/handoff-lineage.test.mjs` — 28 passed.
- [ ] Run `npm test` from the clean local clone — unavailable because `npm` and `corepack` are not installed; direct `node --test test/*.test.mjs` reached 228 passed and 2 baseline dependency-import failures.
- [x] Run `node --check src/handoff/contracts.js src/handoff/lineage.js`.
- [x] Run `git diff --check` and inspect the complete diff for scope isolation, approval gating, no cascade deletion, and no public route enablement.
- [x] Confirm migration 010 is visible locally but has not been applied through Wrangler or any remote D1 command.
- [x] Leave the exact next slice documented: epoch compaction and its bounded rehydration/archival tests; the follow-up is implemented in `2026-08-08-epoch-approval-slice.md`.
