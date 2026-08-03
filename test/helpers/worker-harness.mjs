import { createHmac } from "node:crypto";

let workerPromise;
const TEST_LEGACY_KEY = "test-key-with-at-least-twenty";
const TEST_LEGACY_PEPPER = "p".repeat(32);
const TEST_LEGACY_HASH = "79046a3a12d1e479608b0e3a78bb8da08ed48d6b65dc3dd9c65e826c4c230bce";

export function loadWorker() {
  if (!workerPromise) {
    workerPromise = import(new URL("../../src/index.js", import.meta.url))
      .then(module => module.default);
  }

  return workerPromise;
}

export function scopedEnvironment(role, overrides = {}) {
  const requestedRecord = extractRequestedRecord(overrides.MATRIX_PRINCIPAL_KEYS);
  const { MATRIX_PRINCIPAL_KEYS: _ignored, MNEMOSYNE_PRINCIPAL_KEYS: _alsoIgnored, ...clean } = overrides;
  if (role === "root") {
    return { MATRIX_AUTH_KEY: TEST_LEGACY_KEY, ...clean };
  }
  if (role === "dashboard") {
    return { MATRIX_DASHBOARD_KEY: TEST_LEGACY_KEY, ...clean };
  }
  const profile = testSpecialistProfile(role, requestedRecord);
  return {
    ...clean,
    LEGACY_CREDENTIAL_PEPPER: TEST_LEGACY_PEPPER,
    DB: legacyCredentialDatabase(clean.DB, new Map([[TEST_LEGACY_HASH, profile]])),
  };
}

export function migrateTestPrincipalEnvironment(environment) {
  const records = environment.MATRIX_PRINCIPAL_KEYS
    ?? environment.MNEMOSYNE_PRINCIPAL_KEYS
    ?? {};
  const entries = Array.isArray(records)
    ? records.map((record) => [record.key ?? record.action_key, record])
    : Object.entries(records);
  const profiles = new Map();
  let privilegedKey = null;
  for (const [rawKey, record] of entries) {
    const role = String(record?.principal_id ?? record?.role ?? "").toLowerCase();
    if (["root", "orchestrator", "inspector"].includes(role)) {
      privilegedKey ??= rawKey;
    } else {
      profiles.set(testHash(rawKey), testProfileFromRecord(record));
    }
  }
  const {
    MATRIX_PRINCIPAL_KEYS: _ignored,
    MNEMOSYNE_PRINCIPAL_KEYS: _alsoIgnored,
    DB: delegate,
    ...rest
  } = environment;
  return {
    ...rest,
    ...(privilegedKey ? { MATRIX_AUTH_KEY: privilegedKey } : {}),
    LEGACY_CREDENTIAL_PEPPER: TEST_LEGACY_PEPPER,
    DB: legacyCredentialDatabase(delegate, profiles),
  };
}

export function authenticatedRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("X-Matrix-Key", TEST_LEGACY_KEY);

  return new Request(`https://worker.invalid${path}`, {
    ...options,
    headers
  });
}

function testSpecialistProfile(role, requestedRecord) {
  const known = ["ariadne", "haava", "hearken", "nadeem", "savae", "synn", "vitruvius"];
  const specialistId = known.includes(role)
    ? role
    : role === "specialist"
      ? "ariadne"
      : role === "orchestrator"
        ? "savae"
        : "haava";
  const domains = {
    ariadne: "logic-trend-analysis",
    hearken: "software-formal-logic",
    nadeem: "professional-communication",
    savae: "mesh-orchestration",
    synn: "security-compliance-preflight",
    haava: "visual-design-expression",
    vitruvius: "ui-ux-full-stack",
  };
  const extra = {
    ariadne: ["analysis.current-sources", "ariadne.core.openai_test"],
    hearken: ["engineering.execute"],
    nadeem: ["communication.draft"],
    savae: ["mandates.dispatch", "mandates.status"],
    synn: ["security.preflight", "security.alarm"],
    haava: ["visual.produce"],
    vitruvius: ["ui.execute"],
  };
  const projectIds = normalizeProjects(
    requestedRecord?.project_ids ?? ["project-infinitum"],
  );
  return {
    credential_id: requestedRecord?.credential_id ?? specialistId,
    principal_id: `principal-${specialistId}`,
    specialist_id: specialistId,
    tenant_id: "personal",
    project_ids_json: JSON.stringify(projectIds),
    domain_ids_json: JSON.stringify([domains[specialistId]]),
    memory_domains_json: JSON.stringify(
      requestedRecord?.memory_domains ?? ["knowledge", "agents", "skills", "files", "library"],
    ),
    capabilities_json: JSON.stringify([
      "memory.read",
      "memory.search",
      "memory.propose",
      "continuity.read",
      "continuity.write",
      "exchanges.inbox",
      "exchanges.reply",
      ...extra[specialistId],
    ]),
    lane_permissions_json: JSON.stringify(["root-local", "savae-routed"]),
    grant_version: "d".repeat(64),
  };
}

function legacyCredentialDatabase(delegate, profiles) {
  return {
    prepare(sql) {
      if (/FROM legacy_credentials/u.test(sql)) {
        return {
          bind(hash) {
            return {
              async first() {
                const profile = profiles.get(hash);
                return profile ? { ...profile } : null;
              },
            };
          },
        };
      }
      if (!delegate?.prepare) throw new Error(`Unrecognized test SQL: ${sql.slice(0, 80)}`);
      return delegate.prepare(sql);
    },
    async batch(statements) {
      if (!delegate?.batch) throw new Error("Test DB batch unavailable");
      return delegate.batch(statements);
    },
  };
}

function testProfileFromRecord(record) {
  const requestedId = String(record?.credential_id ?? record?.identity ?? "").toLowerCase();
  const canonicalIds = new Set([
    "ariadne", "haava", "hearken", "nadeem", "savae", "synn", "vitruvius",
  ]);
  const specialistId = canonicalIds.has(requestedId) ? requestedId : "haava";
  const profile = testSpecialistProfile(specialistId, record);
  return {
    ...profile,
    credential_id: requestedId || specialistId,
    principal_id: `principal-${specialistId}`,
    specialist_id: specialistId,
    tenant_id: String(record?.tenant_id ?? "personal").toLowerCase(),
  };
}

function testHash(rawKey) {
  return createHmac("sha256", TEST_LEGACY_PEPPER)
    .update(String(rawKey ?? ""))
    .digest("hex");
}

function extractRequestedRecord(records) {
  if (!records || typeof records !== "object") return null;
  if (Array.isArray(records)) return records[0] ?? null;
  return Object.values(records)[0] ?? null;
}

function normalizeProjects(values) {
  return [...new Set((values ?? [])
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9._-]{1,63}$/u.test(value)))];
}

export async function withStubbedFetch(stub, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function providerChatResponse(content, options = {}) {
  const {
    status = 200,
    finishReason = "stop",
    refusal
  } = options;
  const message = {
    content: typeof content === "string" ? content : JSON.stringify(content)
  };

  if (refusal !== undefined) {
    message.refusal = refusal;
  }

  return new Response(JSON.stringify({
    choices: [{ message, finish_reason: finishReason }]
  }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
