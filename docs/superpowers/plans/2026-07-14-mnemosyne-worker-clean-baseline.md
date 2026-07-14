# Mnemosyne-Worker Clean Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the reviewable dashboard and Ariadne baseline from verified GitHub main without preserving unsafe ancestry or activating privileges.

**Architecture:** Keep the existing single-module Worker structure and add small, bounded handlers. Tests load the module directly, use scoped in-memory credentials, replace provider calls with deterministic responses, and use a recording D1 fake to prove dashboard queries are read-only.

**Tech Stack:** Cloudflare Worker JavaScript, Web Fetch API, Node.js built-in test runner, Git.

## Global Constraints

- Base commit is exactly `a60fc378665b19b23146bdd1eb4c104b38daea25`.
- Do not cherry-pick, merge, rebase, or preserve the former 18-commit ancestry.
- All new privilege relationships remain proposed and individually approval-required.
- Do not add the Ariadne logs route.
- Do not return raw provider payloads, configuration, credentials, identifiers, endpoints, or stack details.
- Do not add generated Wrangler state, local databases, caches, bundles, source maps, or archived production snapshots.
- Stop at a separate draft pull request; do not merge, deploy, activate bindings, or modify production data.

---

### Task 1: Provenance and proposal records

**Files:**
- Create: `docs/evidence/worker-evidence-map.yaml`
- Create: `docs/proposals/privileges/*.yaml`
- Create: `docs/proposals/authentication/dashboard-key-path.yaml`

**Interfaces:**
- Consumes: the verified main SHA and the authority boundary in the design.
- Produces: immutable evidence references and one-record-per-change proposals.

- [ ] Record each observed baseline assertion with repository, full commit, path, raw-byte SHA-256, acquisition time, and `classification: observed`.
- [ ] Record separate dashboard/root/Ariadne role-capability proposals with `approval_required: true`.
- [ ] Record the dashboard key path as proposed and non-active.
- [ ] Scan these files for protected identifiers and commit with `docs: add provenance-backed worker evidence map`.

### Task 2: Generated-state exclusion

**Files:**
- Create: `.gitignore`
- Test: `test/repository-integrity.test.mjs`

**Interfaces:**
- Produces: a tracked-file prohibition for `.wrangler/`, databases, bundles, maps, secrets files, and logs.

- [ ] Write a failing integrity test that rejects prohibited tracked paths and new email-like literals outside the inherited main source.
- [ ] Run `node --test test/repository-integrity.test.mjs` and confirm `.gitignore` is missing.
- [ ] Add exact ignore rules for `.wrangler/`, `node_modules/`, `.env`, `.env.*`, `.dev.vars`, `*.log`, `*.sqlite*`, and `*.map`.
- [ ] Re-run the test and commit with `chore: ignore generated wrangler state`.

### Task 3: Explicit proposed capability policy

**Files:**
- Modify: `src/index.js`
- Create: `test/helpers/worker-harness.mjs`
- Create: `test/fixtures/main-policy.json`
- Create: `test/capability-policy.test.mjs`

**Interfaces:**
- Produces: `dashboard.overview`, `ariadne.core.openai_test`, explicit root grants, and exact role-policy regression evidence.

- [ ] Write failing tests for the full main policy projection, the exact proposed diff, and unchanged portal/inspector policies.
- [ ] Add the two capability identifiers, dashboard policy, explicit root policy, and proposed orchestrator/specialist grants.
- [ ] Permit zero memory domains only for policies without memory read/search.
- [ ] Verify the exact semantic diff and commit with `feat: add proposed dashboard and ariadne capability grants`.

### Task 4: Reviewed dashboard contract

**Files:**
- Modify: `src/index.js`
- Create: `test/dashboard-overview.test.mjs`

**Interfaces:**
- Consumes: `dashboard.overview` and `MATRIX_DASHBOARD_KEY`.
- Produces: `GET /v1/dashboard/overview` returning aggregate counts only.

