/**
 * Project Mnemosyne — Mnemosyne's Matrix (ROLE-BASED AUTHORIZATION)
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker:  mnemosyne-worker
 * Role:    Governed vector memory, role-authorized credentials,
 * mandate dispatch, and buffered persona-mesh ingress.
 * Model:   @cf/baai/bge-large-en-v1.5  (1024 dims, cosine)
 * Identity and authority model:
 * - Credential records identify a GPT through credential_id.
 * - Credential records assign authorization through principal_id (role).
 * - ROLE_POLICIES determines capabilities; credential metadata never grants them.
 * - credential_id is used for inboxes, exchanges, mandates, telemetry, audits,
 * senders, recipients, and principal-specific routing.
 * - MATRIX_AUTH_KEY remains the human-owned root/bootstrap credential.
 */

// ─── Routing Table ────────────────────────────────────────────────────────────

const SECTION_ROUTING = {
  agents: [
    "names", "roles", "specialist", "destination",
    "registry", "haava", "boundary"
  ],

  knowledge: [
    "identity", "layer", "protocols", "handoff",
    "runtime", "automation", "doctrine"
  ],

  skills: [
    "skill", "capability", "ledger"
  ],

  files: [
    "artifact", "output", "session", "upload"
  ],

  library: [
    "book", "books", "pdf", "document", "documents",
    "source", "sources", "corpus", "well",
    "ingestion", "parse", "parser", "chunk",
    "manifest", "sha256", "path", "citation"
  ]
};

const INDEX_BINDING = {
  knowledge: "MATRIX_KNOWLEDGE",
  agents: "MATRIX_AGENTS",
  skills: "MATRIX_SKILLS",
  files: "MATRIX_FILES",
  library: "MATRIX_LIBRARY"
};

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
const RETRIEVAL_THRESHOLD = 0.65;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 25;
const MAX_INLINE_QUEUE_BYTES = 64_000;

const REQUIRED_FRONTMATTER_FIELDS = [
  "id",
  "title",
  "created",
  "status",
  "sha256",
  "parents",
  "sources",
  "tags",
  "schema"
];

const VALID_STATUS_VALUES = ["intake", "canon", "sealed"];

// ─── Capability Policy ────────────────────────────────────────────────────────

const CAPABILITY = Object.freeze({
  MEMORY_READ: "memory.read",
  MEMORY_SEARCH: "memory.search",
  MEMORY_INGEST: "memory.ingest",
  MEMORY_HASH: "memory.hash",

  SKILLS_RETRIEVAL: "skills.retrieval",
  HISTORY_RETRIEVAL: "history.retrieval",

  MANDATES_READ: "mandates.read",
  MANDATES_ACK: "mandates.ack",
  MANDATES_DRAFT: "mandates.draft",
  MANDATES_DISPATCH: "mandates.dispatch",

  EXCHANGES_ARTIFACT_READ_OWN: "exchanges.artifact.read.own",
  EXCHANGES_ARTIFACT_READ_ANY: "exchanges.artifact.read.any",

  CONTRACTS_DRAFT: "contracts.draft",

  ROUTER_STATUS: "router.status",

  EXCHANGES_ACK: "exchanges.ack",
  EXCHANGES_DISPATCH: "exchanges.dispatch",
  EXCHANGES_REPLY: "exchanges.reply",
  EXCHANGES_INBOX: "exchanges.inbox",
  EXCHANGES_HISTORY: "exchanges.history",

  REGISTRY_VIEW: "registry.view",
  ARIADNE_CORE_OPENAI_TEST: "ariadne.core.openai_test",
  DASHBOARD_OVERVIEW: "dashboard.overview"
});

const READ_ONLY_MEMORY = Object.freeze([
  CAPABILITY.MEMORY_READ,
  CAPABILITY.MEMORY_SEARCH
]);

const ALL_CAPABILITIES = Object.freeze(
  Object.values(CAPABILITY)
);

// Specialist GPTs: read-only memory, skills, mandates, their own exchange inbox,
// and exchange artifacts specifically addressed to their credential identity.
const SPECIALIST_CAPABILITIES = Object.freeze([
  ...READ_ONLY_MEMORY,
  CAPABILITY.SKILLS_RETRIEVAL,
  CAPABILITY.MANDATES_READ,
  CAPABILITY.MANDATES_ACK,
  CAPABILITY.EXCHANGES_INBOX,
  CAPABILITY.EXCHANGES_ACK,
  CAPABILITY.EXCHANGES_REPLY,
  CAPABILITY.ARIADNE_CORE_OPENAI_TEST,
  CAPABILITY.EXCHANGES_ARTIFACT_READ_OWN
]);

// Portal GPTs: observation only. No inbox, dispatch, mandates, skills, or router.
const PORTAL_CAPABILITIES = Object.freeze([
  ...READ_ONLY_MEMORY,
  CAPABILITY.SKILLS_RETRIEVAL,
  CAPABILITY.EXCHANGES_HISTORY,
  CAPABILITY.MEMORY_SEARCH
]);

// Orchestrators: operational coordination without memory ingest/hash authority.
const ORCHESTRATOR_CAPABILITIES = Object.freeze([
  ...READ_ONLY_MEMORY,
  CAPABILITY.SKILLS_RETRIEVAL,
  CAPABILITY.MANDATES_READ,
  CAPABILITY.MANDATES_DRAFT,
  CAPABILITY.MANDATES_DISPATCH,
  CAPABILITY.CONTRACTS_DRAFT,
  CAPABILITY.ROUTER_STATUS,
  CAPABILITY.EXCHANGES_DISPATCH,
  CAPABILITY.EXCHANGES_INBOX,
  CAPABILITY.EXCHANGES_HISTORY,
  CAPABILITY.ARIADNE_CORE_OPENAI_TEST,
  CAPABILITY.EXCHANGES_ARTIFACT_READ_ANY
]);

// Inspector is deliberately non-mutating until dedicated audit/repository routes
// and capabilities are added.
const INSPECTOR_CAPABILITIES = Object.freeze([
  ...READ_ONLY_MEMORY,
  CAPABILITY.SKILLS_RETRIEVAL,
  CAPABILITY.HISTORY_RETRIEVAL,
  CAPABILITY.EXCHANGES_HISTORY,
  CAPABILITY.REGISTRY_VIEW
]);

const DASHBOARD_CAPABILITIES = Object.freeze([
  CAPABILITY.DASHBOARD_OVERVIEW
]);

const ROLE_POLICIES = Object.freeze({
  root: Object.freeze({
    capabilities: ALL_CAPABILITIES,
    memory_domains: ["*"],
    receives_mandates: false
  }),

  orchestrator: Object.freeze({
    capabilities: ORCHESTRATOR_CAPABILITIES,
    memory_domains: ["knowledge", "agents", "skills", "files", "library"],
    receives_mandates: true
  }),

  specialist: Object.freeze({
    capabilities: SPECIALIST_CAPABILITIES,
    memory_domains: ["knowledge", "agents", "skills", "files", "library"],
    receives_mandates: true
  }),

  portal: Object.freeze({
    capabilities: PORTAL_CAPABILITIES,
    memory_domains: ["knowledge", "agents", "skills", "files", "library"],
    receives_mandates: false
  }),

  dashboard: Object.freeze({
    capabilities: DASHBOARD_CAPABILITIES,
    memory_domains: [],
    receives_mandates: false
  }),

  inspector: Object.freeze({
    capabilities: INSPECTOR_CAPABILITIES,
    memory_domains: ["knowledge", "agents", "skills", "files", "library"],
    receives_mandates: false
  })
});

