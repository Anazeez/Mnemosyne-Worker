# Graph memory operations

## Authority and rollout

D1 stores canonical graph and candidate records. Vectorize is a rebuildable
projection. Public OAuth clients can only rehydrate, search, traverse, propose,
and read their own candidate status.

All rollout flags default off. Production deployment accepts explicit inputs
for read, MCP, Actions, and proposal. Review and publication are fixed to off
in deployment automation and remain manual internal operations.

| Flag | Effect |
|---|---|
| `GRAPH_MEMORY_READ_ENABLED` | Permit accepted retrieval and own status |
| `GRAPH_MEMORY_PROPOSE_ENABLED` | Permit immutable candidate intake |
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

Do not enable review or publication through public rollout automation.
MCP and Actions deployment fails closed when `OAUTH_KV` cannot be resolved.

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
