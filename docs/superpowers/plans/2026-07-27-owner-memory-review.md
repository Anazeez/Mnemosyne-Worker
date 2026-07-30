# Owner Memory Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-only review receipt gate that cannot publish accepted memory.

**Architecture:** A new append-only D1 receipt records one owner decision per resolved candidate. A two-step GitHub-authenticated browser flow displays exact review evidence, then consumes a one-time CSRF-bound decision token.

**Tech Stack:** Cloudflare Worker, D1/SQLite, GitHub OAuth, Node test runner.

## Global Constraints

- `approve_for_commit` does not publish or change accepted generation.
- Existing internal review and publication flags remain hardcoded `0`.
- Public MCP, Actions, and OAuth clients receive no new capability.
- Owner review requires a successful resolution receipt.

---

### Task 1: Review domain and receipt

**Files:**
- Create: `migrations/008_owner_memory_review_receipts.sql`
- Create: `src/graph-memory/owner-review.js`
- Modify: `test/helpers/d1-graph-memory.mjs`
- Modify: `test/graph-memory-migration.test.mjs`
- Create: `test/graph-memory-owner-review.test.mjs`

**Interfaces:**
- Produces: `getOwnerReviewCandidate(...)`
- Produces: `reviewMemoryCandidate(...)`

- [ ] Write failing tests for review detail, approval, rejection, quarantine, replay, missing resolution, authorization, and zero accepted writes.
- [ ] Run the focused tests and confirm failure for the missing review API.
- [ ] Implement the append-only migration and minimal review domain.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Owner browser flow and rollout

**Files:**
- Modify: `src/oauth.js`
- Modify: `src/graph-memory/flags.js`
- Modify: `scripts/cloudflare-binding-preflight.mjs`
- Modify: `.github/workflows/production-deploy.yml`
- Modify: `test/oauth.test.mjs`
- Modify: `test/graph-memory-flags.test.mjs`
- Modify: `test/cloudflare-binding-preflight.test.mjs`
- Modify: `docs/graph-memory-operations.md`

**Interfaces:**
- Consumes: `GET|POST /owner/memory/candidates/:candidate_id/review`
- Produces: exact evidence review page and immutable decision result.

- [ ] Write failing tests for flag-off denial, owner authentication, exact display, CSRF decision binding, and no publication.
- [ ] Run focused tests and confirm failure for the missing route and flag.
- [ ] Implement the owner-only two-step decision flow and independent flag.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Verify and release

**Files:**
- Verify all modified files.

**Interfaces:**
- Produces: deployed owner review gate with controlled commit still disabled.

- [ ] Run `npm test`, syntax checks, migration tests, and `git diff --check`.
- [ ] Commit and push to the existing pull-request branch.
- [ ] Deploy with owner review enabled and review/publication disabled.
- [ ] Verify live flags, owner page, anonymous denial, and accepted generation `0`.
