# Owner Memory Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-only, candidate-specific entity-resolution gate that records an immutable receipt without accepting or publishing memory.

**Architecture:** The existing GitHub owner allowlist and one-time CSRF/OAuth flow will protect a separate `/resolve` route and a separate rollout flag. Resolution will compare each distinct candidate subject only with accepted entities in the authorized tenant and project, using normalized exact labels; no match proposes a new entity, one match records that entity, and multiple exact matches quarantine the candidate.

**Tech Stack:** Cloudflare Worker, D1/SQLite migrations, GitHub OAuth, Node test runner.

## Global Constraints

- Keep review and publication flags hardcoded off.
- Do not expose resolution through assistant OAuth scopes, MCP, or Actions.
- Never create accepted entities, assertions, or snapshots during resolution.
- Preserve immutable, tenant-scoped and project-scoped evidence.
- Use TDD and verify the deployed state remotely.

---

### Task 1: Durable deterministic resolution

**Files:**
- Create: `migrations/007_memory_resolution_receipts.sql`
- Modify: `test/helpers/d1-graph-memory.mjs`
- Modify: `test/graph-memory-migration.test.mjs`
- Modify: `test/graph-memory-review.test.mjs`
- Modify: `src/graph-memory/review.js`

**Interfaces:**
- Consumes: `resolveMemoryCandidate({ env, principal, candidateId })`
- Produces: `{ candidate_id, state, resolution_receipt_id, resolutions }`

- [ ] Write failing tests proving no-match, one exact match, duplicate exact matches, idempotent replay, immutable receipts, tenant isolation, and zero accepted-memory writes.
- [ ] Run `node --test test/graph-memory-migration.test.mjs test/graph-memory-review.test.mjs` and confirm the new assertions fail for missing behavior.
- [ ] Add an append-only resolution-receipt migration and implement normalized exact-label resolution against accepted entities only.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Owner-only browser gate and independent rollout flag

**Files:**
- Modify: `test/oauth.test.mjs`
- Modify: `test/graph-memory-flags.test.mjs`
- Modify: `test/cloudflare-binding-preflight.test.mjs`
- Modify: `src/oauth.js`
- Modify: `src/graph-memory/flags.js`
- Modify: `scripts/cloudflare-binding-preflight.mjs`
- Modify: `.github/workflows/production-deploy.yml`
- Modify: `docs/graph-memory-operations.md`

**Interfaces:**
- Consumes: `GET|POST /owner/memory/candidates/:candidate_id/resolve`
- Produces: one-time GitHub-owner-authenticated resolution response

- [ ] Write failing tests for flag-off denial, CSRF binding, immutable GitHub owner authorization, candidate target binding, and resolution-only capability.
- [ ] Run the focused OAuth, flag, and deployment tests and confirm they fail for the missing route and flag.
- [ ] Implement the separate resolution state prefix, cookie, callback, capability, flag, deployment input, and operations note.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Verify and release

**Files:**
- Verify all modified files.

**Interfaces:**
- Produces: deployed resolution-only gate with review and publication disabled.

- [ ] Run `npm test`, syntax checks for modified JavaScript, migration validation, and `git diff --check`.
- [ ] Commit and push the bounded changes to the existing pull-request branch.
- [ ] Dispatch production deployment with read, MCP, Actions, proposal, validation, resolution, and custom domain enabled while review and publication stay `0`.
- [ ] Verify the deployment run, `/ping` flags, owner resolution page, anonymous protected-route denial, and zero accepted-memory changes.
