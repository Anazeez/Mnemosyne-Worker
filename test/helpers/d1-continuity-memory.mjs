function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class ContinuityMemoryD1 {
  constructor() {
    this.runways = new Map();
    this.heads = new Map();
    this.validations = new Map();
    this.receipts = new Map();
    this.attempts = new Map();
    this.invalidations = new Map();
    this.invocations = new Map();
    this.records = [];
    this.failures = new Map();
  }

  failNext(operation, count = 1) {
    this.failures.set(operation, count);
    return this;
  }

  consumeFailure(operation) {
    const remaining = this.failures.get(operation) || 0;
    if (remaining <= 0) return;
    if (remaining === 1) this.failures.delete(operation);
    else this.failures.set(operation, remaining - 1);
    throw new Error(`Injected D1 failure: ${operation}`);
  }

  seedRunway(row) {
    this.runways.set(row.runway_id, clone(row));
    return this;
  }

  seedHead(row) {
    this.heads.set(
      headKey(row.identity_id, row.project_id, row.scope_key),
      clone(row)
    );
    return this;
  }

  prepare(sql) {
    const operation = sql.match(/\/\*\s*continuity:([a-z0-9-]+)\s*\*\//i)?.[1];

    if (!operation) {
      throw new Error(`Unrecognized continuity SQL: ${sql.slice(0, 80)}`);
    }

    return new MemoryStatement(this, operation);
  }

  async batch(statements) {
    const snapshot = this.snapshot();

    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  snapshot() {
    return clone({
      runways: [...this.runways],
      heads: [...this.heads],
      validations: [...this.validations],
      receipts: [...this.receipts],
      attempts: [...this.attempts],
      invalidations: [...this.invalidations],
      invocations: [...this.invocations],
      records: this.records
    });
  }

  restore(snapshot) {
    this.runways = new Map(snapshot.runways);
    this.heads = new Map(snapshot.heads);
    this.validations = new Map(snapshot.validations);
    this.receipts = new Map(snapshot.receipts);
    this.attempts = new Map(snapshot.attempts);
    this.invalidations = new Map(snapshot.invalidations);
    this.invocations = new Map(snapshot.invocations);
    this.records = snapshot.records;
  }
}

class MemoryStatement {
  constructor(database, operation) {
    this.database = database;
    this.operation = operation;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const db = this.database;
    db.consumeFailure(this.operation);

    switch (this.operation) {
      case "get-head": {
        const [identityId, projectId, scopeKey] = this.values;
        return clone(db.heads.get(headKey(identityId, projectId, scopeKey)) || null);
      }
      case "get-runway":
        return clone(db.runways.get(this.values[0]) || null);
      case "get-idempotent": {
        const [credentialId, idempotencyKey] = this.values;
        return clone([...db.runways.values()].find(row =>
          row.created_by_credential_id === credentialId &&
          row.idempotency_key === idempotencyKey
        ) || null);
      }
      case "get-latest-validation": {
        const [runwayId] = this.values;
        const rows = [...db.validations.values()]
          .filter(row => row.runway_id === runwayId)
          .sort((left, right) => right.created_at.localeCompare(left.created_at));
        return clone(rows[0] || null);
      }
      case "get-genesis": {
        const [identityId, projectId] = this.values;
        return clone([...db.runways.values()].find(row =>
          row.identity_id === identityId &&
          row.project_id === projectId &&
          Number(row.generation) === 1 &&
          ["published", "superseded"].includes(row.state)
        ) || null);
      }
      case "get-backfilled": {
        const [identityId, projectId, scopeKey] = this.values;
        const rows = [...db.runways.values()].filter(row =>
          row.identity_id === identityId &&
          row.project_id === projectId &&
          row.scope_key === scopeKey &&
          row.context_status === "backfilled" &&
          ["published", "superseded"].includes(row.state)
        ).sort((left, right) => Number(right.generation) - Number(left.generation));
        return clone(rows[0] || null);
      }
      case "get-invalidation":
        return clone(db.invalidations.get(this.values[0]) || null);
      default:
        throw new Error(`Operation ${this.operation} does not support first()`);
    }
  }

  async all() {
    const db = this.database;
    db.consumeFailure(this.operation);

    switch (this.operation) {
      case "list-runway-records":
        return {
          results: clone(db.records.filter(row => row.runway_id === this.values[0]))
        };
      case "list-validations":
        return {
          results: clone([...db.validations.values()].filter(row =>
            row.runway_id === this.values[0]
          ))
        };
      case "list-invalidations":
        return {
          results: clone([...db.invalidations.values()].filter(row =>
            row.runway_id === this.values[0]
          ))
        };
      default:
        throw new Error(`Operation ${this.operation} does not support all()`);
    }
  }

  async run() {
    const db = this.database;
    db.consumeFailure(this.operation);

    switch (this.operation) {
      case "insert-runway": {
        const row = runwayFromValues(this.values);
        if (db.runways.has(row.runway_id)) {
          throw new Error("UNIQUE constraint failed: context_runways.runway_id");
        }
        const duplicate = [...db.runways.values()].find(existing =>
          existing.created_by_credential_id === row.created_by_credential_id &&
          existing.idempotency_key === row.idempotency_key
        );
        if (duplicate) {
          throw new Error("UNIQUE constraint failed: context_runways idempotency");
        }
        db.runways.set(row.runway_id, row);
        return changed(1);
      }
      case "insert-validation": {
        const row = validationFromValues(this.values);
        db.validations.set(row.validation_id, row);
        return changed(1);
      }
      case "set-runway-validation-state": {
        const [state, integrityState, completenessScore, validatedAt, runwayId] = this.values;
        const row = db.runways.get(runwayId);
        if (!row) return changed(0);
        Object.assign(row, {
          state,
          integrity_state: integrityState,
          completeness_score: completenessScore,
          validated_at: validatedAt
        });
        return changed(1);
      }
      case "insert-runway-record": {
        const [
          runwayId,
          recordId,
          domain,
          recordType,
          sourceRef,
          sourceHash,
          relation,
          ordinal,
          createdAt
        ] = this.values;
        db.records.push({
          runway_id: runwayId,
          record_id: recordId,
          domain,
          record_type: recordType,
          source_ref: sourceRef,
          source_hash: sourceHash,
          relation,
          ordinal,
          created_at: createdAt
        });
        return changed(1);
      }
      case "insert-retrieval-receipt": {
        const row = receiptFromValues(this.values);
        db.receipts.set(row.receipt_id, row);
        return changed(1);
      }
      case "insert-publication-attempt": {
        const row = publicationAttemptFromValues(this.values);
        db.attempts.set(row.attempt_id, row);
        return changed(1);
      }
      case "update-publication-attempt": {
        const [status, errorCode, errorMessage, completedAt, attemptId] = this.values;
        const row = db.attempts.get(attemptId);
        if (!row) return changed(0);
        Object.assign(row, {
          status,
          error_code: errorCode,
          error_message: errorMessage,
          completed_at: completedAt
        });
        return changed(1);
      }
      case "seal-runway": {
        const [sealedAt, indexingState, runwayId] = this.values;
        const row = db.runways.get(runwayId);
        if (!row || row.state !== "validated") return changed(0);
        Object.assign(row, {
          state: "sealed",
          sealed_at: sealedAt,
          indexing_state: indexingState
        });
        return changed(1);
      }
      case "set-indexing-state": {
        const [indexingState, state, runwayId] = this.values;
        const row = db.runways.get(runwayId);
        if (!row) return changed(0);
        Object.assign(row, { indexing_state: indexingState, state });
        return changed(1);
      }
      case "set-artifact-ref": {
        const [artifactRef, runwayId] = this.values;
        const row = db.runways.get(runwayId);
        if (!row) return changed(0);
        row.portable_artifact_ref = artifactRef;
        return changed(1);
      }
      case "set-publication-failed": {
        const [indexingState, runwayId] = this.values;
        const row = db.runways.get(runwayId);
        if (!row || row.state === "published") return changed(0);
        Object.assign(row, {
          state: "publication_failed",
          indexing_state: indexingState
        });
        return changed(1);
      }
      case "publish-head-cas": {
        const [
          identityId,
          projectId,
          scopeKey,
          runwayId,
          generation,
          manifestHash,
          publishedAt,
          expectedGeneration,
          expectedPredecessor
        ] = this.values;
        const key = headKey(identityId, projectId, scopeKey);
        const current = db.heads.get(key) || null;
        const matches = current
          ? Number(current.generation) === Number(expectedGeneration) &&
            current.runway_id === expectedPredecessor
          : Number(expectedGeneration) === 0 && expectedPredecessor === null;
        if (!matches) return changed(0);

        if (current && current.runway_id !== runwayId) {
          const predecessor = db.runways.get(current.runway_id);
          if (predecessor?.state === "published") predecessor.state = "superseded";
        }
        const row = db.runways.get(runwayId);
        if (row) {
          row.state = "published";
          row.published_at = publishedAt;
        }
        db.heads.set(key, {
          identity_id: identityId,
          project_id: projectId,
          scope_key: scopeKey,
          runway_id: runwayId,
          generation,
          manifest_hash: manifestHash,
          published_at: publishedAt
        });
        return changed(1);
      }
      case "invalidate-runway": {
        const [invalidatedAt, reason, runwayId] = this.values;
        const row = db.runways.get(runwayId);
        if (!row) return changed(0);
        const wasPublished = row.state === "published";
        Object.assign(row, {
          state: "invalidated",
          invalidated_at: invalidatedAt,
          invalidation_reason: reason
        });
        if (wasPublished) {
          const key = headKey(row.identity_id, row.project_id, row.scope_key);
          const current = db.heads.get(key);
          if (current?.runway_id === row.runway_id) {
            if (row.predecessor_runway_id) {
              const predecessor = db.runways.get(row.predecessor_runway_id);
              if (predecessor) {
                predecessor.state = "published";
                db.heads.set(key, {
                  identity_id: predecessor.identity_id,
                  project_id: predecessor.project_id,
                  scope_key: predecessor.scope_key,
                  runway_id: predecessor.runway_id,
                  generation: predecessor.generation,
                  manifest_hash: predecessor.manifest_hash,
                  published_at: predecessor.published_at
                });
              }
            } else {
              db.heads.delete(key);
            }
          }
        }
        return changed(1);
      }
      case "restore-head-cas": {
        const [
          runwayId,
          generation,
          manifestHash,
          publishedAt,
          identityId,
          projectId,
          scopeKey,
          expectedCurrent
        ] = this.values;
        const key = headKey(identityId, projectId, scopeKey);
        const current = db.heads.get(key);
        if (!current || current.runway_id !== expectedCurrent) return changed(0);
        const restored = db.runways.get(runwayId);
        if (restored) restored.state = "published";
        db.heads.set(key, {
          identity_id: identityId,
          project_id: projectId,
          scope_key: scopeKey,
          runway_id: runwayId,
          generation,
          manifest_hash: manifestHash,
          published_at: publishedAt
        });
        return changed(1);
      }
      case "delete-head-if-current": {
        const [identityId, projectId, scopeKey, expectedCurrent] = this.values;
        const key = headKey(identityId, projectId, scopeKey);
        const current = db.heads.get(key);
        if (!current || current.runway_id !== expectedCurrent) return changed(0);
        db.heads.delete(key);
        return changed(1);
      }
      case "insert-invalidation": {
        const row = invalidationFromValues(this.values);
        db.invalidations.set(row.invalidation_id, row);
        return changed(1);
      }
      default:
        throw new Error(`Operation ${this.operation} does not support run()`);
    }
  }
}

function runwayFromValues(values) {
  const fields = [
    "runway_id",
    "schema_version",
    "identity_id",
    "project_id",
    "scope_key",
    "predecessor_runway_id",
    "source_invocation_id",
    "generation",
    "state",
    "context_status",
    "objective",
    "summary",
    "payload_json",
    "manifest_hash",
    "source_hashes_json",
    "integrity_state",
    "completeness_score",
    "created_by_credential_id",
    "idempotency_key",
    "portable_artifact_ref",
    "indexing_state",
    "created_at"
  ];

  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}

function validationFromValues(values) {
  const fields = [
    "validation_id",
    "runway_id",
    "validator_credential_id",
    "status",
    "errors_json",
    "warnings_json",
    "completeness_score",
    "receipt_hash",
    "created_at"
  ];

  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}

function receiptFromValues(values) {
  const fields = [
    "receipt_id",
    "requesting_credential_id",
    "identity_id",
    "project_id",
    "scope_key",
    "selected_runway_id",
    "selected_generation",
    "context_status",
    "fallback_path_json",
    "requested_domains_json",
    "permitted_domains_json",
    "supplemental_search_used",
    "supplemental_result_count",
    "omissions_json",
    "receipt_hash",
    "created_at"
  ];

  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}

function publicationAttemptFromValues(values) {
  const fields = [
    "attempt_id",
    "runway_id",
    "expected_generation",
    "observed_generation",
    "status",
    "error_code",
    "error_message",
    "created_at",
    "completed_at"
  ];
  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}

function invalidationFromValues(values) {
  const fields = [
    "invalidation_id",
    "runway_id",
    "invalidated_by_credential_id",
    "reason",
    "previous_head_runway_id",
    "restored_head_runway_id",
    "created_at",
    "receipt_hash"
  ];
  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}

function headKey(identityId, projectId, scopeKey) {
  return `${identityId}\u0000${projectId}\u0000${scopeKey}`;
}

function changed(changes) {
  return { success: true, meta: { changes } };
}