const ARCHITECTUS_PRINCIPAL = Object.freeze({
  credential_id: "architectus",
  principal_id: "root",
  role: "root",
  capabilities: ALL_CAPABILITIES,
  memory_domains: Object.freeze(["*"]),
  receives_mandates: false
});

// ─── Main Export ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

if (
  method === "GET" &&
  url.pathname === "/api/ariadne/core/openai-test"
) {
  return handleAriadneCoreOpenAITest(request, env);
}


    if (url.pathname === "/ping" && method === "GET") {
      return Response.json({
        status: "alive",
        project: "Project Mnemosyne",
        worker: "mnemosyne-worker",
        api: "v1-governed-memory",
        matrix: Object.keys(INDEX_BINDING),
        model: EMBEDDING_MODEL,
        threshold: RETRIEVAL_THRESHOLD,
        identity: "credential-identity-role-policy",
        mandates: Boolean(env.DB) ? "d1-enabled" : "d1-not-bound",
        email_route: Boolean(env.MATRIX_MAIL)
          ? "active-event-driven"
          : "missing-binding",
        queue_state: Boolean(env.MATRIX_EMAIL_QUEUE)
          ? "buffered-pipeline-active"
          : "no-queue-binding",
        artifacts: Boolean(env.MATRIX_ARTIFACTS)
          ? "r2-enabled"
          : "inline-only"
      });
    }

    const auth = authenticateRequest(request, env);

    if (!auth.ok) {
      return jsonError(auth.error, auth.status);
    }

    const principal = auth.principal;

    try {
      if (url.pathname === "/hash" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_HASH);
        return handleHash(request);
      }

      if (url.pathname === "/ingest" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_INGEST);
        return handleIngest(request, env, principal);
      }

      if (url.pathname === "/query" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_SEARCH);

        return handleMemorySearch(request, env, principal, {
          legacy: true
        });
      }

      if (url.pathname === "/v1/memory/self" && method === "GET") {
        requireCapability(principal, CAPABILITY.MEMORY_READ);
        return handleMemorySelf(principal);
      }

      if (url.pathname === "/v1/memory/search" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_SEARCH);

        return handleMemorySearch(request, env, principal, {
          legacy: false
        });
      }

      if (url.pathname === "/v1/skills/retrieval" && method === "POST") {
        requireCapability(principal, CAPABILITY.SKILLS_RETRIEVAL);

        return handleMemorySearch(request, env, principal, {
          legacy: false,
          forcedIndex: "skills"
        });
      }

      if (url.pathname === "/v1/registry" && method === "GET") {
        requireCapability(principal, CAPABILITY.REGISTRY_VIEW);
        return handleRegistryView(principal);
      }

      if (url.pathname === "/v1/mandates/inbox" && method === "GET") {
        requireCapability(principal, CAPABILITY.MANDATES_READ);
        return handleMandateInbox(env, principal);
      }

      const acknowledgeMatch = url.pathname.match(
        /^\/v1\/mandates\/([^/]+)\/acknowledge$/
      );

      if (acknowledgeMatch && method === "POST") {
        requireCapability(principal, CAPABILITY.MANDATES_ACK);

        return handleMandateAcknowledge(
          env,
          principal,
          acknowledgeMatch[1]
        );
      }

      if (url.pathname === "/v1/router/mandates/draft" && method === "POST") {
        requireCapability(principal, CAPABILITY.MANDATES_DRAFT);
        return handleMandateDraft(request, principal);
      }

      if (
        url.pathname === "/v1/router/mandates/dispatch" &&
        method === "POST"
      ) {
        requireCapability(principal, CAPABILITY.MANDATES_DISPATCH);
        return handleMandateDispatch(request, env, principal);
      }

      if (url.pathname === "/v1/router/status" && method === "GET") {
        requireCapability(principal, CAPABILITY.ROUTER_STATUS);
        return handleRouterStatus(env, principal);
      }
      if (url.pathname === "/v1/dashboard/overview" && method === "GET") {
        requireCapability(principal, CAPABILITY.DASHBOARD_OVERVIEW);
        return handleDashboardOverview(env);
      }

      // ─── Persona Mesh Exchanges ────────────────────────────────────────────

      if (url.pathname === "/v1/exchanges/dispatch" && method === "POST") {
        requireCapability(principal, CAPABILITY.EXCHANGES_DISPATCH);
        return handleExchangeDispatch(request, env, principal);
      }

      if (url.pathname === "/v1/exchanges/inbox" && method === "GET") {
        requireCapability(principal, CAPABILITY.EXCHANGES_INBOX);
        return handleExchangeInbox(env, principal);
      }

      const exchangeAcknowledgeMatch = url.pathname.match(
        /^\/v1\/exchanges\/([^/]+)\/acknowledge$/
      );

      if (exchangeAcknowledgeMatch && method === "POST") {
        requireCapability(principal, CAPABILITY.EXCHANGES_ACK);

        return handleExchangeAcknowledge(
          env,
          principal,
          exchangeAcknowledgeMatch[1]
        );
      }

      if (url.pathname === "/v1/exchanges/history" && method === "GET") {
        requireCapability(principal, CAPABILITY.EXCHANGES_HISTORY);
        return handleExchangeHistory(env, principal);
      }

      const artifactMatch = url.pathname.match(
        /^\/v1\/exchanges\/([^/]+)\/artifact$/
      );

      if (artifactMatch && method === "GET") {
        requireAnyCapability(principal, [
          CAPABILITY.EXCHANGES_ARTIFACT_READ_OWN,
          CAPABILITY.EXCHANGES_ARTIFACT_READ_ANY
        ]);

        return handleExchangeArtifact(
          env,
          principal,
          artifactMatch[1]
        );
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthzError) {
        return jsonError(error.message, error.status, error.details);
      }

      console.error("Unhandled worker error:", error);
      return jsonError("Internal worker error", 500);
    }
  },

  async email(message, env, ctx) {
    const sender = String(message.from || "").trim().toLowerCase() || "unknown";
    const recipient = String(message.to || "").trim().toLowerCase();
    const recipientPersona = deriveRecipientPersona(recipient);
    const subject = message.headers.get("subject") || "Automated Mesh Exchange";
    const exchangeId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    try {
      const ingress = await prepareEmailIngressPayload(message, env, {
        exchange_id: exchangeId,
        sender,
        recipient,
        recipient_persona: recipientPersona,
        subject,
        created_at: createdAt
      });

      if (env.MATRIX_EMAIL_QUEUE) {
        await env.MATRIX_EMAIL_QUEUE.send(ingress);

        console.log(
          `[Queue Pipeline] Buffered exchange ${exchangeId} for ${recipientPersona}`
        );
      } else {
        ensureD1(env);

        await archiveExchangeRecord(
          env,
          buildExchangeRecordFromIngress(ingress, "direct")
        );

        console.log(
          `[Direct Ingress] Stored exchange ${exchangeId} for ${recipientPersona}`
        );
      }
    } catch (error) {
      console.error(`[Email Intercept Exception]: ${error.message}`);
      throw error;
    }

    const mirrorDestination =
      env.MATRIX_MAIL_FORWARD_TO || "izeesub@gmail.com";

    if (mirrorDestination && message.canBeForwarded) {
      ctx.waitUntil(
        message.forward(mirrorDestination).catch(error => {
          console.error(`[Email Mirror Exception]: ${error.message}`);
        })
      );
    }
  },

  async queue(batch, env) {
    ensureD1(env);

    for (const message of batch.messages) {
      try {
        const ingress = normalizeQueuedIngress(message.body, message.id);

        await archiveExchangeRecord(
          env,
          buildExchangeRecordFromIngress(ingress, "queue")
        );

        message.ack();

        console.log(
          `[Queue Consumer] Stored exchange ${ingress.exchange_id} for ${ingress.recipient_persona}`
        );
      } catch (error) {
        console.error(
          `[Queue Consumer Exception] Failed queue slot ${message.id}: ${error.message}`
        );

        message.retry();
      }
    }
  }
};

