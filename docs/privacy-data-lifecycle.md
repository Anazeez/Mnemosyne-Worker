# Mnemosyne privacy data lifecycle

Mnemosyne keeps accepted graph memory in tenant- and project-scoped D1
records. Vectorize is a rebuildable retrieval projection, never the authority.
OAuth clients can read accepted memory, search, propose candidates, and read
their own candidate status. They cannot export or erase a scope, repair a
projection, review a candidate, or publish accepted memory.

## Export

The internal `memory.export` capability may export a bounded tenant, project,
identity, or candidate scope. Exports contain accepted canonical entities,
relations, events, assertions, provenance metadata, decisions, citations, and
content hashes. They exclude access credentials, provider tokens, raw provider
payloads, evidence excerpts, producer credential identifiers, and private
reasoning.

## Deletion

The internal `memory.delete` capability writes a pseudonymous deletion receipt
before erasure. The receipt retains only the scope kind, hashes of the scope,
requesting credential, and projection IDs, aggregate row counts, timestamps,
and projection status. It does not retain deleted content or literal tenant,
project, identity, candidate, or credential identifiers.

Authoritative rows are removed in dependency order. Known Vectorize projection
IDs are then deleted in bounded batches. If projection deletion fails,
authoritative deletion remains final, the receipt records `repair_queued`, and
the configured reconciliation queue receives only the receipt identifier.

## Projection repair

The internal `memory.projection.rebuild` capability reads accepted canonical
D1 records, creates fresh embeddings in bounded batches, and upserts only
tenant ID, project ID, record type, stable projection ID, and vector values.
Candidate, quarantined, rejected, superseded, and deleted records are excluded.

## Retention and recovery

Candidates and accepted facts remain immutable until an authorized privacy
deletion. Snapshots and decisions support forward rollback of publication;
they are not backups after an authorized deletion. A deletion is intentionally
irreversible except through a new, independently authorized ingestion from
retained source evidence.
