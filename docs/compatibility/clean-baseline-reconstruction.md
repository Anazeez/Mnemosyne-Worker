# Clean Baseline Reconstruction Compatibility Report

## Evidence and standing

- Repository: `Anazeez/Mnemosyne-Worker`
- GitHub main baseline: `a60fc378665b19b23146bdd1eb4c104b38daea25`
- Branch: `codex/mnemosyne-worker-clean-baseline`
- Evidence classification: observed at the immutable main commit and locally verified on this branch
- Canonical standing: not granted
- Privilege approval: withheld for every proposed relationship
- Binding activation: withheld
- Deployment: not performed

The branch reconstructs behavior directly from GitHub main. None of the unsafe
18-commit ancestry was merged, cherry-picked, rebased, or preserved as branch
history.

## Exact proposed policy difference

The complete main policy is recorded in `test/fixtures/main-policy.json`. The
only proposed grants are:

- `root` → `ariadne.core.openai_test`;
- `root` → `dashboard.overview`;
- `orchestrator` → `ariadne.core.openai_test`;
- `specialist` → `ariadne.core.openai_test`; and
- `dashboard` → `dashboard.overview`.

Each relationship has a distinct proposal record with
`approval_required: true`. Missing capabilities remain absences, not explicit
prohibitions. Portal and inspector policies remain byte-for-byte equivalent in
their semantic projections.

## Runtime compatibility

Every route represented at main remains represented. Five proposed routes are
added and `/api/ariadne/core/logs` is deliberately absent.

Dashboard overview uses two bounded `SELECT COUNT(*)` statements and returns
only aggregate counts. Intake and review accept the observed review-first
consumer shapes and return `mutated: false`. Status returns an exact minimized
object. Diagnostics never reflect upstream bodies or local provider settings.

## Exclusions

The branch contains no generated Wrangler state, local SQLite state, cache,
bundle, source map, archived production source snapshot, raw provider error,
logs route, obsolete model-selection history, or unavailable source artifact.

No new account-style identifier is present outside the inherited main source.
The inherited source was not copied into evidence, fixtures, reports, or
generated artifacts.

## Compatibility result

`local_semantic_compatibility: passed`

This result does not approve privileges, canonical standing, merge, binding
activation, deployment, or production endpoint testing.