// ─── Identity and Authorization ───────────────────────────────────────────────

class AuthzError extends Error {
  constructor(message, status = 403, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function authenticateRequest(request, env) {
  const authKey =
    request.headers.get("X-Matrix-Key") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");

  if (!authKey) {
    return {
      ok: false,
      status: 401,
      error: "Missing action key"
    };
  }

  if (env.MATRIX_AUTH_KEY && authKey === env.MATRIX_AUTH_KEY) {
    return {
      ok: true,
      principal: ARCHITECTUS_PRINCIPAL
    };
  }

  if (env.MATRIX_DASHBOARD_KEY && authKey === env.MATRIX_DASHBOARD_KEY) {
    return {
      ok: true,
      principal: {
        credential_id: "command-center",
        principal_id: "dashboard",
        role: "dashboard",
        capabilities: [...DASHBOARD_CAPABILITIES],
        memory_domains: [],
        receives_mandates: false
      }
    };
  }

  const principal = principalFromScopedKey(authKey, env);

  if (!principal) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized credential or invalid role assignment"
    };
  }

  return {
    ok: true,
    principal
  };
}

function principalFromScopedKey(authKey, env) {
  let records =
    env.MATRIX_PRINCIPAL_KEYS ||
    env.MNEMOSYNE_PRINCIPAL_KEYS;

  if (!records) {
    return null;
  }

  if (typeof records === "string") {
    try {
      records = JSON.parse(records);
    } catch (error) {
      console.error(
        "Failed to parse MATRIX_PRINCIPAL_KEYS:",
        error.message
      );

      return null;
    }
  }

  let record = null;

  if (Array.isArray(records)) {
    record = records.find(
      item =>
        item?.key === authKey ||
        item?.action_key === authKey
    );
  } else if (typeof records === "object") {
    record = records[authKey] || null;
  }

  if (!record) {
    return null;
  }

  return resolveCredentialPrincipal(
    unwrapCredentialRecord(record)
  );
}

function unwrapCredentialRecord(record) {
  if (!record) {
    return null;
  }

  const {
    key,
    action_key,
    capabilities,
    ...credential
  } = record;

  return credential;
}

function resolveCredentialPrincipal(record) {
  if (!record) {
    return null;
  }

  const credentialId = normalizeCredentialId(
    record.credential_id || record.identity
  );

  const role = normalizeRole(
    record.principal_id || record.role
  );

  if (!credentialId) {
    console.warn("Rejected credential with missing or invalid credential_id");
    return null;
  }

  if (!role || !ROLE_POLICIES[role]) {
    console.warn(
      `Rejected credential ${credentialId}: invalid role ${role || "unknown"}`
    );
    return null;
  }

  const policy = ROLE_POLICIES[role];
  const memoryDomains = resolveEffectiveMemoryDomains(record, policy);

  const requiresMemoryDomain =
    policy.capabilities.includes(CAPABILITY.MEMORY_READ) ||
    policy.capabilities.includes(CAPABILITY.MEMORY_SEARCH);

  if (requiresMemoryDomain && memoryDomains.length === 0) {
    console.warn(
      `Rejected credential ${credentialId}: no permitted memory domains after policy intersection`
    );
    return null;
  }

  return {
    credential_id: credentialId,
    principal_id: role,
    role,
    capabilities: [...policy.capabilities],
    memory_domains: memoryDomains,
    receives_mandates: Boolean(policy.receives_mandates)
  };
}

function resolveEffectiveMemoryDomains(record, policy) {
  const roleDomains = normalizeStringList(policy.memory_domains);
  const requestedDomains = normalizeStringList(
    record.memory_domains ||
    record.allowed_domains ||
    record.domains
  );

  if (roleDomains.includes("*")) {
    if (requestedDomains.length === 0) {
      return ["*"];
    }

    return requestedDomains.filter(
      domain => domain in INDEX_BINDING
    );
  }

  if (requestedDomains.length === 0) {
    return roleDomains.filter(
      domain => domain in INDEX_BINDING
    );
  }

  return requestedDomains.filter(
    domain =>
      roleDomains.includes(domain) &&
      domain in INDEX_BINDING
  );
}

function normalizeCredentialId(value) {
  const credentialId = String(value || "")
    .trim()
    .toLowerCase();

  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(credentialId)
    ? credentialId
    : null;
}

function normalizeRole(value) {
  const role = String(value || "")
    .trim()
    .toLowerCase();

  return role || null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function hasCapability(principal, capability) {
  return (
    principal.capabilities.includes("*") ||
    principal.capabilities.includes(capability)
  );
}

function requireCapability(principal, capability) {
  if (!hasCapability(principal, capability)) {
    throw new AuthzError(
      `Role lacks capability: ${capability}`,
      403,
      {
        credential_id: principal.credential_id,
        principal_id: principal.principal_id,
        required: capability
      }
    );
  }
}

function requireAnyCapability(principal, capabilities) {
  const allowed = capabilities.some(capability =>
    hasCapability(principal, capability)
  );

  if (!allowed) {
    throw new AuthzError(
      "Role lacks required capability",
      403,
      {
        credential_id: principal.credential_id,
        principal_id: principal.principal_id,
        required_any_of: capabilities
      }
    );
  }
}

function allowedDomains(principal) {
  const allDomains = Object.keys(INDEX_BINDING);

  if (principal.memory_domains.includes("*")) {
    return allDomains;
  }

  return principal.memory_domains.filter(
    domain => domain in INDEX_BINDING
  );
}

function resolveSearchDomains(requestedIndex, principal) {
  const allowed = allowedDomains(principal);

  if (requestedIndex === "all") {
    return allowed;
  }

  if (!(requestedIndex in INDEX_BINDING)) {
    throw new AuthzError(
      `Unknown memory domain: ${requestedIndex}`,
      400
    );
  }

  if (!allowed.includes(requestedIndex)) {
    throw new AuthzError(
      `Credential is not allowed to search memory domain: ${requestedIndex}`,
      403,
      {
        credential_id: principal.credential_id,
        principal_id: principal.principal_id,
        allowed_domains: allowed
      }
    );
  }

  return [requestedIndex];
}

// ─── v1 Memory API ────────────────────────────────────────────────────────────

function handleMemorySelf(principal) {
  return Response.json({
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    role: principal.role,
    class: principal.role,
    capabilities: principal.capabilities,
    memory_domains: allowedDomains(principal)
  });
}

function handleRegistryView(principal) {
  const roles = Object.entries(ROLE_POLICIES).map(
    ([principal_id, policy]) => ({
      principal_id,
      capabilities: [...policy.capabilities],
      memory_domains: [...policy.memory_domains],
      receives_mandates: Boolean(policy.receives_mandates)
    })
  );

  return Response.json({
    requested_by: principal.credential_id,
    requested_by_role: principal.principal_id,
    registry_version: "role-policy-v2",
    roles
  });
}

async function handleMemorySearch(
  request,
  env,
  principal,
  { legacy, forcedIndex = null }
) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const query = body.query;
  const index = forcedIndex || body.index || "knowledge";

  const topK = sanitizeTopK(
    body.top_k ?? body.topK ?? DEFAULT_TOP_K
  );

  if (!query) {
    return jsonError("query is required", 400);
  }

  const domains = resolveSearchDomains(index, principal);

  let embeddingResponse;

  try {
    embeddingResponse = await env.AI.run(EMBEDDING_MODEL, {
      text: [query]
    });
  } catch (error) {
    return jsonError(`Embedding failed: ${error.message}`, 500);
  }

  const queryVector = embeddingResponse.data?.[0];

  if (!queryVector) {
    return jsonError("Embedding returned no vector", 500);
  }

  const combined = [];
  const errors = [];

  for (const domain of domains) {
    const bindingName = INDEX_BINDING[domain];
    const matrixIndex = env[bindingName];

    if (!matrixIndex) {
      errors.push({
        index: domain,
        error: `No binding found for index: ${domain}`
      });

      continue;
    }

    try {
      const queryResult = await matrixIndex.query(queryVector, {
        topK,
        returnMetadata: "all"
      });

      for (const match of queryResult.matches || []) {
        combined.push({
          ...match,
          resolved_index: domain
        });
      }
    } catch (error) {
      errors.push({
        index: domain,
        error: `Matrix query failed: ${error.message}`
      });
    }
  }

  const sortedMatches = combined.sort((a, b) => b.score - a.score);

  const filteredMatches = sortedMatches
    .filter(match => match.score >= RETRIEVAL_THRESHOLD)
    .slice(0, topK);

  const payload = {
    query,
    index,
    searched_indexes: domains,
    threshold: RETRIEVAL_THRESHOLD,
    total_raw: combined.length,
    above_threshold: filteredMatches.length,
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    errors,
    results: filteredMatches.map(formatVectorMatch)
  };

  if (legacy) {
    return Response.json(payload);
  }

  return Response.json({
    ...payload,
    api: forcedIndex
      ? "/v1/skills/retrieval"
      : "/v1/memory/search"
  });
}

