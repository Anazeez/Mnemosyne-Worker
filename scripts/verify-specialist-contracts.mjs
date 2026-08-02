#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SPECIALIST_CONTRACTS } from "../src/specialists/contracts.js";

export async function verifySpecialistContracts(pulsePath) {
  const registryPath = resolve(
    pulsePath,
    "registry/specialist-domains.yaml",
  );
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const pulseById = new Map(
    (registry.specialists ?? []).map((record) => [record.specialist_id, record]),
  );
  const failures = [];
  for (const [specialistId, runtime] of Object.entries(SPECIALIST_CONTRACTS)) {
    const pulse = pulseById.get(specialistId);
    if (!pulse) {
      failures.push({ code: "RUNTIME_PRINCIPAL_MISSING", specialist_id: specialistId });
      continue;
    }
    if (runtime.domain_ids.length !== 1 || runtime.domain_ids[0] !== pulse.domain_id) {
      failures.push({ code: "RUNTIME_DOMAIN_DRIFT", specialist_id: specialistId });
    }
    if (!equalSets(runtime.aliases, pulse.aliases ?? [])) {
      failures.push({ code: "RUNTIME_ALIAS_DRIFT", specialist_id: specialistId });
    }
    const approvedCapabilities = new Set(pulse.required_runtime_capabilities ?? []);
    const excessCapabilities = runtime.capabilities.filter(
      (capability) => !approvedCapabilities.has(capability),
    );
    const approvedLanes = new Set(pulse.lane_permissions ?? []);
    const excessLanes = runtime.lane_permissions.filter((lane) => !approvedLanes.has(lane));
    if (excessCapabilities.length > 0 || excessLanes.length > 0) {
      failures.push({
        code: "RUNTIME_GRANT_EXCEEDS_PULSE",
        specialist_id: specialistId,
        excess_capabilities: excessCapabilities.sort(),
        excess_lanes: excessLanes.sort(),
      });
    }
  }
  for (const specialistId of pulseById.keys()) {
    if (!(specialistId in SPECIALIST_CONTRACTS)) {
      failures.push({ code: "RUNTIME_PRINCIPAL_MISSING", specialist_id: specialistId });
    }
  }
  return {
    ok: failures.length === 0,
    pulse_registry: registryPath,
    runtime_specialists: Object.keys(SPECIALIST_CONTRACTS).length,
    pulse_specialists: pulseById.size,
    failures,
  };
}

function equalSets(left, right) {
  return JSON.stringify([...new Set(left)].sort())
    === JSON.stringify([...new Set(right)].sort());
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const pulsePath = argument("--pulse");
  if (!pulsePath) {
    console.error("Usage: node scripts/verify-specialist-contracts.mjs --pulse PATH");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifySpecialistContracts(pulsePath);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: "PULSE_REGISTRY_UNAVAILABLE" }));
      process.exitCode = 2;
    }
  }
}
