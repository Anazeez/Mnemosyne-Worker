# Mnemosyne-Worker Clean Baseline Reconstruction Design

## Authority and stopping point

This design records the explicit 2026-07-14 Strategy C directive for
Mnemosyne-Worker. Work starts from GitHub `main` at
`a60fc378665b19b23146bdd1eb4c104b38daea25` and stops at a separate draft pull
request. PR #1 remains draft, unmerged, undeployed, and unchanged as historical
evidence.

No merge, deployment, binding activation, production-data mutation, Pulse
change, runner work, plugin work, or effective privilege approval is part of
this branch.

## Reconstruction model

The branch reconstructs reviewed behavior as new commits. It does not merge,
rebase, cherry-pick, or otherwise preserve the unsafe 18-commit ancestry.

The final review tree may contain:

- provenance-backed evidence documents;
- proposed dashboard role, authentication, capability, and minimized overview;
- proposed Ariadne capability grants;
- review-first intake and review routes with structured authorization;
- a minimized Ariadne status route;
- a bounded provider diagnostic route;
- deterministic regression tests; and
- generated-state ignore rules.

It must not contain the logs route, generated Wrangler state, local databases,
caches, bundles, source maps, archived production snapshots, raw provider
errors, unverifiable artifacts, or new copies of protected identifiers.

## Privilege standing

All new role-capability relationships are proposals requiring individual
approval. The implementation makes root grants explicit so new capabilities
cannot enter root authority merely through `Object.values(CAPABILITY)`.

Each proposed relationship has a separate declaration under
`docs/proposals/privileges/`. A declaration provides review evidence; it does
not grant standing, activation, or deployment authority.

## Runtime contracts

Dashboard overview performs only bounded `SELECT COUNT(*)` queries and returns
aggregate counts. It returns no record identifiers, titles, actor identifiers,
binding inventory, endpoint, or infrastructure configuration.

Ariadne intake and review require `reviewFirst: true`, validate bounded JSON
shapes, call the provider through a fixed public API boundary, and return
`mutated: false`. Authentication and authorization failures are structured
HTTP responses.

Ariadne status returns only service mode and non-mutation guarantees. It does
not report provider configuration, model, routes, credentials, requestor
identity, or infrastructure bindings.

Provider diagnostics return bounded internal error codes. Upstream bodies,
headers, stack traces, credentials, models, identifiers, and endpoints are
never returned.

## Verification model

Node's built-in test runner loads the Worker directly and replaces external
provider and D1 boundaries with deterministic fakes. Tests compare the complete
effective role policy with an immutable main fixture, represent grants and
denials separately, preserve every main route, exercise authentication and
authorization failures, verify consumer envelopes, prove dashboard SQL is
read-only, reject raw diagnostic leakage, and scan the Git tree for prohibited
generated state.

Final verification includes syntax validation, the full test suite, ancestry
verification against GitHub main, protected-identifier non-duplication, and a
reverse-order rollback rehearsal of every reconstruction commit.