function formatVectorMatch(match) {
  const metadata = match.metadata || {};

  return {
    score: Number(match.score.toFixed(4)),
    file: metadata.file,
    path: metadata.path,
    sha256: metadata.sha256,
    section: metadata.section_title,
    status: metadata.status,
    preview: metadata.preview,
    index: metadata.index || match.resolved_index,
    citation:
      metadata.path && metadata.sha256
        ? `${metadata.path}#${metadata.sha256}`
        : null
  };
}

function sanitizeTopK(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_TOP_K;
  }

  return Math.min(parsed, MAX_TOP_K);
}

// ─── Mandate API ──────────────────────────────────────────────────────────────

async function handleMandateDraft(request, principal) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const draft = buildMandateDraft(body, principal);

  return Response.json({
    status: "drafted",
    mandate: draft,
    note: "Draft only. Nothing was dispatched."
  });
}

async function handleMandateDispatch(request, env, principal) {
  ensureD1(env);

  let body;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const mandate = buildMandateDraft(body, principal);
  const recipients = resolveMandateRecipients(env, principal);

  if (recipients.length === 0) {
    return jsonError("No eligible mandate recipients found", 400);
  }

  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO mandates (
      mandate_id,
      title,
      body,
      created_by,
      created_at,
      expires_at,
      state
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      mandate.mandate_id,
      mandate.title,
      mandate.body,
      principal.credential_id,
      now,
      mandate.expires_at,
      "dispatched"
    )
    .run();

  for (const recipient of recipients) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO mandate_recipients (
        mandate_id,
        recipient_id,
        acknowledged_at
      )
      VALUES (?, ?, NULL)
    `)
      .bind(mandate.mandate_id, recipient)
      .run();
  }

  return Response.json({
    status: "dispatched",
    mandate_id: mandate.mandate_id,
    recipients,
    created_by: principal.credential_id,
    created_by_role: principal.principal_id,
    created_at: now,
    expires_at: mandate.expires_at
  });
}

async function handleMandateInbox(env, principal) {
  ensureD1(env);

  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    SELECT
      m.mandate_id,
      m.title,
      m.body,
      m.created_by,
      m.created_at,
      m.expires_at,
      m.state,
      r.acknowledged_at
    FROM mandate_recipients r
    JOIN mandates m
      ON m.mandate_id = r.mandate_id
    WHERE r.recipient_id = ?
      AND m.state IN ("dispatched", "active")
      AND m.expires_at > ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `)
    .bind(principal.credential_id, now)
    .all();

  return Response.json({
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    mandates: result.results || []
  });
}

async function handleMandateAcknowledge(env, principal, mandateId) {
  ensureD1(env);

  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    UPDATE mandate_recipients
    SET acknowledged_at = ?
    WHERE mandate_id = ?
      AND recipient_id = ?
  `)
    .bind(now, mandateId, principal.credential_id)
    .run();

  const changed = result.meta?.changes || 0;

  if (changed === 0) {
    return jsonError(
      "Mandate not found for this credential identity",
      404
    );
  }

  return Response.json({
    status: "acknowledged",
    mandate_id: mandateId,
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    acknowledged_at: now
  });
}

async function handleRouterStatus(env, principal) {
  const payload = {
    status: "alive",
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    d1_bound: Boolean(env.DB),
    artifacts_bound: Boolean(env.MATRIX_ARTIFACTS),
    email_queue_bound: Boolean(env.MATRIX_EMAIL_QUEUE),
    memory_domains: Object.keys(INDEX_BINDING),
    mandate_tables: "unknown"
  };

  if (env.DB) {
    try {
      await env.DB.prepare(
        "SELECT 1 FROM mandates LIMIT 1"
      ).first();

      payload.mandate_tables = "available";
    } catch (error) {
      payload.mandate_tables = "missing_or_unmigrated";
      payload.mandate_error = error.message;
    }
  }

  return Response.json(payload);
}
async function handleDashboardOverview(env) {
  const generatedAt = new Date().toISOString();

  const payload = {
    generated_at: generatedAt,
    worker: "alive",
    d1: env.DB ? "enabled" : "disabled",
    queue: env.MATRIX_EMAIL_QUEUE ? "active" : "inactive",
    email_route: env.MATRIX_MAIL ? "active" : "inactive",
    artifacts: env.MATRIX_ARTIFACTS ? "r2-enabled" : "inline-only",
    recent_movement: [],
    pending_acknowledgements: 0,
    attention_count: 0
  };

  if (!env.DB) {
    return Response.json(payload);
  }

  const cutoff = new Date(
    Date.now() - 72 * 60 * 60 * 1000
  ).toISOString();

  const [movementResult, pendingResult] = await Promise.all([
    env.DB.prepare(`
      SELECT mandate_id AS exchange_id, title, created_at
      FROM mandates
      WHERE state = "archived"
        AND created_at >= ?
        AND (
          title LIKE "Mesh Exchange%"
          OR title LIKE "Mesh Receipt%"
        )
      ORDER BY created_at DESC
      LIMIT 20
    `)
      .bind(cutoff)
      .all(),

    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM mandate_recipients r
      JOIN mandates m ON m.mandate_id = r.mandate_id
      WHERE m.state IN ("dispatched", "active")
        AND m.expires_at > ?
        AND r.acknowledged_at IS NULL
    `)
      .bind(generatedAt)
      .first()
  ]);

  payload.recent_movement = (movementResult.results || []).map(record => {
    const acknowledged = String(record.title).startsWith("Mesh Receipt");

    return {
      id: record.exchange_id,
      kind: acknowledged ? "receipt" : "exchange",
      title: acknowledged
        ? "Exchange acknowledged"
        : "Exchange dispatched",
      occurred_at: record.created_at,
      status: acknowledged ? "completed" : "pending"
    };
  });

  payload.pending_acknowledgements = Number(
    pendingResult?.count || 0
  );

  payload.attention_count = payload.pending_acknowledgements;

  return Response.json(payload);
}
function buildMandateDraft(body, principal) {
  const title = String(body.title || "").trim();

  const mandateBody = String(
    body.body || body.instructions || ""
  ).trim();

  if (!title) {
    throw new AuthzError("title is required", 400);
  }

  if (!mandateBody) {
    throw new AuthzError(
      "body or instructions is required",
      400
    );
  }

  const expiresAt =
    body.expires_at ||
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return {
    mandate_id: body.mandate_id || crypto.randomUUID(),
    title,
    body: mandateBody,
    created_by: principal.credential_id,
    created_by_role: principal.principal_id,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    state: "draft"
  };
}

