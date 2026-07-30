# Owner Memory Review Design

**Status:** Approved

## Goal

Let the verified owner review one resolved memory candidate and record a final
human decision without publishing or otherwise writing accepted memory.

## Chosen design

Use a separate owner-only browser flow and rollout flag. After GitHub verifies
the immutable owner ID, the Worker displays the candidate assertions, evidence,
and entity-resolution receipt. The owner may choose exactly one terminal review
decision:

- `approve_for_commit`: record approval while leaving the candidate
  `pending_review`;
- `reject`: record the stable reason `OWNER_REJECTED` and move the candidate to
  `rejected`;
- `quarantine`: record `OWNER_QUARANTINED` and move the candidate to
  `quarantined`.

The review receipt is append-only, tenant/project scoped, bound to the immutable
candidate payload hash and resolution receipt hash, and replay-safe. It grants
no reusable credential and creates no entity, assertion, snapshot, projection,
accepted generation, or publication decision.

## Authorization and interaction

`GRAPH_MEMORY_OWNER_REVIEW_ENABLED` is independent from the existing internal
review and publication flags. The flow uses one-time CSRF state, GitHub OAuth,
the allowlisted immutable owner ID, and a second one-time decision token created
only after owner authentication. Public MCP, Actions, and OAuth scopes do not
gain review capability.

## Failure behavior

Missing resolution, non-reviewable state, altered target, expired state,
non-owner identity, replay with a different decision, and malformed decisions
fail closed. Unsupported candidates remain unchanged. Review and publication
flags remain hardcoded off in production deployment automation.

## Verification

Tests must prove approval, rejection, quarantine, replay, immutable receipts,
owner and target isolation, resolution prerequisites, CSRF binding, exact
review display, and zero accepted-memory writes. Live verification must confirm
the owner page, flag state, anonymous denial, and accepted generation `0`.
