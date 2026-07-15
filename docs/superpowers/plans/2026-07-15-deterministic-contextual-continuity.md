# Deterministic Contextual Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement MNEM-CONTINUITY-002 so an invocation resolves and verifies an exact D1-backed specialist runway before optional probabilistic retrieval.

**Architecture:** Mnemosyne-Worker owns immutable checkpoint persistence, exact composite-key resolution, validation receipts, compare-and-swap publication, rehydration, and lifecycle audit. The permanence tools compile equivalent canonical JSON and portable Markdown; Pulse records governance assertions without activating them; Obsidian remains review-first; the runner rehydrates before invocation and submits explicit completion checkpoints. Every repository uses a separate branch and draft pull request.

**Tech Stack:** Cloudflare Workers JavaScript, D1/SQLite, Vectorize, Web Crypto SHA-256, Node test runner, Python standard library/unittest, TypeScript/Obsidian, GitHub draft pull requests.

## Global Constraints

- Exact runway resolution precedes probabilistic retrieval.
- Existing skills, routes, role-policy meaning, memory domains, and authority boundaries remain represented.
- No new Vectorize binding or sixth semantic memory domain is introduced.
- Sealed and published checkpoints are immutable; invalidation never deletes history.
- Capability is granted only through the existing Worker role-policy registry.
- Missing project scope is not inferred; new continuity operations fail closed until the credential has an explicit project scope.
- Supplemental evidence remains visibly separate from exact runway context.
- Production data, deployments, binding activation, and automatic merge remain outside implementation.
- The protected account identifier must not enter new reports, fixtures, logs, or generated artifacts.
- Branch base for Worker: `00cd709589bdc1230b79a04b5108feed2aedef39` (clean Strategy C PR #2 head), not the unsafe 18-commit ancestry.

---

### Task 1: Worker continuity schema and immutable persistence contract

**Files:**
- Create: `migrations/002_contextual_continuity.sql`
- Create: `test/continuity-migration.test.mjs`

**Interfaces:**
- Consumes: existing D1 binding `env.DB` and migration naming convention.
- Produces: `context_runways`, `context_runway_heads`, `context_runway_records`, `context_runway_validations`, `context_retrieval_receipts`, `context_publication_attempts`, and `context_invocations` with indexes and immutability/publication triggers.

- [ ] **Step 1: Write the failing migration contract test**

  Assert that the migration defines every required table and index, adds a unique `(created_by_credential_id, idempotency_key)` constraint, permits only the card’s state values, contains no Vectorize binding, and defines triggers that reject sealed-payload mutation and atomically promote a head target.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-migration.test.mjs`

  Expected: FAIL because `migrations/002_contextual_continuity.sql` does not exist.

- [ ] **Step 3: Add the forward-only migration**

  Use the card schema with these narrow additions: `idempotency_key TEXT NOT NULL`, `portable_artifact_ref TEXT`, `indexing_state TEXT NOT NULL DEFAULT 'not_required'`, and triggers for immutable content and atomic head-state transitions. Do not add destructive down migration SQL.

- [ ] **Step 4: Verify GREEN and baseline**

  Run: `node --test test/continuity-migration.test.mjs test/repository-integrity.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add migrations/002_contextual_continuity.sql test/continuity-migration.test.mjs && git commit -m "feat: add contextual continuity schema"`

### Task 2: Worker canonical payload, normalization, validation, and hashing

**Files:**
- Create: `src/continuity.js`
- Create: `test/continuity-core.test.mjs`

**Interfaces:**
- Produces: `normalizeIdentityId`, `normalizeProjectId`, `normalizeScopeKey`, `canonicalJson`, `sha256Hex`, `validateRunwayCandidate`, `buildRunwayManifest`, `classifyFreshness`, and `ContinuityError`.

- [ ] **Step 1: Write failing unit tests**

  Cover canonical key ordering, stable hashes, allowed scope forms (`default`, named scopes, `mandate:<id>`, `thread:<id>`), rejection of unbounded keys, schema mismatch, identity mismatch, secret-like content, oversized payloads, count/length limits, source-hash shape, and prompt-injection text remaining quoted evidence rather than becoming an operative instruction.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-core.test.mjs`

  Expected: FAIL because `src/continuity.js` does not exist.

- [ ] **Step 3: Implement the bounded contract**

  Define schema `mnemosyne.context-runway/1.0`, a 128 KiB maximum canonical payload, bounded arrays and strings, UTF-8 canonical JSON with recursively sorted object keys, no implicit defaults in the hashed payload, structured non-echoing secret errors, and freshness configuration clamped to safe bounds.

- [ ] **Step 4: Verify GREEN**

  Run: `node --test test/continuity-core.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add src/continuity.js test/continuity-core.test.mjs && git commit -m "feat: add deterministic runway contract"`

### Task 3: Worker capability and scope policy

**Files:**
- Modify: `src/index.js`
- Modify: `test/fixtures/main-policy.json`
- Modify: `test/capability-policy.test.mjs`
- Create: `docs/proposals/privileges/continuity-role-grants.yaml`

**Interfaces:**
- Adds capability identifiers: `continuity.read`, `continuity.write`, `continuity.publish`, `continuity.invalidate`, `continuity.audit`.
- Adds principal metadata: `project_ids`, defaulting to an empty list for scoped credentials and `['*']` for root.

- [ ] **Step 1: Write failing policy tests**

  Assert exact grants: root all five; orchestrator read/write/publish/audit; specialist read/write; portal read; inspector read/audit; dashboard none. Assert memory search grants do not imply continuity write and missing `project_ids` fails continuity scope checks.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/capability-policy.test.mjs`

  Expected: FAIL on missing continuity grants.

- [ ] **Step 3: Extend existing policy only**

  Add constants and explicit array entries; do not derive grants with `Object.values`. Preserve grants and absences separately in the fixture and add per-role provenance declarations labelled `proposed` until merge/activation decisions occur.

- [ ] **Step 4: Verify GREEN and route baseline**

  Run: `node --test test/capability-policy.test.mjs test/route-regression.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add src/index.js test/fixtures/main-policy.json test/capability-policy.test.mjs docs/proposals/privileges/continuity-role-grants.yaml && git commit -m "feat: add explicit continuity capability policy"`

### Task 4: Worker candidate creation and validation receipts

**Files:**
- Modify: `src/continuity.js`
- Modify: `src/index.js`
- Create: `test/helpers/d1-continuity-memory.mjs`
- Create: `test/continuity-candidate.test.mjs`

**Interfaces:**
- Adds `POST /v1/continuity/checkpoints` and `POST /v1/continuity/checkpoints/:runway_id/validate`.
- Produces immutable candidate rows and separate validation receipts.

- [ ] **Step 1: Write failing route tests**

  Cover authentication, capability denial, identity/project denial, valid candidate, predecessor mismatch, duplicate idempotency key, invalid hash, secret rejection, validation receipt immutability, and disabled write feature flag.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-candidate.test.mjs`

  Expected: FAIL with route not found.

- [ ] **Step 3: Implement candidate and validation services**

  Reuse `requireCapability`, resolved principal identity, `allowedDomains`, prepared D1 statements, structured `ContinuityError`, and exact feature flags. Candidate payload is never changed by validation.

- [ ] **Step 4: Verify GREEN**

  Run: `node --test test/continuity-candidate.test.mjs test/capability-policy.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add src/index.js src/continuity.js test/helpers/d1-continuity-memory.mjs test/continuity-candidate.test.mjs && git commit -m "feat: add runway candidate validation"`

### Task 5: Worker exact resolution, fallback, and retrieval receipts

**Files:**
- Modify: `src/continuity.js`
- Modify: `src/index.js`
- Create: `test/continuity-resolution.test.mjs`

**Interfaces:**
- Adds `GET /v1/continuity/latest`.
- Produces `resolveLatestRunway(identityId, projectId, scopeKey)` with no AI or Vectorize dependency.

- [ ] **Step 1: Write failing exact-resolution tests**

  Cover exact head, no head, default fallback, optional global fallback, backfill, stale, invalidated, corrupted hash, missing row, generation/identity/project/scope mismatch, quarantine, and complete fallback receipt paths. Assert AI and Vectorize stubs receive zero calls.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-resolution.test.mjs`

  Expected: FAIL with route not found.

- [ ] **Step 3: Implement exact lookup**

  Query the composite head key first, load the referenced runway, verify canonical hash and all tuple fields, then apply only the explicit fallback order. Return `CURRENT_CONTEXT`, `STALE_CONTEXT`, `DEGRADED_CONTEXT`, `NO_CONTEXT`, `QUARANTINED_CONTEXT`, or `CONTEXT_UNAVAILABLE` and persist a retrieval receipt.

- [ ] **Step 4: Verify GREEN**

  Run: `node --test test/continuity-resolution.test.mjs`

  Expected: all tests pass and no probabilistic call occurs.

- [ ] **Step 5: Commit**

  Run: `git add src/index.js src/continuity.js test/continuity-resolution.test.mjs && git commit -m "feat: resolve exact contextual runway"`

### Task 6: Worker publication, indexing gate, concurrency, and invalidation

**Files:**
- Modify: `src/continuity.js`
- Modify: `src/index.js`
- Create: `test/continuity-publication.test.mjs`

**Interfaces:**
- Adds publish and invalidate routes.
- Produces compare-and-swap head updates, publication attempts, idempotent indexing, and historical invalidation.

- [ ] **Step 1: Write failing publication tests**

  Cover passed validation, failed validation, failed artifact generation, failed required indexing, duplicate delivery, concurrent successors, D1 update failure, stale expected generation, partial retry, predecessor preservation, successful CAS, and invalidation restoration.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-publication.test.mjs`

  Expected: FAIL with missing publication service.

- [ ] **Step 3: Implement retry-safe publication**

  Seal first; perform optional indexing with deterministic vector IDs; use one conditional head UPSERT whose migration trigger atomically updates runway states; reject zero-change CAS as a conflict; never use last-write-wins. Invalidation updates historical state and prior head atomically without deleting records.

- [ ] **Step 4: Verify GREEN**

  Run: `node --test test/continuity-publication.test.mjs test/continuity-resolution.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add src/index.js src/continuity.js test/continuity-publication.test.mjs && git commit -m "feat: publish runways with concurrency control"`

### Task 7: Worker rehydration and supplemental evidence separation

**Files:**
- Modify: `src/continuity.js`
- Modify: `src/index.js`
- Modify: `test/fixtures/main-routes.json`
- Create: `test/continuity-rehydration.test.mjs`

**Interfaces:**
- Adds `POST /v1/continuity/rehydrate` and audit read routes.
- Extends supplemental memory search metadata filters without changing its default threshold.

- [ ] **Step 1: Write failing rehydration tests**

  Cover exact-only, exact plus supplemental, older high-score evidence remaining supplemental, inaccessible references omitted with receipts, stale/no-context status, supplemental failure preserving exact context, bounded `top_k`, and audit capability denial.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-rehydration.test.mjs`

  Expected: FAIL with route not found.

- [ ] **Step 3: Implement rehydration**

  Resolve exact context first, filter record references through current domain policy, build a bounded invocation artifact, then optionally invoke existing search with project/scope/runway/source/date metadata constraints. Return `context` and `supplemental` as distinct objects.

- [ ] **Step 4: Verify GREEN and route continuity**

  Run: `node --test test/continuity-rehydration.test.mjs test/route-regression.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add src/index.js src/continuity.js test/fixtures/main-routes.json test/continuity-rehydration.test.mjs && git commit -m "feat: rehydrate exact context before memory search"`

### Task 8: Worker lifecycle flags, invocation tracking, queue/scheduled verification, and backfill

**Files:**
- Modify: `src/index.js`
- Modify: `src/continuity.js`
- Create: `scripts/backfill-context-runways.mjs`
- Create: `test/continuity-lifecycle.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Adds `CONTINUITY_READ_ENABLED`, `CONTINUITY_WRITE_ENABLED`,
  `CONTINUITY_SHADOW_MODE`, `CONTINUITY_PUBLICATION_ENABLED`,
  `CONTINUITY_INVOCATION_ENFORCEMENT`,
  `CONTINUITY_SCHEDULED_VERIFICATION`, and
  `CONTINUITY_OBSIDIAN_ACTIONS`; invocation open/complete tracking;
  continuity queue message handling; disabled-by-default scheduled
  verification; structured metrics/alerts; and a dry-run-default backfill
  client.

- [ ] **Step 1: Write failing lifecycle tests**

  Cover disabled defaults, shadow comparison, invocation acknowledgment, completion changed/unchanged/failure outcomes, idempotent queue retries, scheduled integrity checks without fabricated content, dry-run backfill, and explicit write confirmation.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/continuity-lifecycle.test.mjs`

  Expected: FAIL on missing lifecycle behavior.

- [ ] **Step 3: Implement lifecycle behavior**

  Add `scheduled` only as an exported handler with `CONTINUITY_SCHEDULED_VERIFICATION`; do not add Wrangler triggers. Route continuity queue envelopes before existing exchange envelopes. Backfill reads a local manifest, prints proposed operations by default, and requires `--apply` plus an API URL/key supplied at runtime.

  Emit the card's `continuity.*` metrics through an injected telemetry sink or
  bounded structured log. Include credential, target identity, project,
  scope, runway, generation, receipt, status, and error code; never include a
  checkpoint body or raw checkpoint bodies. Emit bounded alert envelopes for hash failure, corruption,
  collision, unavailability, prolonged staleness, cross-identity writes, and
  scheduled/queue failure without calling Pulse unless an existing authorized
  alert binding is configured.

  The metric vocabulary includes `continuity.resolve.success`,
  `continuity.resolve.missing`, `continuity.resolve.stale`,
  `continuity.resolve.degraded`, `continuity.resolve.hash_failure`,
  `continuity.rehydrate.duration_ms`, `continuity.rehydrate.payload_bytes`,
  `continuity.supplemental.used`, `continuity.supplemental.result_count`,
  `continuity.candidate.created`, `continuity.validation.failed`,
  `continuity.publication.success`, `continuity.publication.failed`,
  `continuity.publication.conflict`, `continuity.head.generation`,
  `continuity.checkpoint.age_seconds`, and `continuity.backfill.used`.

- [ ] **Step 4: Verify GREEN and all Worker tests**

  Run: `node --check src/index.js && node --check src/continuity.js && node --test test/*.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Run: `git add src/index.js src/continuity.js scripts/backfill-context-runways.mjs test/continuity-lifecycle.test.mjs README.md && git commit -m "feat: add continuity lifecycle controls"`

### Task 9: Permanence deterministic runway compiler

**Files:**
- Create: `Compiler/core/context_runway.py`
- Create: `Compiler/generators/context_runway.py`
- Create: `Compiler/validators/context_runway.py`
- Modify: `Compiler/compiler.py`
- Create: `Compiler/tests/test_context_runway.py`
- Create: `Compiler/examples/context-runway.json`
- Modify: `Compiler/README.md`

**Interfaces:**
- Produces command-equivalent functions `compile_context_runway`, `validate_context_runway`, `hash_context_runway`, `diff_context_runways`, and `verify_runway_lineage` returning canonical JSON, Markdown, SHA-256, source manifest, validation report, and predecessor diff.

- [ ] **Step 1: Write failing deterministic compiler tests**

  Run the same normalized fixture twice and assert byte-identical JSON, Markdown, hash, source manifest, validation report, and diff; cover invalid schema, secret-like content, lineage mismatch, and source hash mismatch.

- [ ] **Step 2: Verify RED**

  Run: `python -m unittest Compiler.tests.test_context_runway -v`

  Expected: FAIL because the context runway modules do not exist.

- [ ] **Step 3: Implement standard-library-only compiler path**

  Reuse `Compiler.core.canonical` hashing conventions where compatible, preserve the Worker schema exactly, render deterministic YAML-like frontmatter without external parser dependencies, and do not decide authority/capability.

- [ ] **Step 4: Verify GREEN and existing compiler smoke test**

  Run: `python -m unittest discover -s Compiler/tests -v && python -m compileall -q Compiler`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Commit only the listed compiler, fixture, test, and documentation files on a repository-specific branch.

### Task 10: Pulse governance registration without activation

**Files:**
- Modify existing federation registries on `codex/github-skill-framework` rather than Pulse main.
- Create: `contracts/schemas/mnemosyne.context-runway.input.json`
- Create: `contracts/schemas/mnemosyne.context-runway.output.json`
- Create: `contracts/invocation/contextual-runway-rehydration.yaml`
- Create: `reports/compatibility/mnem-continuity-002.md`
- Create or extend: repository-specific handoff/install-map documentation.

**Interfaces:**
- Produces a proposed `contextual-runway-rehydration` skill assertion and Worker implementation binding pinned to exact commit after the Worker branch is committed.

- [ ] **Step 1: Write failing registry/contract validation fixtures**

  Add the assertions as `proposed`, with provenance and `activation: withheld`; verify no existing persona grant, constitutional binding, or active skill changes.

- [ ] **Step 2: Verify RED**

  Run the draft framework validators before adding records and capture the missing-record findings.

- [ ] **Step 3: Add narrow registration artifacts**

  Do not edit production D1 or manually change ledger counts. Add a controlled ledger proposal that states the exact future transaction and invariant checks; do not label the skill active until the repository record, D1 write, audit text, count verification, hash, and Worker receipt exist.

- [ ] **Step 4: Verify GREEN**

  Run all local federation validators and protected-artifact hash checks.

- [ ] **Step 5: Commit**

  Commit on a Pulse-only continuation branch; do not merge or deploy.

### Task 11: Obsidian review-first continuity surface

**Files:**
- Modify: `mnemosyne-ariadne/src/main.ts`
- Modify: `mnemosyne-ariadne/src/styles.css`
- Modify: `mnemosyne-ariadne/manifest.json`
- Modify generated release artifact only through the repository build command.
- Create: plugin tests using a pure continuity client/formatter module if the current toolchain supports them.

**Interfaces:**
- Adds six commands from the card, proposal folder `System/Mnemosyne/Runway-Proposals/`, read-only published-copy folder, exact rehydration display, lineage navigation, and hash/build warnings.

- [ ] **Step 1: Write failing tests around extracted pure functions**

  Cover proposal non-mutation, hash validation, explicit submission, exact/supplemental separation, degraded warnings, missing references, read-only sealed copies, and build identifier.

- [ ] **Step 2: Verify RED**

  Run the repository’s test command or a Node test entry added without changing runtime dependencies.

- [ ] **Step 3: Implement commands against Worker contracts**

  Never submit on arbitrary edits. Do not use desktop-only filesystem APIs. Preserve current user changes in the original checkout by working from an immutable remote branch and reconciling source/build version drift explicitly.

- [ ] **Step 4: Verify GREEN and mobile build**

  Run tests, TypeScript checking, and the release build; verify `isDesktopOnly: false` and manifest/package/build alignment.

- [ ] **Step 5: Commit**

  Commit on a repository-specific branch; do not overwrite the user’s dirty local `main.js`.

### Task 12: Runner rehydrate-before-invocation contract

**Files:**
- Refactor: `ariadne-intake-review.js`
- Create: `src/continuity-client.js`
- Create: `test/continuity-client.test.js`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces rehydrate, acknowledgment, and explicit completion checkpoint requests while preserving existing review-first intake behavior.

- [ ] **Step 1: Write failing client tests**

  Assert rehydrate occurs before specialist work, exact runway remains primary, acknowledgment preserves IDs/generation/status, completion declares changed/unchanged/failure, network errors surface `CONTEXT_UNAVAILABLE`, and no checkpoint is silently submitted.

- [ ] **Step 2: Verify RED**

  Run: `npm test`

  Expected: FAIL because the continuity client does not exist.

- [ ] **Step 3: Implement injectable fetch client and CLI contract**

  Require explicit identity/project/scope configuration; never infer identity from note text. Retain runtime identifiers through completion and require an explicit checkpoint flag before submission.

- [ ] **Step 4: Verify GREEN**

  Run: `npm test && node --check ariadne-intake-review.js && node --check src/continuity-client.js`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Commit on a repository-specific branch; do not deploy.

### Task 13: Cross-repository verification and review packages

**Files:**
- Create repository-local compatibility reports and rollback instructions where existing patterns permit.
- Do not copy or mutate the append-only Pulse baseline.

**Interfaces:**
- Produces exact immutable commit pins, API/schema compatibility results, shadow-mode fixture output, deployment order, rollback sequence, and unresolved findings.

- [ ] **Step 1: Run all repository-native checks fresh**

  Worker: syntax and complete Node test suite. Permanence: unittest and compileall. Plugin: tests/type-check/build. Runner: Node tests and syntax. Pulse: federation validators and protected hashes.

- [ ] **Step 2: Run cross-contract fixtures**

  Feed permanence canonical JSON into Worker validation, feed Worker rehydration fixtures into plugin/runner parsers, and prove a higher-scoring old vector match remains supplemental.

- [ ] **Step 3: Rehearse rollback without deleting records**

  Verify feature flags disable enforcement/publication while read-only resolution/audit remain available. Record commit reverts; never delete migration-created tables or generated audit evidence.

- [ ] **Step 4: Commit final reports**

  Commit reports separately in each repository so implementation commits remain reviewable.

- [ ] **Step 5: Push and open draft PRs**

  Push each isolated branch and open separate draft PRs with exact base, commits, migrations, checks, deployment dependency, rollback impact, privilege diff, and unresolved findings. Do not merge or deploy.