function resolveMandateRecipients(env, principal) {
  let records =
    env.MATRIX_PRINCIPAL_KEYS ||
    env.MNEMOSYNE_PRINCIPAL_KEYS;

  if (!records) {
    return [];
  }

  if (typeof records === "string") {
    try {
      records = JSON.parse(records);
    } catch (error) {
      console.error(
        "Failed to parse MATRIX_PRINCIPAL_KEYS for recipients:",
        error.message
      );

      return [];
    }
  }

  const credentials = Array.isArray(records)
    ? records.map(unwrapCredentialRecord)
    : Object.values(records).map(unwrapCredentialRecord);

  return [
    ...new Set(
      credentials
        .filter(Boolean)
        .map(resolveCredentialPrincipal)
        .filter(Boolean)
        .filter(
          item =>
            item.credential_id !== principal.credential_id
        )
        .filter(item => item.receives_mandates)
        .filter(item =>
          hasCapability(item, CAPABILITY.MANDATES_READ)
        )
        .map(item => item.credential_id)
    )
  ];
}

function sanitizeRecipients(recipients) {
  if (!Array.isArray(recipients)) {
    return [];
  }

  return [
    ...new Set(
      recipients
        .map(item => String(item).trim().toLowerCase())
        .filter(item => /^[a-z0-9_-]{2,64}$/.test(item))
    )
  ];
}

function ensureD1(env) {
  if (!env.DB) {
    throw new AuthzError(
      "D1 binding DB is required for mandate and exchange routes",
      503
    );
  }
}

// ─── Persona Mesh Exchange API ────────────────────────────────────────────────

function validateSourceBoundSkillPacket({
  recipientPersona,
  payloadData,
  contentType
}) {
  const mediaType = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (mediaType !== "application/json") {
    return;
  }

  let packet;

  try {
    packet = JSON.parse(payloadData);
  } catch {
    throw new AuthzError(
      "JSON exchange payload is invalid.",
      400
    );
  }

  if (packet.event !== "skill_handoff") {
    return;
  }

  const packetRecipient = String(packet.recipient || "")
    .trim()
    .toLowerCase();

  if (packetRecipient !== recipientPersona) {
    throw new AuthzError(
      "Skill packet recipient must match recipient_persona.",
      400,
      {
        packet_recipient: packetRecipient || null,
        recipient_persona: recipientPersona
      }
    );
  }

  if (!String(packet.skill_name || "").trim()) {
    throw new AuthzError(
      "Skill packet requires skill_name.",
      400
    );
  }

  if (!Array.isArray(packet.evidence) || packet.evidence.length === 0) {
    throw new AuthzError(
      "Skill packet requires at least one evidence item.",
      400
    );
  }

  for (const [index, evidence] of packet.evidence.entries()) {
    if (!evidence || typeof evidence !== "object") {
      throw new AuthzError(
        `Evidence item ${index} is invalid.`,
        400
      );
    }

    const path = String(evidence.path || "").trim();
    const sha256 = String(evidence.sha256 || "").trim();

    if (!path) {
      throw new AuthzError(
        `Evidence item ${index} is missing path.`,
        400
      );
    }

    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new AuthzError(
        `Evidence item ${index} requires a valid SHA-256 hash.`,
        400
      );
    }
  }
}

function resolveExchangeRecipient(env, recipientPersona) {
  if (recipientPersona === ARCHITECTUS_PRINCIPAL.credential_id) {
    return ARCHITECTUS_PRINCIPAL;
  }

  let records =
    env.MATRIX_PRINCIPAL_KEYS ||
    env.MNEMOSYNE_PRINCIPAL_KEYS;

  if (!records) {
    throw new AuthzError(
      "No credential registry is configured.",
      503
    );
  }

  if (typeof records === "string") {
    try {
      records = JSON.parse(records);
    } catch {
      throw new AuthzError(
        "Credential registry is invalid JSON.",
        503
      );
    }
  }

  const credentials = Array.isArray(records)
    ? records.map(unwrapCredentialRecord)
    : Object.values(records).map(unwrapCredentialRecord);

  const recipient = credentials
    .filter(Boolean)
    .map(resolveCredentialPrincipal)
    .filter(Boolean)
    .find(
      item => item.credential_id === recipientPersona
    );

  if (!recipient) {
    throw new AuthzError(
      `Recipient persona is not registered: ${recipientPersona}`,
      404
    );
  }

  if (!hasCapability(recipient, CAPABILITY.EXCHANGES_INBOX)) {
    throw new AuthzError(
      `Recipient cannot receive exchanges: ${recipientPersona}`,
      400
    );
  }

  return recipient;
}

async function handleExchangeDispatch(request, env, principal) {
  ensureD1(env);

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const recipientPersona = normalizePersonaRecipient(
    payload.recipient_persona
  );

  const recipient = resolveExchangeRecipient(
    env,
    recipientPersona
  );

  const chapterContext = Number(payload.chapter_context);
  const stateVersion = String(payload.state_version || "").trim();
  const payloadData = String(payload.payload_data || "").trim();

  const contentType = String(
    payload.content_type || "text/plain; charset=utf-8"
  );

  if (!Number.isInteger(chapterContext) || chapterContext < 1) {
    return jsonError(
      "chapter_context must be a positive integer",
      400
    );
  }

  if (!stateVersion) {
    return jsonError("state_version is required", 400);
  }

  if (!payloadData) {
    return jsonError("payload_data is required", 400);
  }

  validateSourceBoundSkillPacket({
    recipientPersona,
    payloadData,
    contentType
  });

  const exchangeId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const payloadDescriptor = await prepareTextExchangePayload(env, {
    exchange_id: exchangeId,
    recipient_persona: recipientPersona,
    source: "api",
    payload_data: payloadData,
    content_type: contentType
  });

  const record = {
    mandate_id: exchangeId,

    title:
      `Mesh Exchange [` +
      `${recipientPersona} | Chapter ${chapterContext} | ` +
      `v${stateVersion}]`,

    body: buildExchangeLedgerBody({
      sender: principal.credential_id,
      recipient: recipientPersona,

      recipient_address: String(
        payload.recipient_persona || ""
      ).trim(),

      source: "api",
      payload: payloadDescriptor
    }),

    created_by: principal.credential_id,
    created_at: createdAt,

    expires_at: new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString(),

    state: "archived"
  };

  await archiveExchangeRecord(env, record);

  return Response.json({
    status: "submitted",
    exchange_id: exchangeId,

    recipient_persona: recipientPersona,
    recipient_credential_id: recipient.credential_id,

    created_by: principal.credential_id,
    created_by_role: principal.principal_id,
    created_at: createdAt,

    payload_mode: payloadDescriptor.mode,
    artifact_key: payloadDescriptor.artifact_key || null
  });
}

