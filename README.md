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
| POST | `/api/ariadne/core/intake` | ✓ | Generate a review-first proposal without mutating vault content |

### Ariadne intake contract

`POST /api/ariadne/core/intake` accepts `title`, `content`, optional `source`
and `metadata`, and the mandatory flag `reviewFirst: true`. A successful
response always reports `reviewFirst: true` and `mutated: false`, and returns a
proposal for human review. The route does not activate a binding or authorize
any file, vault, or production-data mutation.

## Equilibrium Law

Layer 0 (canon/git) is eternal.  
Layer 1 (Vectorize/D1) is shadow — disposable, rebuildable on demand.  
Every probabilistic answer must cite canonical path + SHA-256.

## Model

`@cf/baai/bge-large-en-v1.5` — 1024 dims, cosine, threshold: 0.85
