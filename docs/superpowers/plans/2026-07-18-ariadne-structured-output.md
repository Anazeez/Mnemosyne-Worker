# Ariadne Structured Output Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ariadne Review and Intake request strict OpenAI Structured Outputs and return safe, stage-specific failures when a completion cannot be consumed.

**Architecture:** Keep the existing Chat Completions boundary and exact local validators. Add one closed JSON Schema per workflow, pass the selected schema into the shared provider request, inspect refusal and finish metadata before parsing, and preserve the validators as the final safety gate.

**Tech Stack:** Cloudflare Worker JavaScript, OpenAI Chat Completions Structured Outputs, Node.js built-in test runner.

## Global Constraints

- Do not change the configured OpenAI model or API key.
- Do not migrate to the Responses API.
- Do not add retries, output repair, or fallback models.
- Do not change Obsidian plugin artifacts, secrets, bindings, memory domains, or source-note mutation policy.
- Do not relax exact-key or type validators.
- Never return provider content, refusal text, note content, prompts, or credentials.
- Keep `temperature` absent from provider requests.

---

### Task 1: Enforce workflow schemas at the provider boundary

**Files:**
- Modify: `test/ariadne-review.test.mjs`
- Modify: `test/ariadne-intake.test.mjs`
- Modify: `test/helpers/worker-harness.mjs`
- Modify: `src/index.js:3160-3435`

**Interfaces:**
- Consumes: existing `requestProviderChat(env, options)` and exact workflow validators.
- Produces: `requestProviderChat(env, { system, input, schemaName, schema })`, `ARIADNE_REVIEW_SCHEMA`, and `ARIADNE_INTAKE_SCHEMA`.

- [ ] **Step 1: Make successful provider fixtures explicit about completion metadata**

Change the helper to default to a complete Chat Completions response while allowing metadata overrides:

```js
export function providerChatResponse(content, options = {}) {
  const {
    status = 200,
    finishReason = "stop",
    refusal
  } = options;
  const message = { content: typeof content === "string" ? content : JSON.stringify(content) };
  if (refusal !== undefined) message.refusal = refusal;
  return new Response(JSON.stringify({
    choices: [{ message, finish_reason: finishReason }]
  }), { status, headers: { "Content-Type": "application/json" } });
}
```

- [ ] **Step 2: Write failing Review and Intake schema assertions**

Replace prompt-contract extraction in both success tests with deep equality assertions for `payload.response_format`. The Review assertion must require all ten existing fields, closed properties, string-array items, and confidence bounds:

```js
assert.deepEqual(payload.response_format, {
  type: "json_schema",
  json_schema: {
    name: "ariadne_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        quality: { type: "string" },
        ambiguities: { type: "array", items: { type: "string" } },
        missingInformation: { type: "array", items: { type: "string" } },
        duplicateRisk: { type: "string" },
        suggestedTags: { type: "array", items: { type: "string" } },
        suggestedLinks: { type: "array", items: { type: "string" } },
        suggestedDestination: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        warnings: { type: "array", items: { type: "string" } }
      },
      required: ["summary", "quality", "ambiguities", "missingInformation", "duplicateRisk", "suggestedTags", "suggestedLinks", "suggestedDestination", "confidence", "warnings"],
      additionalProperties: false
    }
  }
});
```

The Intake assertion uses name `ariadne_intake` and its six exact fields: `classification`, `summary`, `proposedDestination`, `proposedTags`, `proposedLinks`, and `warnings`.

- [ ] **Step 3: Run focused tests and confirm the red state**

Run: `node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs`

Expected: both success tests fail because `response_format` is absent.

- [ ] **Step 4: Add closed schemas and pass them into the shared request**

In `src/index.js`, define frozen workflow schemas that exactly mirror the assertions. Change each handler call from `contract` to its schema identity:

```js
schemaName: "ariadne_review",
schema: ARIADNE_REVIEW_SCHEMA
```

and:

```js
schemaName: "ariadne_intake",
schema: ARIADNE_INTAKE_SCHEMA
```

Change `requestProviderChat` to accept these values and add:

```js
response_format: {
  type: "json_schema",
  json_schema: { name: schemaName, strict: true, schema }
}
```

Keep the input serialized in the user message, retain the system instruction, and remove the obsolete prose `Contract:` block.

- [ ] **Step 5: Run focused tests and confirm green**

Run: `node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs`

Expected: all focused tests pass and both requests still prove `temperature` is absent.

- [ ] **Step 6: Commit the schema boundary**

```bash
git add src/index.js test/ariadne-review.test.mjs test/ariadne-intake.test.mjs test/helpers/worker-harness.mjs
git commit -m "fix: enforce Ariadne structured outputs"
```

---

### Task 2: Distinguish safe provider-output failure stages

**Files:**
- Modify: `test/ariadne-review.test.mjs`
- Modify: `test/ariadne-intake.test.mjs`
- Modify: `src/index.js:3190-3510`

**Interfaces:**
- Consumes: the Task 1 response helper and schema-aware `requestProviderChat`.
- Produces: bounded `provider_output_refused`, `provider_output_incomplete`, `json_parse`, and `contract_validation` responses.

