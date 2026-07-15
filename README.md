# Mnemosyne-Worker

> الأصل نصٌّ والبقية ظلال

**Role:** Vector memory layer for Project Infinitum  
**Worker:** `mnemosyne-worker.izeesub.workers.dev`  
**Auth:** `X-Matrix-Key` header  

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
| POST | `/hash` | ✓ | Compute SHA-256 before ingest |
| POST | `/ingest` | ✓ | Validate + embed + upsert |
| POST | `/query` | ✓ | Semantic search |

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

## Equilibrium Law

Layer 0 (canon/git) is eternal.  
Layer 1 (Vectorize/D1) is shadow — disposable, rebuildable on demand.  
Every probabilistic answer must cite canonical path + SHA-256.

## Model

`@cf/baai/bge-large-en-v1.5` — 1024 dims, cosine, threshold: 0.85
