# Ariadne Provider Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore model-compatible, typed, observable Ariadne Intake and Review requests on the reconstructed Mnemosyne Worker.

**Architecture:** Keep the reconstructed Worker's shared `requestProviderChat()` boundary, but make its request model-neutral by omitting `temperature`, supply workflow-specific type contracts, and return only bounded upstream status/code diagnostics. Existing strict Intake and Review validators remain the final safety gate.

**Tech Stack:** Cloudflare Worker JavaScript, Node.js built-in test runner, mocked `fetch` through the existing Worker harness.

## Global Constraints

- Do not deploy or push to `main`.
- Do not alter secrets, model allowlists, Worker bindings, capabilities, continuity behavior, or Obsidian files.
- Review and Intake remain review-first and non-mutating.
- Never reflect provider messages, bodies, prompts, note content, authorization headers, or API keys in an error response.
- Every production-code change requires a failing regression test first.

---

### Task 1: Restore Model-Compatible Typed Requests

**Files:**
- Modify: `test/ariadne-review.test.mjs`
- Modify: `test/ariadne-intake.test.mjs`
- Modify: `src/index.js:3169-3413`

**Interfaces:**
- Consumes: `requestProviderChat(env, { system, input, contract })` with a JSON-serializable field/type contract.
- Produces: Chat Completions requests without `temperature` and with an exact workflow contract in the user message.

- [ ] **Step 1: Add failing request-contract assertions**

In the successful Review and Intake provider stubs, parse `options.body` and assert the payload omits `temperature` and includes the typed fields:

```js
assert.equal(Object.hasOwn(payload, "temperature"), false);
assert.match(payload.messages[1].content, /"confidence":"number between 0 and 1"/);
assert.match(payload.messages[1].content, /"proposedTags":"string\[\]"/);
assert.match(payload.messages[1].content, /"warnings":"string\[\]"/);
```

- [ ] **Step 2: Run both tests and verify the regression is red**

Run:

```bash
node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs
```

Expected: FAIL because the requests include `temperature` and lack the typed contracts.

- [ ] **Step 3: Implement workflow contracts and the model-compatible request**

Replace each workflow's field-name array with a contract object.

Review:

```js
const contract = {
  summary: "string",
  quality: "string",
  ambiguities: "string[]",
  missingInformation: "string[]",
  duplicateRisk: "string",
  suggestedTags: "string[]",
  suggestedLinks: "string[]",
  suggestedDestination: "string",
  confidence: "number between 0 and 1",
  warnings: "string[]"
};
```

Intake:

```js
const contract = {
  classification: "string",
  summary: "string",
  proposedDestination: "string",
  proposedTags: "string[]",
  proposedLinks: "string[]",
  warnings: "string[]"
};
```

Change `requestProviderChat()` to accept `contract`, omit `temperature`, and construct this user message:

```js
content:
  "Return one JSON object matching this required contract exactly. " +
  "Do not add or omit fields.\n\n" +
  `Contract: ${JSON.stringify(contract)}\n\n` +
  `Input: ${JSON.stringify(input)}`
```

- [ ] **Step 4: Run focused tests and verify green**

Run:

```bash
node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the typed request repair**

```bash
git add src/index.js test/ariadne-review.test.mjs test/ariadne-intake.test.mjs
git commit -m "fix: restore Ariadne provider contracts"
```

### Task 2: Restore Bounded Upstream Diagnostics

**Files:**
- Modify: `test/ariadne-review.test.mjs`
- Modify: `test/ariadne-intake.test.mjs`
- Modify: `src/index.js:3169-3413`

**Interfaces:**
- Consumes: a non-successful provider HTTP response with optional JSON `error.code` or `error.type`.
- Produces: `provider_request_failed`, HTTP 502, and details containing only `upstreamStatus` plus an optional bounded `upstreamCode`.

- [ ] **Step 1: Add failing bounded-diagnostic assertions**

Make the Review stub return HTTP 400 with:

```js
{
  error: {
    code: "unsupported_value",
    message: sensitiveMarker
  }
}
```

Make the Intake stub return HTTP 429 with `error.type` equal to `rate_limit_error` and another sensitive message. Assert the respective Worker bodies are exactly:

```js
{
  error: "provider_request_failed",
  details: {
    upstreamStatus: 400,
    upstreamCode: "unsupported_value"
  }
}
```

and:

```js
{
  error: "provider_request_failed",
  details: {
    upstreamStatus: 429,
    upstreamCode: "rate_limit_error"
  }
}
```

Assert neither response contains its sensitive upstream message.

- [ ] **Step 2: Run both tests and verify the diagnostic regression is red**

Run:

```bash
node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs
```

Expected: FAIL because current code collapses both errors to `provider_unavailable`.

- [ ] **Step 3: Implement closed-format error extraction and propagation**

Add:

```js
function cleanProviderCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value)
    ? value
    : "";
}
```

For non-successful provider responses, parse JSON solely to extract
`error.code` or `error.type`; never preserve the message or body. Return:

```js
return {
  ok: false,
  error: "provider_request_failed",
  status: 502,
  details: {
    upstreamStatus: response.status,
    ...(upstreamCode ? { upstreamCode } : {})
  }
};
```

Update both handlers to propagate only those bounded details:

```js
return jsonError(provider.error, provider.status, provider.details);
```

- [ ] **Step 4: Run focused Ariadne tests and verify green**

Run:

```bash
node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs test/ariadne-diagnostic.test.mjs test/ariadne-status.test.mjs
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the bounded diagnostic repair**

```bash
git add src/index.js test/ariadne-review.test.mjs test/ariadne-intake.test.mjs
git commit -m "fix: expose bounded Ariadne provider errors"
```

### Task 3: Final Verification and Handoff

**Files:**
- Verify: `src/index.js`
- Verify: `test/ariadne-review.test.mjs`
- Verify: `test/ariadne-intake.test.mjs`
- Verify: `docs/superpowers/specs/2026-07-18-ariadne-provider-contract-repair-design.md`

**Interfaces:**
- Consumes: the completed repair branch.
- Produces: a reviewable diff and verification evidence without deployment.

- [ ] **Step 1: Run the complete Worker suite and repository checks**

Run:

```bash
node --test test/*.test.mjs
git diff --check
```

Expected: 0 test failures and no whitespace errors.

- [ ] **Step 2: Verify the original regression is absent from the provider boundary**

Run:

```bash
sed -n '/async function requestProviderChat/,/^}/p' src/index.js | rg "temperature\s*:"
```

Expected: no match.

- [ ] **Step 3: Run fresh final verification and inspect branch state**

Run:

```bash
node --test test/*.test.mjs
git diff --check
git status --short
git log --oneline --decorate -5
```

Expected: all tests PASS, no whitespace errors, a clean worktree, and only the planned commits on `codex/ariadne-provider-contract-repair`.

- [ ] **Step 4: Present the handoff**

Report the root cause, modified files, exact test count, commits, residual model-availability risk, and the fact that no deployment, secret change, or push to `main` occurred. Wait for explicit deployment or pull-request direction.
