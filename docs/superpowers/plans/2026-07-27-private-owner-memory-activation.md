# Private Owner Memory Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate owner-only Mnemosyne memory at `memory.azzayezz.com` with attributable assistants, owner-approved project grants, OAuth refresh enforcement, and a fail-closed staged rollout.

**Architecture:** GitHub proves the owner's immutable identity, D1 stores assistant/project grants and immutable authorization receipts, and OAuth token exchange refreshes scoped claims from those grants. The public MCP and Actions adapters remain limited to accepted reads, candidate proposals, and the caller's own candidate status; administration stays in an authenticated operations script.

**Tech Stack:** Cloudflare Workers, D1, Workers KV, `@cloudflare/workers-oauth-provider` 0.8.2, Node.js 24, Web Crypto, GitHub OAuth, GitHub Actions, Wrangler 4.114.0.

## Global Constraints

- Authorize only the immutable GitHub user ID confirmed for `Anazeez`; never authorize by username.
- Never commit or print OAuth client secrets, Cloudflare credentials, access tokens, refresh tokens, or domain-challenge tokens.
- Keep direct accepted-memory writes, automatic review, and automatic publication disabled.
- Keep the public MCP contract at exactly five tools.
- Every assistant can access `global-canon`; orchestrator access to `*` and specialist project access require owner-approved grants.
- Exceptional grants expire after 24 hours by default; permanent grants require an explicit owner choice.
- New grants become available only through a refreshed or reauthorized token; revocation fails closed.
- Preserve candidate, evidence, decision, quarantine, authorization, replay, rollback, export, and deletion guarantees.
- Retrieve accepted memory with bounded depth, count, evidence, bytes, and execution time.
- Preserve the prior Cloudflare Tunnel route until the Worker Custom Domain smoke test passes.

---

### Task 1: Owner Identity Gate and Stable Assistant Attribution

**Files:**
- Modify: `src/oauth.js`
- Modify: `test/oauth.test.mjs`

**Interfaces:**
- Produces: `parseAllowedGithubUserIds(value: string): Set<number>`
- Produces: `assertAllowedGithubUser(githubUser: object, allowedIds: Set<number>): number`
- Produces: `assistantIdForOAuthClient(clientId: string): Promise<string>`
- Changes: `buildGrantClaims({ githubUser, tenantId, assistantId, projectIds, requestedScopes })`

- [ ] **Step 1: Write failing tests for immutable owner authorization**

Add tests that parse a comma-separated allowlist, accept the confirmed numeric
owner ID, reject a different numeric ID with `github_identity_not_authorized`,
and prove a matching username with the wrong numeric ID is rejected.

```js
const allowed = parseAllowedGithubUserIds("277895262");
assert.equal(
  assertAllowedGithubUser({ id: 277895262, login: "Anazeez" }, allowed),
  277895262,
);
assert.throws(
  () => assertAllowedGithubUser({ id: 7, login: "Anazeez" }, allowed),
  /github_identity_not_authorized/,
);
```

- [ ] **Step 2: Run the owner-gate tests and verify RED**

Run:

```bash
node --test --test-name-pattern="owner|authorized GitHub" test/oauth.test.mjs
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement strict numeric-ID parsing and denial**

Implement closed parsing and authorization:

```js
export function parseAllowedGithubUserIds(value) {
  const ids = String(value || "")
    .split(",")
    .map(item => Number(item.trim()))
    .filter(Number.isSafeInteger)
    .filter(id => id > 0);
  if (ids.length === 0) throw statusError("github_allowlist_missing", 503);
  return new Set(ids);
}

