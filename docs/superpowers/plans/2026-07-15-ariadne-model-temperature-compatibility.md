# Ariadne Model Temperature Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ariadne Intake and Review compatible with models that only accept their default temperature.

**Architecture:** Keep both existing Chat Completions flows unchanged except for omitting the optional `temperature` request property. Protect the behavior with a source-level regression test because this Worker repository has no existing test harness or exported request-builder units.

**Tech Stack:** Cloudflare Worker JavaScript, Node.js built-in test runner.

## Global Constraints

- Preserve authentication, capability checks, prompts, validation, routes, and review-first behavior.
- Do not change secrets, `OPENAI_MODEL`, or Cloudflare configuration.
- Do not deploy.
- Implement test-first and keep the production diff limited to the two unsupported properties.

---

### Task 1: Protect model-compatible request bodies

**Files:**
- Create: `test/model-temperature-compat.test.js`
- Modify: `src/index.js:2841-2850`
- Modify: `src/index.js:3132-3141`

**Interfaces:**
- Consumes: the two existing `fetch("https://api.openai.com/v1/chat/completions", ...)` request blocks.
- Produces: Ariadne Intake and Review JSON bodies without a `temperature` property.

- [ ] **Step 1: Write the failing regression test**

Create a Node test that reads `src/index.js`, locates the two Ariadne Chat Completions request blocks using their unique system-prompt markers, and asserts that neither request-body slice contains `temperature:`. Also assert exactly two Ariadne Chat Completions calls are covered so a missing block cannot make the test pass accidentally.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/model-temperature-compat.test.js`

Expected: two assertion failures identifying `temperature: 0.2` in the Intake and Review request bodies.

- [ ] **Step 3: Implement the minimal correction**

Delete only these two lines from `src/index.js`:

```js
temperature: 0.2,
```

- [ ] **Step 4: Verify GREEN and syntax**

Run:

```bash
node --test test/model-temperature-compat.test.js
node --check src/index.js
git diff --check
```

Expected: one test file passes, syntax check exits zero, and no whitespace errors are reported.

- [ ] **Step 5: Review scope and commit**

Run `git diff -- src/index.js test/model-temperature-compat.test.js` and confirm no request property other than `temperature` changed. Commit with:

```bash
git add src/index.js test/model-temperature-compat.test.js
git commit -m "fix: omit unsupported Ariadne temperature"
```
