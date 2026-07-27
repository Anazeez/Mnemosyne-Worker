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
2. Deploy with all graph flags off; apply migration and create/reuse `OAUTH_KV`.
3. Verify `/ping`, OAuth metadata, protected-resource metadata, and OpenAPI.
4. Configure GitHub OAuth credentials.
5. Enable read for the synthetic tenant.
6. Enable MCP and Actions, then verify five tools with a scoped token.
7. Enable proposal and prove it creates only `pending_validation`.

Do not enable review or publication through public rollout automation.

## Recovery

Disable MCP, Actions, proposal, and read without dropping tables. Existing
candidates, accepted facts, evidence, decisions, snapshots, deletion receipts,
and invocation receipts remain intact. Projection repair reads accepted D1
records only. Publication rollback restores a verified snapshot by forward
repair; it never rewrites decision history.
