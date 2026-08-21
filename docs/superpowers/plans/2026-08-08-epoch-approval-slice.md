# Mnemosyne epoch compaction and approval adapter

## Objective

Complete the save-file boundary for bounded resume: compile accepted handoffs
into a provenance-preserving epoch candidate, require explicit owner approval
through MCP before accepting it, and archive covered records in the same D1
acceptance transaction without deleting lineage history.

## Tasks

- [x] Add a deterministic epoch compiler and accepted-scope compaction service.
- [x] Archive epoch-covered accepted handoffs atomically during acceptance and
      preserve idempotent replay behavior.
- [x] Add a dedicated owner acceptance capability, rollout flag, and
      `handoff.accept` MCP tool that verifies the exact proposed draft/hash.
- [x] Add focused contract, compaction, policy, flag, MCP, and integration
      tests; update deployment metadata and operational documentation.
- [x] Run focused and full verification, including the exact MCP SDK overlay,
      then record residual deployment/migration limits.

## Acceptance

- An epoch contains source handoff IDs, bounded summaries, provenance, and
  deterministic truncation/conflict markers when its input reaches limits.
- Epoch acceptance archives only the explicitly covered accepted handoffs,
  never deletes them, and replaying the same receipt is idempotent.
- A portal principal cannot accept; an owner must use the exact proposed
  `local_draft`, confirmation ID, payload hash, credential, and receipt.
- MCP exposes read-only `handoff.compact` and `handoff.propose` as pending
  confirmation paths; `handoff.accept` is the only adapter that can perform
  the governed acceptance transition.
- All tests pass locally; no remote migration, deployment, or memory write is
  performed by this slice.
