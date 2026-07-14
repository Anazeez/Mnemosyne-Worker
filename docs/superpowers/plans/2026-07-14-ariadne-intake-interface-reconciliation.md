# Ariadne Intake Interface Reconciliation Implementation Plan

> Execution boundary: Mnemosyne-Worker only. No merge, deployment, production-data mutation, binding activation, persona privilege change, or external-repository mutation is authorized.

**Goal:** Verify and harden the existing `POST /api/ariadne/core/intake` provider contract consumed by the Ariadne Obsidian and runner clients while preserving the approved Worker baseline.

**Baseline:** Branch `codex/mnemosyne-worker-interface-reconciliation` was created from the explicitly approved immutable commit `9fc4c5cc06b7455051ee089607f23b0835dbb269`. That commit is the comparison point for route, capability, and authority-boundary regression checks.

**Approach:** Exercise the Worker module directly with Node's built-in test runner and deterministic stubs for the OpenAI boundary. Preserve the baseline role policy exactly. Make only the smallest compatible error-handling correction proven necessary by a failing test, then document the verified interface and review boundary.

---

## Task 1: Record executable contract tests

**Files:**

- Create: `test/ariadne-intake.test.mjs`
- Create: `test/baseline-regression.test.mjs`
- Create: `test/helpers/load-worker.mjs`
- Create: `test/fixtures/worker-baseline.json`

1. Load `src/index.js` without adding a package manager or runtime dependency.
2. Assert the consumer payload produces a review-first, non-mutating proposal.
3. Assert missing authentication, invalid input, upstream failures, and malformed upstream output use stable HTTP/JSON failure contracts.
4. Assert baseline roles that have the Ariadne capability remain allowed and roles without it remain denied.
5. Assert the baseline route set and effective role-capability projection remain unchanged.
6. Run `node --test test/*.test.mjs` and retain the expected failing authorization-contract evidence before modifying implementation code.

## Task 2: Apply the minimal interface correction

**Files:**

- Modify: `src/index.js`

1. Catch the existing authorization error inside the intake handler.
2. Return the same structured JSON error response already used by sibling Ariadne endpoints.
3. Do not add, remove, or reassign a capability, role, route, storage binding, or runtime mutation.
4. Re-run the focused tests and confirm the previously failing contract passes.

## Task 3: Document compatibility and rollback

**Files:**

- Modify: `README.md`
- Create: `docs/compatibility/ariadne-intake-interface-reconciliation.md`
- Create: `docs/rollback/ariadne-intake-interface-reconciliation.md`

1. Add the existing route to the local route documentation without changing authority claims.
2. Record the immutable baseline, observed consumer/provider shapes, compatibility result, privilege-boundary result, and activation exclusion.
3. Record a rollback procedure that reverts only the reconciliation commit and leaves historical evidence intact.

## Task 4: Verify and prepare the review boundary

1. Run `node --input-type=module --check < src/index.js`.
2. Run `node --test test/*.test.mjs`.
3. Confirm `git diff 9fc4c5cc06b7455051ee089607f23b0835dbb269` contains only the approved handoff scope.
4. Confirm the semantic role-capability projection and protected route inventory match the baseline fixture.
5. Commit intentionally, push only the isolated feature branch, and open a draft pull request against `main`.
6. State clearly that the branch is based on an approved commit ahead of GitHub `main`, CI definition or test success is not activation, and no merge or deployment occurred.