- [ ] Write failing tests for dashboard authentication, authorization, output minimization, and read-only SQL.
- [ ] Add the separately proposed dashboard key principal.
- [ ] Add a route guarded by `dashboard.overview` and a handler using only bounded `SELECT COUNT(*)` statements.
- [ ] Verify no query contains `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `DROP`, `ALTER`, or `CREATE` and commit with `feat: add reviewed dashboard overview contract`.

### Task 5: Ariadne intake

**Files:**
- Modify: `src/index.js`
- Create: `test/ariadne-intake.test.mjs`

**Interfaces:**
- Consumes: `ariadne.core.openai_test`, scoped authentication, and a fixed provider fetch boundary.
- Produces: `POST /api/ariadne/core/intake` with `reviewFirst: true`, `mutated: false`, and a validated proposal.

- [ ] Write failing tests for the observed consumer envelope, authentication, structured 403 denial, validation, provider failure containment, and non-mutation.
- [ ] Add the route and handler with the authorization correction included from its first clean implementation.
- [ ] Return only bounded error codes; never return provider payloads or raw model output.
- [ ] Run the focused and policy suites and commit with `feat: add ariadne intake with structured authorization`.

### Task 6: Ariadne review

**Files:**
- Modify: `src/index.js`
- Create: `test/ariadne-review.test.mjs`

**Interfaces:**
- Produces: `POST /api/ariadne/core/review` with structured authorization and a validated non-mutating review.

- [ ] Write failing tests for the review envelope, structured 403 denial, invalid input, provider containment, and `mutated: false`.
- [ ] Add the handler with authorization caught before body or provider processing.
- [ ] Validate every response field and return bounded errors only.
- [ ] Run the focused and regression suites and commit with `feat: add ariadne review with structured authorization`.

### Task 7: Minimized status

**Files:**
- Modify: `src/index.js`
- Create: `test/ariadne-status.test.mjs`

**Interfaces:**
- Produces: `GET /api/ariadne/core/status` containing only `ok`, `service`, `mode`, `intakeEnabled`, `reviewEnabled`, and `vaultMutationAllowed`.

- [ ] Write a failing exact-object test and forbidden-field assertions.
- [ ] Add structured authentication and authorization handling.
- [ ] Return no provider, model, endpoint, configuration, binding, or requestor details.
- [ ] Run tests and commit with `feat: add minimized ariadne status contract`.

### Task 8: Sanitized connectivity diagnostic

**Files:**
- Modify: `src/index.js`
- Create: `test/ariadne-diagnostic.test.mjs`

**Interfaces:**
- Produces: `GET /api/ariadne/core/openai-test` with bounded success/error codes.

- [ ] Write failing tests using secret-bearing upstream bodies and assert none can appear in responses.
- [ ] Add structured auth and a provider request with no response-body reflection.
- [ ] Map missing local configuration to `diagnostic_unavailable`, upstream rejection to `provider_unavailable`, malformed success to `provider_invalid_response`, and success to `provider_reachable`.
- [ ] Run all tests and commit with `fix: sanitize provider diagnostics`.

### Task 9: Cross-cutting evidence, documentation, and rollback

**Files:**
- Modify: `README.md`
- Create: `test/route-regression.test.mjs`
- Create: `docs/compatibility/clean-baseline-reconstruction.md`
- Create: `docs/rollback/clean-baseline-reconstruction.md`

**Interfaces:**
- Produces: the complete route inventory, review report, and reversible commit sequence.

- [ ] Assert every main route remains represented, new routes are exact, and `/api/ariadne/core/logs` is absent.
- [ ] Document proposed privilege standing, minimized contracts, exclusions, and no-deployment state.
- [ ] Run syntax, full tests, `git diff --check`, prohibited-path scans, and protected-identifier non-duplication.
- [ ] Rehearse reverse-order reverts in a disposable local clone, running syntax after every revert.
- [ ] Commit with `test: add capability route and privilege regression coverage`.

### Task 10: Draft pull request boundary

- [ ] Verify the branch merge base equals the verified main SHA and none of the 18 excluded commit IDs are ancestors.
- [ ] Verify PR #1 remains open, draft, and unchanged.
- [ ] Push only `codex/mnemosyne-worker-clean-baseline`.
- [ ] Open a separate draft PR explaining that behavior was reconstructed from main without unsafe ancestry.
- [ ] Verify the new PR is open and draft; stop without merge, deployment, activation, or production testing.
