# Truth-First Memory Retrieval

## Problem

Accepted memory is authoritative in D1, but a compound query can miss it until
the asynchronous FTS and Vectorize projections are repaired. A no-match response
also reports generation `0`, even when the project already has accepted memory.

## Approved amendment

1. Keep D1 as the source of truth and match normalized query terms across the
   combined accepted assertion label, predicate, and object.
2. Require every query term for this deterministic cross-field fallback, while
   preserving exact literal matches and FTS ranking.
3. Report the project's maximum accepted generation independently of search
   matches.
4. After an owner-controlled commit, schedule projection repair through
   `waitUntil`. Projection failure remains repairable and cannot roll back or
   invalidate the canonical commit.

## Boundaries

- Retrieval remains tenant- and project-scoped.
- Only accepted assertions are searchable.
- Candidate, validation, resolution, review, and owner-controlled commit stages
  remain unchanged.
- No new assistant capability or implicit write privilege is introduced.

## Verification

- A query spanning label and object returns the accepted assertion without
  relying on projections.
- A no-match query returns no assertions and the correct project generation.
- A controlled commit schedules and completes both FTS and Vectorize projection.
- Existing graph-memory and OAuth tests remain green.