export function assertAllowedGithubUser(githubUser, allowedIds) {
  const id = Number(githubUser?.id);
  if (!Number.isSafeInteger(id) || !allowedIds.has(id)) {
    throw statusError("github_identity_not_authorized", 403);
  }
  return id;
}
```

Call it immediately after GitHub `/user` succeeds and before building claims.

- [ ] **Step 4: Write failing tests for stable assistant attribution**

Prove the same client ID produces the same bounded identifier, a different
client ID produces a different identifier, and caller-supplied assistant text
never enters claims.

```js
const first = await assistantIdForOAuthClient("client-a");
assert.equal(first, await assistantIdForOAuthClient("client-a"));
assert.notEqual(first, await assistantIdForOAuthClient("client-b"));
assert.match(first, /^oauth-[a-f0-9]{32}$/);
```

- [ ] **Step 5: Run the assistant tests and verify RED**

Run:

```bash
node --test --test-name-pattern="assistant attribution" test/oauth.test.mjs
```

Expected: FAIL because `assistantIdForOAuthClient` is absent.

- [ ] **Step 6: Implement Web Crypto attribution and bind it to the OAuth client**

Hash the registered `authRequest.clientId`:

```js
export async function assistantIdForOAuthClient(clientId) {
  const bytes = new TextEncoder().encode(String(clientId));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `oauth-${[...new Uint8Array(digest)]
    .slice(0, 16)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
```

Pass the result into `buildGrantClaims` and remove the hard-coded
`assistant_id: "oauth-client"`.

- [ ] **Step 7: Run OAuth tests**

Run:

```bash
node --test test/oauth.test.mjs
```

Expected: all OAuth tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/oauth.js test/oauth.test.mjs
git commit -m "feat: restrict oauth to owner identity"
```

### Task 2: Versioned Project Grants and Immutable Authorization Receipts

**Files:**
- Create: `migrations/004_private_memory_grants.sql`
- Create: `src/graph-memory/grants.js`
- Create: `test/graph-memory-grants.test.mjs`
- Modify: `test/helpers/d1-graph-memory.mjs`

**Interfaces:**
- Produces: `resolveAssistantGrant(db, { tenantId, ownerGithubId, assistantId, now }): Promise<{ project_ids: string[], grant_version: string }>`
- Produces: `approveAssistantGrant(db, input): Promise<object>`
- Produces: `revokeAssistantGrant(db, input): Promise<object>`
- Produces tables: `memory_access_grants`, `memory_authorization_receipts`

- [ ] **Step 1: Write failing migration-shape tests**

Require tenant, owner, assistant, project, capabilities, status, start, expiry,
approver, reason, and monotonically changing grant version fields. Require
immutable receipt rows for approval, denial, expiry, and revocation.

```js
assert.match(sql, /CREATE TABLE memory_access_grants/);
assert.match(sql, /expires_at TEXT/);
assert.match(sql, /CHECK \\(status IN \\('active', 'revoked'\\)\\)/);
assert.match(sql, /CREATE TABLE memory_authorization_receipts/);
assert.doesNotMatch(sql, /DROP TABLE/);
```

- [ ] **Step 2: Run the migration tests and verify RED**

Run:

```bash
node --test test/graph-memory-migration.test.mjs
```

Expected: FAIL because migration 004 is absent.

- [ ] **Step 3: Add the forward-only D1 migration**

Create composite indexes on
`(tenant_id, owner_github_id, assistant_id, project_id, status, expires_at)` and
an append-only receipt table. Add triggers that reject receipt update/delete.
Do not add transaction statements that D1 migration batching rejects.

- [ ] **Step 4: Write failing grant-resolution tests**

Cover:

- `global-canon` is always present for an authorized owner assistant.
- an active specialist grant returns only its project plus `global-canon`;
- an orchestrator `*` grant returns `*` plus `global-canon`;
- a future, expired, or revoked grant is excluded;
- the same approval idempotency key cannot create two grants;
- exceptional approval defaults to exactly 86,400 seconds;
- permanent approval has a null expiry only when `permanent: true`;
- revocation creates a receipt and increments the grant version.

- [ ] **Step 5: Run grant tests and verify RED**

Run:

```bash
node --test test/graph-memory-grants.test.mjs
```

Expected: FAIL because the grant service is absent.

- [ ] **Step 6: Implement deterministic grant resolution**

Return sorted, unique projects and a version derived from the latest applicable
grant mutation plus assistant identity:

```js
export async function resolveAssistantGrant(db, target) {
  const rows = await listActiveGrantRows(db, target);
  const projects = new Set(["global-canon"]);
  for (const row of rows) projects.add(row.project_id);
  return {
    project_ids: [...projects].sort(),
    grant_version: await canonicalHash({
      assistant_id: target.assistantId,
      receipts: rows.map(row => row.receipt_hash).sort(),
    }),
  };
}
```

Approval and revocation must execute in D1 batches, write immutable receipts,
and use stable reason codes.

- [ ] **Step 7: Run migration and grant tests**

Run:

```bash
node --test test/graph-memory-migration.test.mjs test/graph-memory-grants.test.mjs
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit**

```bash
git add migrations/004_private_memory_grants.sql src/graph-memory/grants.js test/graph-memory-grants.test.mjs test/graph-memory-migration.test.mjs test/helpers/d1-graph-memory.mjs
git commit -m "feat: add owner-approved project grants"
```

### Task 3: Refresh-Aware OAuth Claims and Private Grant Operations

**Files:**
- Create: `scripts/manage-memory-grants.mjs`
- Modify: `src/oauth.js`
- Modify: `src/worker.js`
- Modify: `test/oauth.test.mjs`
- Create: `test/manage-memory-grants.test.mjs`

**Interfaces:**
- Consumes: `resolveAssistantGrant`, `approveAssistantGrant`, `revokeAssistantGrant`
- Produces: `refreshGrantProps(env, props): Promise<object>`
- Produces CLI commands:
  `approve`, `revoke`, and `list-active`

- [ ] **Step 1: Write a failing OAuth authorization test using D1 grants**

Prove authorization claims contain `global-canon`, assigned projects, stable
assistant ID, owner ID, and `grant_version`; prove no environment-wide
`MEMORY_PROJECT_IDS` wildcard is used.

- [ ] **Step 2: Run the authorization test and verify RED**

Run:

```bash
node --test --test-name-pattern="D1 grants" test/oauth.test.mjs
```

Expected: FAIL because OAuth does not query grants.

- [ ] **Step 3: Resolve grants during authorization**

After owner verification and assistant-ID derivation, call
`resolveAssistantGrant(env.DB, ...)`. Include `owner_github_id` and
`grant_version` in encrypted OAuth props. Keep the tenant server-owned.

- [ ] **Step 4: Write a failing refresh-token callback test**

Call `refreshGrantProps` with old props, change the active D1 grant, and prove
the returned props contain the new project set and grant version. Prove a
revoked owner or missing owner allowlist throws `invalid_grant`.

- [ ] **Step 5: Run the refresh test and verify RED**

Run:

```bash
node --test --test-name-pattern="refresh.*grant" test/oauth.test.mjs
```

Expected: FAIL because refresh grant resolution is absent.

- [ ] **Step 6: Add `tokenExchangeCallback`**

Configure:

```js
tokenExchangeCallback: async options => {
  if (options.grantType !== "refresh_token") return;
  const newProps = await refreshGrantProps(options.env, options.props);
  return { accessTokenProps: newProps, newProps };
},
```

Use the package's refresh callback to update both the current access token and
future refresh grant. Deny when the owner ID is no longer allowlisted.

- [ ] **Step 7: Write failing operations-script tests**

Test argument parsing without network access:

```bash
node scripts/manage-memory-grants.mjs approve \
  --assistant oauth-abc \
  --project project-alpha \
  --reason owner-approved \
  --dry-run
```

Expected JSON includes a 24-hour expiry. `--permanent` yields null expiry.
`revoke` requires an explicit reason. Output must never include credentials.

- [ ] **Step 8: Run operations tests and verify RED**

Run:

```bash
node --test test/manage-memory-grants.test.mjs
```

Expected: FAIL because the script is absent.

- [ ] **Step 9: Implement the operations script**

Use imported grant functions for unit tests and Wrangler D1 execution only when
`--dry-run` is absent. Require explicit tenant, assistant, project, owner ID,
and reason. Emit only grant ID, project, assistant ID, state, and expiry.

- [ ] **Step 10: Run OAuth and operations tests**

Run:

```bash
node --test test/oauth.test.mjs test/manage-memory-grants.test.mjs
```

Expected: all selected tests PASS.

- [ ] **Step 11: Commit**

```bash
git add src/oauth.js src/worker.js scripts/manage-memory-grants.mjs test/oauth.test.mjs test/manage-memory-grants.test.mjs
git commit -m "feat: refresh oauth project grants"
```

### Task 4: Domain Challenge, Secret Provisioning, and Custom-Domain Deployment

**Files:**
- Modify: `src/oauth.js`
- Modify: `test/oauth.test.mjs`
- Modify: `scripts/cloudflare-binding-preflight.mjs`
- Modify: `test/cloudflare-binding-preflight.test.mjs`
- Modify: `.github/workflows/production-deploy.yml`
- Modify: `scripts/verify-live-graph-memory.mjs`
- Modify: `docs/graph-memory-operations.md`

**Interfaces:**
- Produces: `openAiChallengeResponse(env): Response`
- Extends: `buildDeploymentConfig(..., { customDomain })`
- Consumes secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `OAUTH_KV_NAMESPACE_ID`, `OPENAI_APPS_CHALLENGE`

- [ ] **Step 1: Write failing challenge endpoint tests**

Require GET `/.well-known/openai-apps-challenge` to return only the configured
token as `text/plain`, with `Cache-Control: no-store`. Missing configuration
returns 404. POST returns 405. The token must not appear in logs or `/ping`.

- [ ] **Step 2: Run challenge tests and verify RED**

Run:

```bash
node --test --test-name-pattern="apps challenge" test/oauth.test.mjs
```

Expected: FAIL because the route is absent.

- [ ] **Step 3: Implement the exact challenge response**

Handle the route in the default OAuth handler before the legacy worker. Return:

```js
new Response(env.OPENAI_APPS_CHALLENGE, {
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  },
});
```

- [ ] **Step 4: Write failing deployment-config tests**

Require the ephemeral config to preserve all live bindings, bind the dedicated
KV ID, and include exactly:

```json
{
  "pattern": "memory.azzayezz.com",
  "custom_domain": true
}
```

only when `MNEMOSYNE_CUSTOM_DOMAIN` is supplied.

- [ ] **Step 5: Run deployment-config tests and verify RED**

Run:

```bash
node --test test/cloudflare-binding-preflight.test.mjs
```

Expected: FAIL because custom-domain configuration is absent.

- [ ] **Step 6: Extend the binding-preserving deployment config**

Add the custom domain without removing existing Worker bindings or vars. Update
the workflow to:

- require `OAUTH_KV_NAMESPACE_ID` when MCP or Actions are enabled;
- require `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`;
- put Worker secrets using stdin without echo;
- set `AUTHORIZED_GITHUB_USER_IDS` and `MEMORY_TENANT_ID` as non-secret vars;
- leave review and publication flags at `0`;
- never create or delete the Tunnel route automatically.

- [ ] **Step 7: Extend live verification**

Add options:

```text
--expected-origin https://memory.azzayezz.com
--expect-tools 5
--expect-actions 1
```

Verify HTTPS, OAuth issuer/origin consistency, challenge response shape without
printing its value, protected unauthenticated denial, and the five-tool list
with a temporary owner token supplied only through `MNEMOSYNE_ACCESS_TOKEN`.

- [ ] **Step 8: Document the manual hostname swap and rollback**

Record:

1. export/screenshot the Hearten Tunnel route;
2. remove only `memory.azzayezz.com` from that Tunnel;
3. deploy the Worker Custom Domain;
4. run the live verifier;
5. if verification fails, disable graph flags, remove the Worker Custom Domain,
   and restore the saved Tunnel route.

- [ ] **Step 9: Run selected tests**

Run:

```bash
node --test test/oauth.test.mjs test/cloudflare-binding-preflight.test.mjs
```

Expected: all selected tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/oauth.js test/oauth.test.mjs scripts/cloudflare-binding-preflight.mjs test/cloudflare-binding-preflight.test.mjs .github/workflows/production-deploy.yml scripts/verify-live-graph-memory.mjs docs/graph-memory-operations.md
git commit -m "ops: prepare private memory custom domain"
```

### Task 5: Full Verification and Staged Production Activation

**Files:**
- Modify only if a verification failure proves a defect in an in-scope file.

**Interfaces:**
- Consumes: all prior tasks
- Produces: verified private production service and evidence receipts

- [ ] **Step 1: Run the full local test suite and security audit**

Run:

```bash
npm test
npm audit --audit-level=high
```

Expected: zero test failures and zero high-or-critical vulnerabilities.

- [ ] **Step 2: Run deterministic graph pilot twice**

Run:

```bash
first=$(mktemp)
second=$(mktemp)
node scripts/graph-memory-pilot.mjs \
  --fixture migrations/fixtures/graph-memory-golden.jsonl \
  --output "$first"
node scripts/graph-memory-pilot.mjs \
  --fixture migrations/fixtures/graph-memory-golden.jsonl \
  --output "$second"
cmp "$first" "$second"
```

Expected: byte-identical passing reports with entity and relation precision 1,
provenance and ontology coverage 1, and replay/rollback equality true.

- [ ] **Step 3: Obtain provider inputs without chat disclosure**

The owner enters values directly into provider controls:

- restricted Cloudflare token with Worker, KV, Worker-secret, and
  `azzayezz.com` custom-domain permissions;
- dedicated KV namespace ID;
- GitHub OAuth client ID and secret with callback
  `https://memory.azzayezz.com/callback`;
- OpenAI-generated domain challenge token.

Verify only presence and permission, never values.

- [ ] **Step 4: Deploy default-off through `workers.dev`**

Dispatch production deployment with read, MCP, Actions, and proposal inputs
false. Apply migration 004 and verify the existing origin with zero public MCP
tools.

- [ ] **Step 5: Seed explicit grants**

Use the operations script to create:

- an orchestrator `*` grant;
- `global-canon` access through the built-in rule;
- one representative specialist project grant.

Record only receipt IDs and hashes.

- [ ] **Step 6: Perform the manual hostname swap**

Follow the documented Hearten route backup/removal and attach
`memory.azzayezz.com` to the Worker. Do not modify `ide.azzayezz.com` or any MX,
SPF, DKIM, DMARC, email-routing, or mesh-exchange record.

- [ ] **Step 7: Verify the permanent origin with flags off**

Run:

```bash
node scripts/verify-live-graph-memory.mjs \
  --base-url https://memory.azzayezz.com \
  --expected-origin https://memory.azzayezz.com \
  --expect-tools 0
```

Expected: TLS and metadata pass; every graph feature reports false.

- [ ] **Step 8: Test OAuth allow and deny**

Complete owner OAuth in a private browser session. In a separate controlled
negative fixture, confirm a non-owner identity is denied before token issuance.
Do not use or request another person's credentials.

- [ ] **Step 9: Enable reads and verify retrieval**

Deploy with read true and public adapters false. Verify accepted-memory
rehydration, provenance, project denial, export, deletion dry-run, replay, and
rollback.

- [ ] **Step 10: Enable MCP, Actions, and proposal intake**

Deploy with read, MCP, Actions, and proposal true; keep review and publication
false. Run the live verifier with an ephemeral owner token and expect exactly
five MCP tools.

- [ ] **Step 11: Verify orchestrator and specialist boundaries**

Confirm:

- orchestrator reads an owner project and `global-canon`;
- specialist reads its assigned project and `global-canon`;
- specialist receives `PROJECT_SCOPE_DENIED` elsewhere;
- a 24-hour approval becomes available only after token refresh;
- revocation removes access on the next refresh and fails closed in live
  authorization checks.

- [ ] **Step 12: Commit any evidence-only documentation and push**

Do not commit secrets, tokens, personal data, or raw tool responses.

```bash
git status --short
git push
```

Expected: implementation branch is clean and the draft PR points at the tested
commit.