async function handleExchangeInbox(env, principal) {
  ensureD1(env);

  const result = await env.DB.prepare(`
    SELECT
      mandate_id AS exchange_id,
      title,
      body,
      created_by AS sender,
      created_at,
      expires_at,
      state
    FROM mandates
    WHERE state = "archived"
      AND (
        title LIKE "Mesh Exchange%"
        OR title LIKE "Mail Exchange%"
        OR title LIKE "Queue Exchange%"
        OR title LIKE "Mesh Receipt%"
      )
    ORDER BY created_at DESC
    LIMIT 250
  `).all();

  const exchanges = (result.results || [])
    .filter(record => {
      const recipient =
        readLedgerField(record.body, "Recipient Persona") ||
        readLedgerField(record.body, "Target");

      return recipient === principal.credential_id;
    })
    .slice(0, 50);

  return Response.json({
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    exchanges
  });
}

async function handleExchangeAcknowledge(
  env,
  principal,
  exchangeId
) {
  ensureD1(env);

  const exchange = await env.DB.prepare(`
    SELECT
      mandate_id,
      title,
      body,
      created_by,
      created_at,
      state
    FROM mandates
    WHERE mandate_id = ?
      AND state = "archived"
    LIMIT 1
  `)
    .bind(exchangeId)
    .first();

  if (!exchange || !isExchangeTitle(exchange.title)) {
    return jsonError("Exchange not found", 404);
  }

  const recipient =
    readLedgerField(exchange.body, "Recipient Persona") ||
    readLedgerField(exchange.body, "Target");

  if (recipient !== principal.credential_id) {
    return jsonError(
      "Exchange is not addressed to this credential identity",
      403
    );
  }

  const sender = String(exchange.created_by || "")
    .trim()
    .toLowerCase();

  if (!normalizeCredentialId(sender)) {
    return jsonError(
      "Original sender is not a valid Matrix credential identity",
      400
    );
  }

  const receiptTitle =
    `Mesh Receipt [${sender} | ${exchangeId}]`;

  const existingReceipt = await env.DB.prepare(`
    SELECT mandate_id
    FROM mandates
    WHERE title = ?
      AND state = "archived"
    LIMIT 1
  `)
    .bind(receiptTitle)
    .first();

  if (existingReceipt) {
    return Response.json({
      status: "already_acknowledged",
      exchange_id: exchangeId,
      receipt_exchange_id: existingReceipt.mandate_id
    });
  }

  const receiptExchangeId = crypto.randomUUID();
  const acknowledgedAt = new Date().toISOString();

  const receiptPayload = JSON.stringify({
    event: "exchange_receipt",
    status: "acknowledged",
    acknowledged_exchange_id: exchangeId,
    acknowledged_by: principal.credential_id,
    acknowledged_at: acknowledgedAt
  });

  const payloadDescriptor = await prepareTextExchangePayload(env, {
    exchange_id: receiptExchangeId,
    recipient_persona: sender,
    source: "receipt",
    payload_data: receiptPayload,
    content_type: "application/json"
  });

  await archiveExchangeRecord(env, {
    mandate_id: receiptExchangeId,
    title: receiptTitle,

    body: buildExchangeLedgerBody({
      sender: principal.credential_id,
      recipient: sender,
      recipient_address: sender,
      source: "receipt",
      payload: payloadDescriptor
    }),

    created_by: principal.credential_id,
    created_at: acknowledgedAt,

    expires_at: new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString(),

    state: "archived"
  });

  return Response.json({
    status: "acknowledged",
    exchange_id: exchangeId,
    receipt_exchange_id: receiptExchangeId,
    acknowledged_by: principal.credential_id,
    acknowledged_at: acknowledgedAt
  });
}

async function handleExchangeHistory(env, principal) {
  ensureD1(env);

  const result = await env.DB.prepare(`
    SELECT
      mandate_id AS exchange_id,
      title,
      body,
      created_by AS sender,
      created_at,
      expires_at,
      state
    FROM mandates
    WHERE state = "archived"
      AND (
        title LIKE "Mesh Exchange%"
        OR title LIKE "Mail Exchange%"
        OR title LIKE "Queue Exchange%"
        OR title LIKE "Mesh Receipt%"
      )
    ORDER BY created_at DESC
    LIMIT 50
  `).all();

  return Response.json({
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,
    telemetry: result.results || []
  });
}

async function handleExchangeArtifact(env, principal, exchangeId) {
  ensureD1(env);

  if (!env.MATRIX_ARTIFACTS) {
    return jsonError(
      "Artifact storage is not configured",
      503
    );
  }

  const record = await env.DB.prepare(`
    SELECT
      mandate_id,
      title,
      body,
      created_by,
      created_at,
      state
    FROM mandates
    WHERE mandate_id = ?
      AND state = "archived"
    LIMIT 1
  `)
    .bind(exchangeId)
    .first();

  if (!record || !isExchangeTitle(record.title)) {
    return jsonError("Exchange artifact not found", 404);
  }

  const recipient =
    readLedgerField(record.body, "Recipient Persona") ||
    readLedgerField(record.body, "Target");

  const artifactKey = readLedgerField(record.body, "Artifact Key");

  if (!artifactKey) {
    return jsonError(
      "This exchange has no external artifact",
      404
    );
  }

  const mayReadAnyExchange = hasCapability(
    principal,
    CAPABILITY.EXCHANGES_ARTIFACT_READ_ANY
  );

  if (
    !mayReadAnyExchange &&
    recipient !== principal.credential_id
  ) {
    return jsonError(
      "Exchange artifact is not addressed to this credential identity",
      403
    );
  }

  const object = await env.MATRIX_ARTIFACTS.get(artifactKey);

  if (!object) {
    return jsonError("Artifact object is missing", 404);
  }

  const contentType =
    object.httpMetadata?.contentType ||
    "application/octet-stream";

  const fileName =
    artifactKey.split("/").pop() ||
    "exchange-artifact";

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${sanitizeDownloadFileName(
        fileName
      )}"`,
      "X-Exchange-Id": exchangeId,
      "X-Artifact-Key": artifactKey
    }
  });
}

async function prepareEmailIngressPayload(message, env, envelope) {
  const payloadSize = Number(message.rawSize || 0);

  if (payloadSize <= MAX_INLINE_QUEUE_BYTES) {
    const rawBody = await new Response(message.raw).text();

    return {
      ...envelope,
      source: "email",
      payload_mode: "inline",
      payload_size: byteLength(rawBody),
      raw_body: rawBody,
      artifact_key: null,
      artifact_content_type: null
    };
  }

  if (!env.MATRIX_ARTIFACTS) {
    message.setReject(
      "Incoming artifact exceeds inline queue capacity. Configure MATRIX_ARTIFACTS or send an artifact reference."
    );

    throw new Error(
      "Oversized email requires MATRIX_ARTIFACTS R2 binding"
    );
  }

  const artifactKey = buildArtifactKey(
    "email",
    envelope.exchange_id,
    "eml"
  );

  await env.MATRIX_ARTIFACTS.put(
    artifactKey,
    message.raw,
    {
      httpMetadata: {
        contentType: "message/rfc822"
      },

      customMetadata: {
        source: "email",
        sender: envelope.sender,
        recipient: envelope.recipient_persona,
        exchange_id: envelope.exchange_id,
        created_at: envelope.created_at
      }
    }
  );

  return {
    ...envelope,
    source: "email",
    payload_mode: "artifact",
    payload_size: payloadSize,
    raw_body: "",
    artifact_key: artifactKey,
    artifact_content_type: "message/rfc822"
  };
}

