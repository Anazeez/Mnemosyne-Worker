#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function buildBackfillRequests(records) {
  if (!Array.isArray(records)) {
    throw new Error("Backfill manifest must be an array");
  }

  return records.map((record, index) => {
    const identityId = boundedId(record.identity_id, "identity_id");
    const projectId = boundedId(record.project_id, "project_id", true);
    const scopeKey = boundedScope(record.scope_key);
    const missingSources = Array.isArray(record.missing_sources)
      ? record.missing_sources.map(String).map(item => item.trim()).filter(Boolean)
      : [];

    return {
      identity_id: identityId,
      project_id: projectId,
      scope_key: scopeKey,
      predecessor_runway_id: record.predecessor_runway_id || null,
      source_invocation_id: boundedReference(
        record.source_invocation_id,
        "source_invocation_id"
      ),
      payload: {
        objective: boundedText(record.objective, "objective", 2_000),
        operational_state: boundedText(
          record.operational_state,
          "operational_state",
          8_000
        ),
        context_status: "backfilled",
        backfill_confidence: normalizeConfidence(record.confidence),
        decisions_in_force: array(record.decisions_in_force),
        open_threads: array(record.open_threads),
        next_actions: array(record.next_actions),
        mounted_skills: array(record.mounted_skills),
        relevant_agents: array(record.relevant_agents),
        relevant_files: array(record.relevant_files),
        knowledge_references: array(record.knowledge_references),
        library_references: array(record.library_references),
        pending_handoffs: array(record.pending_handoffs),
        constraints: array(record.constraints),
        prohibited_assumptions: array(record.prohibited_assumptions),
        integrity_warnings: missingSources
      },
      source_hashes: array(record.source_hashes),
      idempotency_key: `backfill:${identityId}:${projectId}:${scopeKey}:${index + 1}`,
      apply: false
    };
  });
}

export async function runBackfill({
  manifestPath,
  apply = false,
  apiUrl = process.env.CONTINUITY_API_URL,
  apiKey = process.env.CONTINUITY_API_KEY,
  fetchImpl = fetch,
  output = console.log
}) {
  const records = JSON.parse(await readFile(manifestPath, "utf8"));
  const requests = buildBackfillRequests(records);

  if (!apply) {
    output(JSON.stringify({
      mode: "dry-run",
      candidate_count: requests.length,
      candidates: requests.map(request => ({
        identity_id: request.identity_id,
        project_id: request.project_id,
        scope_key: request.scope_key,
        idempotency_key: request.idempotency_key,
        context_status: "backfilled"
      }))
    }, null, 2));
    return { mode: "dry-run", candidate_count: requests.length };
  }

  if (!apiUrl || !apiKey) {
    throw new Error(
      "--apply requires CONTINUITY_API_URL and CONTINUITY_API_KEY at runtime"
    );
  }

  const results = [];
  for (const request of requests) {
    const { apply: _ignored, ...body } = request;
    const response = await fetchImpl(
      `${String(apiUrl).replace(/\/+$/g, "")}/v1/continuity/checkpoints`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Matrix-Key": apiKey
        },
        body: JSON.stringify(body)
      }
    );
    results.push({
      identity_id: request.identity_id,
      project_id: request.project_id,
      scope_key: request.scope_key,
      status: response.status,
      ok: response.ok
    });
  }

  output(JSON.stringify({ mode: "apply", results }, null, 2));
  return { mode: "apply", results };
}

function array(value) {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function boundedId(value, field, allowDot = false) {
  const normalized = String(value || "").trim().toLowerCase();
  const pattern = allowDot
    ? /^[a-z0-9][a-z0-9._-]{1,63}$/
    : /^[a-z0-9][a-z0-9_-]{1,63}$/;
  if (!pattern.test(normalized)) throw new Error(`Invalid ${field}`);
  return normalized;
}

function boundedScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^(?:[a-z0-9][a-z0-9_-]{1,63}|(?:mandate|thread):[a-z0-9][a-z0-9_-]{1,63})$/.test(normalized)) {
    throw new Error("Invalid scope_key");
  }
  return normalized;
}

function boundedReference(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

function boundedText(value, field, maximum) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`Invalid ${field}`);
  return normalized;
}

function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(1, Math.max(0, parsed));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const manifestIndex = args.indexOf("--manifest");
  const manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : null;

  if (!manifestPath) {
    throw new Error("Usage: backfill-context-runways --manifest <file> [--apply]");
  }

  await runBackfill({ manifestPath, apply });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
