# Mnemosyne-Worker

> الأصل نصٌّ والبقية ظلال

**Role:** Governed shared memory and signed private specialist-mesh persistence
**Worker:** `mnemosyne-worker.izeesub.workers.dev`  
**Auth:** OAuth 2.1 primary; D1-backed HMAC compatibility during migration

## Matrix Indexes

| Binding | Index | Purpose |
|---|---|---|
| `MATRIX_KNOWLEDGE` | `mnemosyne-knowledge` | Doctrine, protocols, runtime |
| `MATRIX_AGENTS` | `mnemosyne-agents` | Roles, specialist DNA |
| `MATRIX_SKILLS` | `mnemosyne-skills` | Capability maps |
| `MATRIX_FILES` | `mnemosyne-files` | Artifacts, session outputs |

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/ping` | ✗ | Health check |
| GET | `/openapi.json` | ✗ | Custom GPT Actions contract |
| GET | `/v1/identity` | Matrix key | Return only the key-bound specialist identity and bounded grants |
| GET | `/v1/session` | OAuth specialist | Return only the token-bound specialist identity and bounded grants |
| POST | `/v1/mesh/messages` | signed gateway | Accept one bounded mesh envelope |
| GET | `/v1/mesh/inbox` | OAuth specialist | Read the caller's private inbox |
| POST | `/hash` | ✓ | Compute SHA-256 before ingest |
| POST | `/ingest` | ✓ | Validate + embed + upsert |
| POST | `/query` | ✓ | Semantic search |

## Governed shared graph memory

The Worker now contains an OAuth 2.1, tenant-scoped graph-memory surface.
Deployment remains progressive and default-off. The public contract contains
the five governed memory operations, public `checkHealth`, and a specialist-only
private mesh inbox. Assistants cannot review, resolve, publish, invalidate,
delete, export, or repair projections.

## Specialist mesh and email boundary

The Worker accepts only HMAC-signed `mnemosyne.mesh.v1` envelopes at
`/v1/mesh/messages`. Message IDs are idempotent, root-local exchanges stay
private, and only cleared security preflights may enter `running`. A blocked
message requires an explicit Architectus override record.

Direct Cloudflare Email Routing delivery to this Worker is deliberately
rejected. Email must terminate at the standalone `mnemosyne-mail-gateway`,
which authenticates the sender, applies Synn preflight, normalizes attachments,
and signs the bounded mesh envelope. The Worker does not archive raw MIME,
mirror mail to Gmail, or read plaintext per-persona passwords.

See [graph-memory operations](docs/graph-memory-operations.md) for flags,
deployment order, recovery, and the D1-authoritative privacy model.

## Reconstructed review surface

The following routes are proposed; not active. Their presence on a review
branch does not approve privileges, activate a binding, or authorize a
deployment.

| Method | Path | Proposed purpose |
|---|---|---|
| GET | `/v1/dashboard/overview` | Return read-only aggregate counts without record identifiers |
| POST | `/api/ariadne/core/intake` | Produce a review-first, non-mutating intake proposal |
| POST | `/api/ariadne/core/review` | Review existing content without mutation |
| GET | `/api/ariadne/core/status` | Return a minimized review-mode status |
| GET | `/api/ariadne/core/openai-test` | Return a bounded provider-reachability code |

The dashboard and Ariadne capability grants remain individually
approval-required. No Ariadne logs route is included.

## Deterministic contextual continuity review surface

MNEM-CONTINUITY-002 adds an exact D1 runway resolver before optional semantic
retrieval. The implementation is proposed on this review branch; it is not
deployed, activated, or bound by its presence in Git.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/continuity/latest` | Resolve and verify an exact runway head |
| POST | `/v1/continuity/rehydrate` | Build exact context, then optional supplemental evidence |
| POST | `/v1/continuity/checkpoints` | Create an immutable candidate |
| POST | `/v1/continuity/checkpoints/:id/validate` | Write a separate validation receipt |
| POST | `/v1/continuity/checkpoints/:id/publish` | Seal, index when required, and compare-and-swap the head |
| POST | `/v1/continuity/checkpoints/:id/invalidate` | Preserve history and restore an eligible predecessor |
| POST | `/v1/continuity/invocations/:id/complete` | Record changed, unchanged, or checkpoint-failed completion |
| GET | `/v1/continuity/history` | Audit bounded runway history |
| GET | `/v1/continuity/checkpoints/:id` | Audit a checkpoint and its lifecycle receipts |
| GET | `/v1/continuity/checkpoints/:id/validation` | Audit validation receipts |
| GET | `/v1/continuity/retrieval-receipts/:id` | Audit one retrieval decision |

All behavior is fail-closed behind explicit flags. No flag is enabled in
`wrangler.toml`, and no scheduled trigger is configured by this branch.

| Flag | Effect when explicitly enabled |
|---|---|
| `CONTINUITY_READ_ENABLED` | Permit exact resolution and rehydration |
| `CONTINUITY_WRITE_ENABLED` | Permit candidates and invocation completion |
| `CONTINUITY_SHADOW_MODE` | Compare exact context with legacy evidence without changing behavior |
| `CONTINUITY_PUBLICATION_ENABLED` | Permit sealing, publication, and invalidation |
| `CONTINUITY_INVOCATION_ENFORCEMENT` | Require a valid continuity receipt at specialist invocation boundaries |
| `CONTINUITY_SCHEDULED_VERIFICATION` | Run configured scheduled integrity verification; no cron is added here |
| `CONTINUITY_OBSIDIAN_ACTIONS` | Permit explicit reviewed Obsidian continuity submissions |

`CONTINUITY_INDEX_REQUIRED` and `CONTINUITY_ARTIFACT_REQUIRED` are publication
quality gates: when enabled, either failure prevents head advancement. Backfill
uses `scripts/backfill-context-runways.mjs` in dry-run mode unless `--apply` is
supplied with runtime API credentials. Rollback disables enforcement and
publication while preserving tables, checkpoints, heads, and receipts.

## Equilibrium Law

Layer 0 (canon/git) is eternal.  
Layer 1 (Vectorize/D1) is shadow — disposable, rebuildable on demand.  
Every probabilistic answer must cite canonical path + SHA-256.

## Model

`@cf/baai/bge-large-en-v1.5` — 1024 dims, cosine, threshold: 0.85
