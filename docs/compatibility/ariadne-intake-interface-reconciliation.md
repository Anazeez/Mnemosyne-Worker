# Ariadne Intake Interface Compatibility Report

## Review boundary

- Repository: `Anazeez/Mnemosyne-Worker`
- Repair baseline: `9fc4c5cc06b7455051ee089607f23b0835dbb269`
- Branch: `codex/mnemosyne-worker-interface-reconciliation`
- Change classification: compatible error-handling correction plus additive tests and documentation
- Evidence classification: observed at the immutable repair baseline and locally verified on this branch
- Canonical standing: not granted by this report
- Activation: withheld
- Deployment: not performed

The immutable commit is the explicitly approved baseline for this repair
branch. That approval does not make the implementation a canonical Pulse
binding and does not authorize activation or deployment.

## Interface comparison

The observed consumer envelope and the Worker provider are compatible:

| Field | Consumer | Provider result |
|---|---|---|
| `title` | string | accepted; required after trimming |
| `content` | string | accepted; required after trimming |
| `source` | `obsidian-plugin` | accepted and forwarded as proposal context |
| `metadata.vaultPath` | string | accepted as metadata |
| `metadata.originalLocation` | string | accepted as metadata |
| `reviewFirst` | `true` | required exactly |

The successful provider response contains `reviewFirst: true`,
`mutated: false`, and a proposal with `classification`, `summary`,
`proposedDestination`, `proposedTags`, `proposedLinks`, and `warnings`.

## Reconciliation performed

The baseline route allowed established roles with
`ariadne.core.openai_test`, but an established role without that capability
caused an authorization exception to escape the route handler. The repair
catches the existing authorization error and returns the same structured HTTP
403 JSON contract already used by sibling Ariadne endpoints.

No capability was added, removed, renamed, granted, or denied. No route was
added, removed, or redirected. No storage, production data, binding, runtime
activation, deployment configuration, or external repository was changed.

## Verification

The local deterministic suite verifies:

- the observed consumer envelope produces the expected review-first,
  non-mutating response;
- unauthenticated requests are rejected before any upstream call;
- `reviewFirst: false` is rejected before any upstream call;
- baseline grants for `specialist` and `orchestrator` remain effective;
- baseline denials for `portal`, `dashboard`, and `inspector` remain effective
  and return structured 403 responses;
- upstream rejection and malformed proposal output remain contained as 502
  responses;
- the complete effective role-capability projection equals the approved
  baseline fixture; and
- every route represented at the approved baseline remains represented.

The upstream model call is replaced by a deterministic local stub. Tests do
not connect to production data or external services.

## Result

`compatibility_result: passed`

This result establishes local semantic compatibility only. Successful tests do
not grant canonical standing, activate a binding, authorize a deployment, or
transfer authority.