- [ ] **Step 1: Add failing metadata and validation-stage tests**

Add tests that stub these four response classes and assert exact safe bodies:

```js
providerChatResponse("{}", { refusal: "sensitive refusal text" })
// => 502 { error: "provider_output_refused" }, with no sensitive text

providerChatResponse("{}", { finishReason: "length" })
// => 502 { error: "provider_output_incomplete", details: { finishReason: "length" } }

providerChatResponse("not-json")
// => 502 { error: "invalid_provider_output", details: { stage: "json_parse" } }

providerChatResponse({ summary: "incomplete" })
// => 502 { error: "invalid_provider_output", details: { stage: "contract_validation" } }
```

Exercise refusal/incomplete through Review and parse/contract mismatch through both workflows so the shared boundary and both handlers are covered. Add one unsafe finish reason such as `"secret value"` and assert its `details` object omits `finishReason`.

- [ ] **Step 2: Run the new tests and confirm the red state**

Run: `node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs`

Expected: failures show that refusal and finish metadata are ignored and parse/contract stages are missing.

- [ ] **Step 3: Implement bounded completion-metadata handling**

After parsing the provider HTTP response, inspect the first choice before content:

```js
const choice = payload?.choices?.[0];
const message = choice?.message;
if (typeof message?.refusal === "string" && message.refusal.length > 0) {
  return { ok: false, error: "provider_output_refused", status: 502 };
}
if (choice?.finish_reason !== "stop") {
  const finishReason = cleanProviderCode(choice?.finish_reason);
  return {
    ok: false,
    error: "provider_output_incomplete",
    status: 502,
    ...(finishReason ? { details: { finishReason } } : {})
  };
}
```

Then read `message.content` exactly as before. Never include refusal or content text in the returned object.

- [ ] **Step 4: Implement parse and contract stage reporting**

In each handler, split parsing from validation:

```js
const value = parseJsonObject(provider.content);
if (!value) {
  return jsonError("invalid_provider_output", 502, { stage: "json_parse" });
}
if (!isValidAriadneReview(value)) {
  return jsonError("invalid_provider_output", 502, { stage: "contract_validation" });
}
```

Use the matching Intake validator and response property in Intake.

- [ ] **Step 5: Run focused tests and syntax validation**

Run: `node --check src/index.js && node --test test/ariadne-review.test.mjs test/ariadne-intake.test.mjs`

Expected: syntax succeeds and all focused tests pass.

- [ ] **Step 6: Commit the safe failure contract**

```bash
git add src/index.js test/ariadne-review.test.mjs test/ariadne-intake.test.mjs
git commit -m "fix: classify Ariadne provider output failures"
```

---

### Task 3: Verify, review, and release the repair

**Files:**
- Verify: `src/index.js`
- Verify: `test/ariadne-review.test.mjs`
- Verify: `test/ariadne-intake.test.mjs`
- Verify: `.github/workflows/production-preflight.yml`
- Verify: `.github/workflows/production-deploy.yml`

**Interfaces:**
- Consumes: both implementation commits.
- Produces: independently reviewed branch, merged PR, successful preflight and deploy runs tied to the merge SHA.

- [ ] **Step 1: Run the complete local verification suite**

Run:

```bash
node --check src/index.js
node --test test/*.test.mjs
rg -n "temperature|response_format|provider_output_refused|provider_output_incomplete|json_parse|contract_validation" src/index.js test/ariadne-*.test.mjs
git diff --check origin/main...HEAD
git status --short
```

Expected: syntax succeeds, all 78 baseline tests plus the new regressions pass, no `temperature` occurs in the provider request, the diff is whitespace-clean, and only intentional files changed.

- [ ] **Step 2: Obtain independent code review**

Provide the reviewer base SHA `2325ec33d72a02f7dabff4833a80a22dcc5caf7b`, current head SHA, the approved spec, and ask them to check schema/validator equivalence, privacy, response metadata, and regression coverage. Address every Critical or Important finding and rerun Step 1.

- [ ] **Step 3: Push and open a draft pull request**

```bash
git push -u origin codex/ariadne-structured-output
gh pr create --draft --base main --head codex/ariadne-structured-output --title "fix: enforce Ariadne structured outputs" --body-file <prepared-body>
```

The PR body must include root cause, design, tests, risks, non-mutation guarantee, and no-secret/no-model-change statement.

- [ ] **Step 4: Merge only after checks and review are clean**

Mark the PR ready, verify all GitHub checks, merge without rewriting unrelated history, and record the resulting merge SHA.

- [ ] **Step 5: Run production preflight and deploy in order**

Dispatch `.github/workflows/production-preflight.yml` against the merge SHA and wait for success. Only then dispatch `.github/workflows/production-deploy.yml` against the same SHA and wait for success.

- [ ] **Step 6: Verify release identity and hand off the mobile retest**

Confirm both successful workflow runs reference the merge SHA. Ask the user to run `Ariadne: Review current note`; no Obsidian plugin replacement is needed. A success must create a proposal artifact while preserving the source note; a failure must now identify refusal, incomplete completion, JSON parse, or contract validation without exposing private content.
