# Owner Memory Controlled Commit Design

**Status:** Approved

## Goal

Commit one resolved and owner-approved candidate into accepted project memory
without enabling general review or publication privileges.

## Contract

The separate owner-only browser route requires a fresh allowlisted GitHub
identity and a second one-time CSRF-bound confirmation. The domain operation
requires the exact immutable candidate, successful resolution receipt, and
`approve_for_commit` owner review receipt. Their payload and evidence hashes
must still match.

The canonical write is one D1 batch containing the pre-commit rollback
snapshot, resolved entities, evidence-linked assertions, acceptance decisions,
projection outbox, candidate state change, and append-only owner commit
receipt. The receipt binds all upstream receipts, accepted assertion IDs, and
the new generation. Candidate replay returns the original receipt.

## Isolation

`GRAPH_MEMORY_OWNER_COMMIT_ENABLED` is independent. Public OAuth, MCP, Actions,
general review, and general publication receive no commit capability.
Ambiguous or altered resolution, absent owner approval, wrong tenant/project,
non-owner identity, stale CSRF, or partial database failure fails closed.