async function prepareTextExchangePayload(
  env,
  {
    exchange_id,
    recipient_persona,
    source,
    payload_data,
    content_type
  }
) {
  const payloadSize = byteLength(payload_data);

  if (payloadSize <= MAX_INLINE_QUEUE_BYTES) {
    return {
      mode: "inline",
      payload_size: payloadSize,
      data: payload_data,
      artifact_key: null,
      artifact_content_type: null
    };
  }

  if (!env.MATRIX_ARTIFACTS) {
    throw new AuthzError(
      "Payload exceeds inline exchange capacity. Configure MATRIX_ARTIFACTS or send an artifact reference.",
      413
    );
  }

  const artifactKey = buildArtifactKey(
    source,
    exchange_id,
    "txt"
  );

  await env.MATRIX_ARTIFACTS.put(
    artifactKey,
    payload_data,
    {
      httpMetadata: {
        contentType
      },

      customMetadata: {
        source,
        recipient: recipient_persona,
        exchange_id
      }
    }
  );

  return {
    mode: "artifact",
    payload_size: payloadSize,
    data: "",
    artifact_key: artifactKey,
    artifact_content_type: content_type
  };
}

function normalizeQueuedIngress(payload, fallbackExchangeId) {
  const source = String(payload?.source || "email");

  if (source !== "email") {
    throw new Error(
      `Unsupported queue payload source: ${source}`
    );
  }

  const recipient = String(payload?.recipient || "")
    .trim()
    .toLowerCase();

  const recipientPersona = String(
    payload?.recipient_persona ||
    deriveRecipientPersona(recipient)
  )
    .trim()
    .toLowerCase() || "unmapped";

  const payloadMode =
    payload?.payload_mode === "artifact"
      ? "artifact"
      : "inline";

  return {
    exchange_id: String(
      payload?.exchange_id || fallbackExchangeId
    ),

    sender:
      String(payload?.sender || "unknown")
        .trim()
        .toLowerCase() || "unknown",

    recipient,
    recipient_persona: recipientPersona,

    subject: String(
      payload?.subject || "Automated Mesh Exchange"
    ),

    created_at:
      payload?.created_at ||
      payload?.timestamp ||
      new Date().toISOString(),

    source,
    payload_mode: payloadMode,

    payload_size: Number(
      payload?.payload_size ||
      byteLength(String(payload?.raw_body || ""))
    ),

    raw_body:
      payloadMode === "inline"
        ? String(payload?.raw_body ?? payload?.rawBody ?? "")
        : "",

    artifact_key:
      payloadMode === "artifact"
        ? String(payload?.artifact_key || "")
        : "",

    artifact_content_type:
      payloadMode === "artifact"
        ? String(
            payload?.artifact_content_type ||
            "application/octet-stream"
          )
        : null
  };
}

function buildExchangeRecordFromIngress(
  ingress,
  transport = "queue"
) {
  const prefix =
    ingress.source === "email"
      ? transport === "direct"
        ? "Mail Exchange"
        : "Queue Exchange"
      : "Mesh Exchange";

  const title =
    ingress.source === "email"
      ? `${prefix} [${ingress.recipient_persona}]: ${ingress.subject}`
      : `${prefix} [${ingress.recipient_persona}]`;

  return {
    mandate_id: ingress.exchange_id,

    title,

    body: buildExchangeLedgerBody({
      sender: ingress.sender,
      recipient: ingress.recipient_persona,
      recipient_address: ingress.recipient,
      source: ingress.source,

      payload: {
        mode: ingress.payload_mode,
        payload_size: ingress.payload_size,
        data: ingress.raw_body,
        artifact_key: ingress.artifact_key,
        artifact_content_type: ingress.artifact_content_type
      }
    }),

    created_by: ingress.sender,
    created_at: ingress.created_at,

    expires_at: new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString(),

    state: "archived"
  };
}

function buildExchangeLedgerBody({
  sender,
  recipient,
  recipient_address,
  source,
  payload
}) {
  const lines = [
    `Sender: ${sender || "unknown"}`,
    `Recipient Address: ${recipient_address || "unknown"}`,
    `Recipient Persona: ${recipient || "unmapped"}`,
    `Source: ${source || "unknown"}`,
    `Payload Mode: ${payload.mode}`,
    `Payload Size: ${Number(payload.payload_size || 0)} bytes`
  ];

  if (payload.mode === "artifact") {
    lines.push(`Artifact Key: ${payload.artifact_key}`);

    lines.push(
      `Artifact Content Type: ${
        payload.artifact_content_type ||
        "application/octet-stream"
      }`
    );

    lines.push("");
    lines.push(
      "Payload stored in MATRIX_ARTIFACTS. Retrieve it through the exchange artifact route."
    );

    return lines.join("\n");
  }

  lines.push("");
  lines.push(payload.data || "");

  return lines.join("\n");
}

