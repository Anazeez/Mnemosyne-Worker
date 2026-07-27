# Graph memory operations

## Authority and rollout

D1 stores canonical graph and candidate records. Vectorize is a rebuildable
projection. Public OAuth clients can only rehydrate, search, traverse, propose,
and read their own candidate status.

All rollout flags default off. Production deployment accepts explicit inputs
for read, MCP, Actions, proposal, owner-authenticated validation,
owner-authenticated entity resolution, and owner review receipts. Internal
review and publication are fixed to off in deployment automation.

| Flag | Effect |
|---|---|
| `GRAPH_MEMORY_READ_ENABLED` | Permit accepted retrieval and own status |
| `GRAPH_MEMORY_PROPOSE_ENABLED` | Permit immutable candidate intake |
| `GRAPH_MEMORY_VALIDATION_ENABLED` | Permit one-candidate validation after allowlisted GitHub owner authentication |
| `GRAPH_MEMORY_RESOLUTION_ENABLED` | Permit one-candidate exact entity resolution after allowlisted GitHub owner authentication |
| `GRAPH_MEMORY_OWNER_REVIEW_ENABLED` | Permit one resolved-candidate owner review receipt without publication |
| `GRAPH_MEMORY_OWNER_COMMIT_ENABLED` | Permit owner-only canonical commit of an approved candidate |
| `GRAPH_MEMORY_REVIEW_ENABLED` | Internal review gate; deployment keeps off |
| `GRAPH_MEMORY_PUBLICATION_ENABLED` | Internal publication gate; deployment keeps off |
| `GRAPH_MEMORY_MCP_ENABLED` | Serve OAuth-protected Streamable HTTP MCP |
| `GRAPH_MEMORY_ACTIONS_ENABLED` | Serve OAuth-protected Actions operations |

## Deployment order

1. Run production preflight and the deterministic pilot.
2. Deploy with all graph flags off and apply the migration. Create or reuse a
   dedicated `OAUTH_KV` when the Cloudflare token permits it.
3. Verify `/ping`, OAuth metadata, protected-resource metadata, and OpenAPI.
4. Require dedicated `OAUTH_KV`, then configure the GitHub OAuth app callback
   as `https://memory.azzayezz.com/callback`. Store the client ID, client
   secret, grant-resolver token, and OpenAI challenge as Worker secrets.
5. Deploy the custom domain only after the obsolete Cloudflare Tunnel route for
   `memory.azzayezz.com` has been exported for rollback and removed.
6. Verify the exact HTTPS origin, OAuth metadata origins, challenge shape,
   anonymous denial on protected routes, and that review/publication remain
   unavailable.
7. Enable read for the synthetic tenant.
8. Enable MCP and Actions, then verify five tools with an owner-scoped token.
9. Enable proposal and prove it creates only `pending_validation`.
10. Enable owner validation and prove it advances a valid candidate only to
    `pending_review`, with no accepted assertion or snapshot.
11. Enable owner resolution and prove it records an append-only receipt while
    leaving the candidate outside accepted memory.
12. Enable owner review and prove approval records only
    `approve_for_commit`, with no accepted assertion or snapshot.

Do not enable review or publication through public rollout automation.
MCP and Actions deployment fails closed when `OAUTH_KV` cannot be resolved.

## Owner validation

With validation enabled, open the candidate-specific URL in a browser:

```text
https://memory.azzayezz.com/owner/memory/candidates/CANDIDATE_ID/validate?tenant_id=personal&project_id=PROJECT_ID
```

The Worker displays a non-mutating confirmation page, binds the confirmation
to a one-time CSRF value, and then verifies the immutable GitHub owner ID.
Successful deterministic validation advances the candidate only from
`pending_validation` to `pending_review`. Invalid candidates are quarantined
with a stable reason code. This flow issues no reusable review credential and
cannot accept or publish memory.

## Owner entity resolution

With resolution enabled, open the validated candidate's specific URL:

```text
https://memory.azzayezz.com/owner/memory/candidates/CANDIDATE_ID/resolve?tenant_id=personal&project_id=PROJECT_ID
```

