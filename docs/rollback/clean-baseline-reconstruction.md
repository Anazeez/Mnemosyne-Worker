# Clean Baseline Reconstruction Rollback

## Baseline

- Baseline commit: `a60fc378665b19b23146bdd1eb4c104b38daea25`
- Review branch: `codex/mnemosyne-worker-clean-baseline`
- Deployment performed: no
- Binding activation performed: no
- Production data modified: no

## Reconstruction commits

Revert in this order when rolling the complete proposal back:

1. `a5b280717f54ccca481ae6be899218efd1175823` — sanitized diagnostics
2. `1ad3a0bed6dbf23416063e8fce4071d79a68bc1f` — minimized status
3. `0e44a99bfa18727a6ace23058964cbde30ca48d5` — Ariadne review
4. `86ae726863038f59f5a7fd425f6e59d43ae46b99` — Ariadne intake
5. `e571793799274e5abe8f2d84e4d024b739e67e11` — dashboard overview
6. `cc1201138fa3abbb39a043c79f828ae2d03773b8` — proposed capabilities and grants
7. `064c394871cb1bd2020db065fd765de204f0eb61` — generated-state exclusions
8. `9c7ceb3f48be7993cfada80d041b469e079a24ef` — provenance and proposal evidence

Use a disposable review branch and run one `git revert <sha>` per entry in the
listed order. After every revert, run:

```bash
node --input-type=module --check < src/index.js
```

After the final revert, verify exact restoration:

```bash
git diff --exit-code a60fc378665b19b23146bdd1eb4c104b38daea25..HEAD
```

Rollback evidence should be appended to a new review record. Historical pull
request and compatibility evidence must not be rewritten or deleted.
