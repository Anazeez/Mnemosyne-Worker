# Ariadne Intake Interface Reconciliation Rollback

## Recorded state

- Baseline commit: `9fc4c5cc06b7455051ee089607f23b0835dbb269`
- Framework branch: `codex/mnemosyne-worker-interface-reconciliation`
- Historical plan: `docs/superpowers/plans/2026-07-14-ariadne-intake-interface-reconciliation.md`
- Production deployment performed: no
- Binding activation performed: no
- Production data modified: no
- Persona privilege change performed: no

## Added files

- `docs/compatibility/ariadne-intake-interface-reconciliation.md`
- `docs/rollback/ariadne-intake-interface-reconciliation.md`
- `docs/superpowers/plans/2026-07-14-ariadne-intake-interface-reconciliation.md`
- `test/ariadne-intake.test.mjs`
- `test/baseline-regression.test.mjs`
- `test/fixtures/worker-baseline.json`
- `test/helpers/load-worker.mjs`

## Modified files

- `README.md`
- `src/index.js`

## Revert procedure

Identify the reconciliation commit in the draft pull request, then create a
new review branch from the target branch and run:

```bash
git revert <reconciliation-commit-sha>
node --input-type=module --check < src/index.js
node --test test/*.test.mjs
```

If the test files are intentionally reverted with the implementation, verify
the restored baseline directly:

```bash
git diff --exit-code 9fc4c5cc06b7455051ee089607f23b0835dbb269 -- src/index.js README.md
```

The implementation plan and compatibility report are historical audit
evidence. A rollback should reference them in its review record rather than
rewriting or deleting previously published evidence.