The gate compares normalized exact labels only with accepted entities in the
authorized tenant and project. One exact match is recorded, no match is
recorded as a proposed new entity, and multiple exact matches quarantine the
candidate with `AMBIGUOUS_ENTITY_MATCH`. It creates only an immutable
resolution receipt and decision; it does not create entities, assertions,
snapshots, accepted memory, or reusable review credentials.

## Owner review receipt

With owner review enabled, open:

```text
https://memory.azzayezz.com/owner/memory/candidates/CANDIDATE_ID/review?tenant_id=personal&project_id=PROJECT_ID
```

After GitHub owner authentication, the Worker displays the immutable candidate
assertions, evidence, and resolution receipt. `approve_for_commit` records only
an append-only review receipt and leaves the candidate `pending_review`.
Rejection and quarantine use stable reason codes and move the candidate out of
the review queue. This gate cannot publish; controlled commit remains a
separate, disabled privilege.

## Owner controlled commit

With the separately approved owner commit gate enabled, open:

```text
https://memory.azzayezz.com/owner/memory/candidates/CANDIDATE_ID/commit?tenant_id=personal&project_id=PROJECT_ID
```

After a fresh GitHub owner authentication, the Worker displays the exact
candidate, evidence, resolution receipt, and `approve_for_commit` review
receipt. A second one-time CSRF-bound confirmation atomically writes the
accepted entity and assertions, pre-commit rollback snapshot, projection
outbox, publication decision, and append-only owner commit receipt. Replays
return the original receipt. General review and publication rollout flags
remain disabled.

The accepted D1 assertion is immediately searchable through a deterministic
cross-field fallback; search responses report the project's accepted generation
even when no assertion matches. The commit response also schedules bounded FTS
and Vectorize repair in the Worker execution context. Projection failure leaves
the outbox in `repair_queued` and never reverses the canonical D1 commit.

## Owner identity and project grants

Only immutable GitHub user ID `277895262` may complete OAuth. OAuth clients
receive a stable derived assistant ID; user-supplied assistant names are never
authorization identities.

The orchestrator may access all projects. Specialists receive `global-canon`
plus explicitly approved projects. A specialist requesting an unassigned
project is denied unless the owner creates an exceptional grant. Exceptional
grants expire after 24 hours by default; permanent grants require an explicit
flag. Approval, revocation, and expiry append immutable authorization receipts.

Use the private administration command with `MATRIX_AUTH_KEY` supplied through
the environment:

```sh
node scripts/manage-memory-grants.mjs list-active \
  --base-url https://memory.azzayezz.com

node scripts/manage-memory-grants.mjs approve \
  --base-url https://memory.azzayezz.com \
  --assistant-id oauth-REDACTED \
  --project-id assigned-project

node scripts/manage-memory-grants.mjs revoke \
  --base-url https://memory.azzayezz.com \
  --grant-id grant-REDACTED
```

Run each command with `--dry-run` first. Never place root keys, OAuth secrets,
challenge values, or access tokens in command arguments, logs, or receipts.

## Custom-domain cutover and rollback

Before cutover:

1. Export the existing `Hearken` Tunnel route configuration for
   `memory.azzayezz.com`, including its tunnel ID and service target.
2. Confirm the Worker is healthy at its workers.dev address with all graph
   flags off.
3. Remove only the `memory.azzayezz.com` Tunnel route. Do not change
   `ide.azzayezz.com`.
4. Run the production workflow with `enable_custom_domain` enabled.
5. Run:

```sh
node scripts/verify-live-graph-memory.mjs \
  --base-url https://memory.azzayezz.com \
  --expected-origin https://memory.azzayezz.com \
  --expect-challenge
```

For rollback, disable the Worker custom-domain route, restore the exported
Tunnel route exactly, and keep all graph feature flags off. Do not delete D1,
KV, authorization receipts, or candidates during a routing rollback.

## Recovery

Disable MCP, Actions, proposal, and read without dropping tables. Existing
candidates, accepted facts, evidence, decisions, snapshots, deletion receipts,
and invocation receipts remain intact. Projection repair reads accepted D1
records only. Publication rollback restores a verified snapshot by forward
repair; it never rewrites decision history.