async function archiveExchangeRecord(env, record) {
  ensureD1(env);

  return env.DB.prepare(`
    INSERT OR IGNORE INTO mandates (
      mandate_id,
      title,
      body,
      created_by,
      created_at,
      expires_at,
      state
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      record.mandate_id,
      record.title,
      record.body,
      record.created_by,
      record.created_at,
      record.expires_at,
      record.state
    )
    .run();
}

function deriveRecipientPersona(address) {
  const localPart = String(address || "")
    .trim()
    .toLowerCase()
    .split("@")[0]
    .split("+")[0]
    .replace(/^@/, "");

  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(localPart)
    ? localPart
    : "unmapped";
}

function normalizePersonaRecipient(value) {
  const recipient = deriveRecipientPersona(value);

  if (recipient === "unmapped") {
    throw new AuthzError(
      "recipient_persona must be a valid persona handle or mailbox address",
      400
    );
  }

  return recipient;
}

function buildArtifactKey(source, exchangeId, extension) {
  return `exchanges/${source}/${exchangeId}/payload.${extension}`;
}

function readLedgerField(body, fieldName) {
  const prefix = `${fieldName}:`;

  const line = String(body || "")
    .split("\n")
    .find(item => item.startsWith(prefix));

  return line
    ? line.slice(prefix.length).trim()
    : null;
}

function isExchangeTitle(title) {
  const value = String(title || "");

  return (
    value.startsWith("Mesh Exchange") ||
    value.startsWith("Mail Exchange") ||
    value.startsWith("Queue Exchange") ||
    value.startsWith("Mesh Receipt")
  );
}

function byteLength(value) {
  return new TextEncoder().encode(
    String(value || "")
  ).byteLength;
}

function sanitizeDownloadFileName(value) {
  return String(value || "exchange-artifact")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 160);
}

// ─── Hash Helper ──────────────────────────────────────────────────────────────

async function handleHash(request) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { content } = body;

  if (!content) {
    return jsonError("content is required", 400);
  }

  let target = content;
  let hadFrontmatter = false;

  try {
    const parsed = parseFrontmatter(content);
    target = parsed.body;
    hadFrontmatter = true;
  } catch {
    // No frontmatter detected.
  }

  const sha256 = await computeBodyHash(target);

  return Response.json({
    sha256,
    frontmatter_detected: hadFrontmatter,

    note: hadFrontmatter
      ? "Hash computed on body only (frontmatter stripped). Paste this into the sha256 field."
      : "No frontmatter found. Hash computed on full normalized content."
  });
}

// ─── Ingest Handler ───────────────────────────────────────────────────────────

async function handleIngest(request, env, principal) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const {
    file_name,
    content,
    index_override
  } = body;

  if (!file_name || !content) {
    return jsonError(
      "file_name and content are required",
      400
    );
  }

  let frontmatter = {};
  let bodyContent = content;
  let validationError = null;

  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    bodyContent = parsed.body;
  } catch (error) {
    validationError =
      `Failed to parse frontmatter: ${error.message}`;
  }

  if (!validationError) {
    for (const field of REQUIRED_FRONTMATTER_FIELDS) {
      if (!(field in frontmatter)) {
        validationError = `Missing required field: ${field}`;
        break;
      }
    }
  }

  if (
    !validationError &&
    !VALID_STATUS_VALUES.includes(frontmatter.status)
  ) {
    validationError =
      `Invalid status: ${frontmatter.status}. Must be one of: ${VALID_STATUS_VALUES.join(
        ", "
      )}`;
  }

  if (
    !validationError &&
    !["canon", "sealed"].includes(frontmatter.status)
  ) {
    validationError =
      `Only canon and sealed documents may be ingested. Status is: ${frontmatter.status}`;
  }

  let computedHash = null;

  if (!validationError) {
    computedHash = await computeBodyHash(bodyContent);

    if (computedHash !== frontmatter.sha256) {
      validationError =
        `Hash mismatch. Stored: ${frontmatter.sha256}, ` +
        `Computed: ${computedHash}. Document tampered or corrupted.`;
    }
  }

  if (validationError) {
    const errorPayload = {
      file: file_name,
      error: validationError,
      status: "VALIDATION_FAILED",
      timestamp: new Date().toISOString()
    };

    try {
      await fetch(
        "https://pulse-alarm-engine.izeesub.workers.dev/webhook/ingest-failure",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(errorPayload)
        }
      ).catch(() => {});
    } catch (error) {
      console.error("Webhook failed:", error.message);
    }

    return Response.json(errorPayload, {
      status: 422
    });
  }

  const sections = parseMarkdownSections(bodyContent);

  if (sections.length === 0) {
    return jsonError(
      "No parseable sections found in content",
      400
    );
  }

  const results = [];
  const errors = [];

  for (const section of sections) {
    const indexKey =
      index_override ||
      routeSection(section.title);

    try {
      resolveSearchDomains(indexKey, principal);
    } catch (error) {
      errors.push({
        section: section.title,
        error: error.message
      });

      continue;
    }

    const bindingName = INDEX_BINDING[indexKey];
    const matrixIndex = env[bindingName];

    if (!matrixIndex) {
      errors.push({
        section: section.title,
        error: `No binding found for index: ${indexKey}`
      });

      continue;
    }

    let embeddingResponse;

    try {
      embeddingResponse = await env.AI.run(
        EMBEDDING_MODEL,
        {
          text: [section.content.slice(0, 2000)]
        }
      );
    } catch (error) {
      errors.push({
        section: section.title,
        error: `Embedding failed: ${error.message}`
      });

      continue;
    }

    const vector = embeddingResponse.data?.[0];

    if (!vector) {
      errors.push({
        section: section.title,
        error: "Embedding returned no vector"
      });

      continue;
    }

    const safeFileName = file_name.replace(
      /[^a-zA-Z0-9]/g,
      "_"
    );

    const id =
      `${safeFileName}_s${String(section.number).padStart(
        3,
        "0"
      )}`;

    try {
      await matrixIndex.upsert([
        {
          id,
          values: vector,

          metadata: {
            file: file_name,
            path: file_name,
            sha256: frontmatter.sha256,

            section_number: String(section.number),
            section_title: section.title,

            status: frontmatter.status,
            index: indexKey,

            preview: section.content.slice(0, 500),
            ingested_at: new Date().toISOString(),

            document_id: frontmatter.id,
            document_title: frontmatter.title,
            created: frontmatter.created,

            ingested_by: principal.credential_id,
            ingested_by_role: principal.principal_id
          }
        }
      ]);
    } catch (error) {
      errors.push({
        section: section.title,
        error: `Upsert failed: ${error.message}`
      });

      continue;
    }

    results.push({
      id,
      section: section.title,
      index: indexKey,
      chars: section.content.length,
      hash: frontmatter.sha256,
      status: frontmatter.status
    });
  }

  return Response.json({
    file: file_name,
    status: frontmatter.status,
    document_id: frontmatter.id,
    sha256: frontmatter.sha256,

    sections_found: sections.length,
    sections_ingested: results.length,
    errors_count: errors.length,

    validation: "passed",
    credential_id: principal.credential_id,
    principal_id: principal.principal_id,

    results,
    errors
  });
}

// ─── Frontmatter Parser ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const lines = content.split("\n");

  if (!lines[0]?.trimEnd().startsWith("---")) {
    throw new Error(
      "No frontmatter delimiter found (missing opening ---)"
    );
  }

  let endIndex = -1;

  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trimEnd().startsWith("---")) {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    throw new Error(
      "No closing frontmatter delimiter (---) found"
    );
  }

  const frontmatterText = lines
    .slice(1, endIndex)
    .join("\n");

  const body = lines
    .slice(endIndex + 1)
    .join("\n");

  let frontmatter = {};

  try {
    frontmatter = parseYAML(frontmatterText);
  } catch (error) {
    throw new Error(
      `YAML parse error: ${error.message}`
    );
  }

  return {
    frontmatter,
    body
  };
}

function parseYAML(yamlText) {
  const result = {};
  const lines = yamlText.split("\n");

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const match = line.match(/^(\w+):\s*(.*)$/);

    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    if (value === "null") {
      result[key] = null;
    } else if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (
      value.startsWith("[") &&
      value.endsWith("]")
    ) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
    } else if (
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
      result[key] = value.slice(1, -1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

async function computeBodyHash(body) {
  const normalized = body
    .replace(/\r\n/g, "\n")
    .trim();

  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseMarkdownSections(content) {
  const lines = content.split("\n");
  const sections = [];

  let current = null;
  let number = 0;

  for (const line of lines) {
    const isHeading = /^#{1,3}\s/.test(line);

    if (isHeading) {
      if (
        current &&
        current.content
          .replace(/#+\s.*/, "")
          .trim()
          .length > 20
      ) {
        sections.push(current);
      }

      number++;

      current = {
        number,
        title: line.replace(/^#+\s/, "").trim(),
        content: `${line}\n`
      };
    } else if (current) {
      current.content += `${line}\n`;
    }
  }

  if (
    current &&
    current.content
      .replace(/#+\s.*/, "")
      .trim()
      .length > 20
  ) {
    sections.push(current);
  }

  return sections;
}

function routeSection(title) {
  const normalizedTitle = title.toLowerCase();

  for (const [indexKey, keywords] of Object.entries(
    SECTION_ROUTING
  )) {
    if (
      keywords.some(keyword =>
        normalizedTitle.includes(keyword)
      )
    ) {
      return indexKey;
    }
  }

  return "knowledge";
}

function jsonError(error, status = 400, details = undefined) {
  return Response.json(
    {
      error,
      details
    },
    {
      status
    }
  );
}

async function handleAriadneCoreOpenAITest(request, env) {
  const auth = authenticateRequest(request, env);

  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }

  const principal = auth.principal;

  try {
    requireCapability(principal, CAPABILITY.ARIADNE_CORE_OPENAI_TEST);
  } catch (error) {
    if (error instanceof AuthzError) {
      return jsonError(error.message, error.status, error.details);
    }

    throw error;
  }

  if (!env.OPENAI_API_KEY) {
    return Response.json(
      { ok: false, status: 500, error: "OPENAI_API_KEY is not configured" },
      { status: 500 }
    );
  }

  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: "Reply with exactly: Ariadne connected."
    })
  });

  if (!response.ok) {
    return Response.json(
      {
        ok: false,
        status: response.status,
        error: "OpenAI request failed"
      },
      { status: 502 }
    );
  }

  const data = await response.json();

  const output =
    data.output_text ??
    data.output?.[0]?.content?.[0]?.text ??
    "";

  return Response.json(
    {
      ok: true,
      status: 200,
      output
    },
    { status: 200 }
  );
}
