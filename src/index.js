/**
 * Project Mnemosyne — Mnemosyne's Matrix (ROLE-BASED AUTHORIZATION)
 * ───────────────────────────────────────────
 * Worker: mnemosyne-worker
 * Role: Governed vector memory, role-authorized credentials,
 * mandate dispatch, and buffered persona-mesh ingress.
 * Model: @cf/baai/bge-large-en-v1.5 (1024 dims, cosine) 
 */

import yaml from 'js-yaml'; // Phase 1: Robust Frontmatter Parsing

// ─── Routing Table & Constants ───────────────────────────────────────
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
const ARCHITECTUS_EXCHANGE_RECIPIENT = "architectus";

const REQUIRED_FRONTMATTER_FIELDS = [ 
  "id", "title", "created", "status", "sha256", "parents", "sources", "tags", "schema" 
];
const VALID_STATUS_VALUES = ["intake", "canon", "sealed"];

// ─── Capability Policy ───────────────────────────────────────────────
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
  EXCHANGES_DISPATCH: "exchanges.dispatch", 
  EXCHANGES_REPLY: "exchanges.reply",
  EXCHANGES_INBOX: "exchanges.inbox", 
  EXCHANGES_HISTORY: "exchanges.history",
  REGISTRY_VIEW: "registry.view" 
});

const READ_ONLY_MEMORY = Object.freeze([CAPABILITY.MEMORY_READ, CAPABILITY.MEMORY_SEARCH]);
const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITY));

const SPECIALIST_CAPABILITIES = Object.freeze([ 
  ...READ_ONLY_MEMORY, CAPABILITY.SKILLS_RETRIEVAL, CAPABILITY.MANDATES_READ, 
  CAPABILITY.MANDATES_ACK, CAPABILITY.EXCHANGES_INBOX, CAPABILITY.EXCHANGES_REPLY,
  CAPABILITY.EXCHANGES_ARTIFACT_READ_OWN 
]);

const PORTAL_CAPABILITIES = Object.freeze([ 
  ...READ_ONLY_MEMORY, CAPABILITY.SKILLS_RETRIEVAL, CAPABILITY.EXCHANGES_HISTORY 
]);

const ORCHESTRATOR_CAPABILITIES = Object.freeze([ 
  ...READ_ONLY_MEMORY, CAPABILITY.SKILLS_RETRIEVAL, CAPABILITY.MANDATES_READ,
  CAPABILITY.MANDATES_DRAFT, CAPABILITY.MANDATES_DISPATCH, CAPABILITY.CONTRACTS_DRAFT, 
  CAPABILITY.ROUTER_STATUS, CAPABILITY.EXCHANGES_DISPATCH, CAPABILITY.EXCHANGES_INBOX,
  CAPABILITY.EXCHANGES_HISTORY, CAPABILITY.EXCHANGES_ARTIFACT_READ_ANY 
]);

const INSPECTOR_CAPABILITIES = Object.freeze([ 
  ...READ_ONLY_MEMORY, CAPABILITY.SKILLS_RETRIEVAL, CAPABILITY.HISTORY_RETRIEVAL,
  CAPABILITY.EXCHANGES_HISTORY, CAPABILITY.REGISTRY_VIEW 
]);

const ROLE_POLICIES = Object.freeze({ 
  root: Object.freeze({ capabilities: ALL_CAPABILITIES, memory_domains: ["*"], receives_mandates: false }),
  orchestrator: Object.freeze({ capabilities: ORCHESTRATOR_CAPABILITIES, memory_domains: ["knowledge", "agents", "skills", "files", "library"], receives_mandates: true }), 
  specialist: Object.freeze({ capabilities: SPECIALIST_CAPABILITIES, memory_domains: ["knowledge", "agents", "skills", "files", "library"], receives_mandates: true }), 
  portal: Object.freeze({ capabilities: PORTAL_CAPABILITIES, memory_domains: ["knowledge", "agents", "skills", "files", "library"], receives_mandates: false }), 
  inspector: Object.freeze({ capabilities: INSPECTOR_CAPABILITIES, memory_domains: ["knowledge", "agents", "skills", "files", "library"], receives_mandates: false }) 
});

const ARCHITECTUS_PRINCIPAL = Object.freeze({ 
  credential_id: "architectus", principal_id: "root", role: "root", 
  capabilities: ALL_CAPABILITIES, memory_domains: Object.freeze(["*"]), receives_mandates: false 
});

// ─── Main Export (Lifecycle Methods) ─────────────────────────────────
export default { 
  async fetch(request, env, ctx) { 
    const url = new URL(request.url); 
    const method = request.method;

    if (url.pathname === "/ping" && method === "GET") { 
      return Response.json({
        status: "alive", project: "Project Mnemosyne", worker: "mnemosyne-worker", 
        api: "v1-governed-memory", matrix: Object.keys(INDEX_BINDING), model: EMBEDDING_MODEL,
        threshold: RETRIEVAL_THRESHOLD, identity: "credential-identity-role-policy",
        mandates: Boolean(env.DB) ? "d1-enabled" : "d1-not-bound", 
        email_route: Boolean(env.MATRIX_MAIL) ? "active-event-driven" : "missing-binding",
        queue_state: Boolean(env.MATRIX_EMAIL_QUEUE) ? "buffered-pipeline-active" : "no-queue-binding", 
        artifacts: Boolean(env.MATRIX_ARTIFACTS) ? "r2-enabled" : "inline-only" 
      });
    }

    const auth = authenticateRequest(request, env); 
    if (!auth.ok) return jsonError(auth.error, auth.status);

    const principal = auth.principal;

    try { 
      if (url.pathname === "/hash" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_HASH); return handleHash(request);
      }
      if (url.pathname === "/ingest" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_INGEST); return handleIngest(request, env, principal, ctx);
      }
      if (url.pathname === "/v1/memory/self" && method === "GET") {
        requireCapability(principal, CAPABILITY.MEMORY_READ); return handleMemorySelf(principal);
      }
      if (url.pathname === "/v1/memory/search" && method === "POST") {
        requireCapability(principal, CAPABILITY.MEMORY_SEARCH); return handleMemorySearch(request, env, principal, { legacy: false });
      }
      if (url.pathname === "/v1/skills/retrieval" && method === "POST") {
        requireCapability(principal, CAPABILITY.SKILLS_RETRIEVAL); return handleMemorySearch(request, env, principal, { legacy: false, forcedIndex: "skills" });
      }
      if (url.pathname === "/v1/registry" && method === "GET") {
        requireCapability(principal, CAPABILITY.REGISTRY_VIEW); return handleRegistryView(principal);
      }
      if (url.pathname === "/v1/mandates/inbox" && method === "GET") {
        requireCapability(principal, CAPABILITY.MANDATES_READ); return handleMandateInbox(env, principal); 
      }

      const acknowledgeMatch = url.pathname.match(/^\/v1\/mandates\/([^/]+)\/acknowledge$/);
      if (acknowledgeMatch && method === "POST") { 
        requireCapability(principal, CAPABILITY.MANDATES_ACK);
        return handleMandateAcknowledge(env, principal, acknowledgeMatch[1]);
      }

      if (url.pathname === "/v1/router/mandates/draft" && method === "POST") {
        requireCapability(principal, CAPABILITY.MANDATES_DRAFT); return handleMandateDraft(request, principal);
      }
      if (url.pathname === "/v1/router/mandates/dispatch" && method === "POST") {
        requireCapability(principal, CAPABILITY.MANDATES_DISPATCH); return handleMandateDispatch(request, env, principal);
      }
      if (url.pathname === "/v1/router/status" && method === "GET") {
        requireCapability(principal, CAPABILITY.ROUTER_STATUS); return handleRouterStatus(env, principal);
      }

      if (url.pathname === "/v1/exchanges/dispatch" && method === "POST") {
        requireCapability(principal, CAPABILITY.EXCHANGES_DISPATCH); return handleExchangeDispatch(request, env, principal, ctx);
      }
      if (url.pathname === "/v1/exchanges/reply" && method === "POST") {
        requireCapability(principal, CAPABILITY.EXCHANGES_REPLY); return handleExchangeReply(request, env, principal, ctx);
      }
      if (url.pathname === "/v1/exchanges/inbox" && method === "GET") {
        requireCapability(principal, CAPABILITY.EXCHANGES_INBOX); return handleExchangeInbox(env, principal);
      }
      if (url.pathname === "/v1/exchanges/history" && method === "GET") {
        requireCapability(principal, CAPABILITY.EXCHANGES_HISTORY); return handleExchangeHistory(env, principal); 
      }

      const artifactMatch = url.pathname.match(/^\/v1\/exchanges\/([^/]+)\/artifact$/);
      if (artifactMatch && method === "GET") { 
        requireAnyCapability(principal, [CAPABILITY.EXCHANGES_ARTIFACT_READ_OWN, CAPABILITY.EXCHANGES_ARTIFACT_READ_ANY]); 
        return handleExchangeArtifact(env, principal, artifactMatch[1]);
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
        exchange_id: exchangeId, sender, recipient, recipient_persona: recipientPersona, subject, created_at: createdAt 
      });
      if (env.MATRIX_EMAIL_QUEUE) { 
        await env.MATRIX_EMAIL_QUEUE.send(ingress); 
        console.log(`[Queue Pipeline] Buffered exchange ${exchangeId} for ${recipientPersona}`); 
      } else { 
        ensureD1(env); 
        await archiveExchangeRecord(env, buildExchangeRecordFromIngress(ingress, "direct"));
        console.log(`[Direct Ingress] Stored exchange ${exchangeId} for ${recipientPersona}`); 
      } 
    } catch (error) { 
      console.error(`[Email Intercept Exception]: ${error.message}`); throw error;
    }

    const mirrorDestination = env.MATRIX_MAIL_FORWARD_TO || "izeesub@gmail.com"; 
    if (mirrorDestination && message.canBeForwarded) {
      ctx.waitUntil(message.forward(mirrorDestination).catch(error => console.error(`[Email Mirror Exception]: ${error.message}`))); 
    } 
  },

  async queue(batch, env) { 
    ensureD1(env);
    for (const message of batch.messages) {
      try { 
        const ingress = normalizeQueuedIngress(message.body, message.id); 
        await archiveExchangeRecord(env, buildExchangeRecordFromIngress(ingress, "queue"));
        message.ack();
        console.log(`[Queue Consumer] Stored exchange ${ingress.exchange_id} for ${ingress.recipient_persona}`); 
      } catch (error) {
        console.error(`[Queue Consumer Exception] Failed queue slot ${message.id}: ${error.message}`); 
        message.retry();
      } 
    } 
  },

  async scheduled(event, env, ctx) {
    // Phase 3: Organic Memory Decay Trigger
    console.log(`Cron triggered memory decay at ${event.cron}`);
    ctx.waitUntil(decayMemory(env));
  }
};

// ─── Identity and Authorization ──────────────────────────────────────
class AuthzError extends Error { 
  constructor(message, status = 403, details = undefined) { 
    super(message);
    this.status = status; 
    this.details = details; 
  }
}

function authenticateRequest(request, env) { 
  const authKey = request.headers.get("X-Matrix-Key") || request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!authKey) return { ok: false, status: 401, error: "Missing action key" };
  if (env.MATRIX_AUTH_KEY && authKey === env.MATRIX_AUTH_KEY) return { ok: true, principal: ARCHITECTUS_PRINCIPAL };
  
  const principal = principalFromScopedKey(authKey, env);
  if (!principal) return { ok: false, status: 401, error: "Unauthorized credential or invalid role assignment" }; 
  return { ok: true, principal };
}

function principalFromScopedKey(authKey, env) { 
  let records = env.MATRIX_PRINCIPAL_KEYS || env.MNEMOSYNE_PRINCIPAL_KEYS; 
  if (!records) return null;
  if (typeof records === "string") { try { records = JSON.parse(records); } catch { return null; } }

  let record = null;
  if (Array.isArray(records)) { 
    record = records.find(item => item?.key === authKey || item?.action_key === authKey);
  } else if (typeof records === "object") { 
    record = records[authKey] || null; 
  }
  
  if (!record) return null; 
  return resolveCredentialPrincipal(unwrapCredentialRecord(record));
}

function unwrapCredentialRecord(record) { 
  if (!record) return null; 
  const { key, action_key, capabilities, ...credential } = record; 
  return credential;
}

function resolveCredentialPrincipal(record) { 
  if (!record) return null; 
  const credentialId = normalizeCredentialId(record.credential_id || record.identity);
  const role = normalizeRole(record.principal_id || record.role);
  
  if (!credentialId || !role || !ROLE_POLICIES[role]) return null;
  
  const policy = ROLE_POLICIES[role]; 
  const memoryDomains = resolveEffectiveMemoryDomains(record, policy);
  if (memoryDomains.length === 0) return null;

  return { 
    credential_id: credentialId, principal_id: role, role, 
    capabilities: [...policy.capabilities], memory_domains: memoryDomains, 
    receives_mandates: Boolean(policy.receives_mandates) 
  };
}

function resolveEffectiveMemoryDomains(record, policy) { 
  const roleDomains = normalizeStringList(policy.memory_domains); 
  const requestedDomains = normalizeStringList(record.memory_domains || record.allowed_domains || record.domains);
  
  if (roleDomains.includes("*")) { 
    if (requestedDomains.length === 0) return ["*"];
    return requestedDomains.filter(domain => domain in INDEX_BINDING);
  }

  if (requestedDomains.length === 0) return roleDomains.filter(domain => domain in INDEX_BINDING); 
  return requestedDomains.filter(domain => roleDomains.includes(domain) && domain in INDEX_BINDING);
}

function normalizeCredentialId(value) { 
  const credentialId = String(value || "").trim().toLowerCase(); 
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(credentialId) ? credentialId : null; 
}
function normalizeRole(value) { return String(value || "").trim().toLowerCase() || null; }

function normalizeStringList(value) { 
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean); 
  if (typeof value === "string" && value.trim()) return [value.trim()]; 
  return [];
}

function hasCapability(principal, capability) { 
  return principal.capabilities.includes("*") || principal.capabilities.includes(capability); 
}

function requireCapability(principal, capability) { 
  if (!hasCapability(principal, capability)) { 
    throw new AuthzError(`Role lacks capability: ${capability}`, 403, { credential_id: principal.credential_id, required: capability });
  } 
}

function requireAnyCapability(principal, capabilities) { 
  if (!capabilities.some(capability => hasCapability(principal, capability))) { 
    throw new AuthzError("Role lacks required capability", 403, { credential_id: principal.credential_id, required_any_of: capabilities });
  } 
}

function allowedDomains(principal) { 
  if (principal.memory_domains.includes("*")) return Object.keys(INDEX_BINDING); 
  return principal.memory_domains.filter(domain => domain in INDEX_BINDING); 
}

function resolveSearchDomains(requestedIndex, principal) { 
  const allowed = allowedDomains(principal);
  if (requestedIndex === "all") return allowed; 
  if (!(requestedIndex in INDEX_BINDING)) throw new AuthzError(`Unknown memory domain: ${requestedIndex}`, 400);
  if (!allowed.includes(requestedIndex)) throw new AuthzError(`Not allowed to search: ${requestedIndex}`, 403); 
  return [requestedIndex];
}

// ─── v1 Memory API ───────────────────────────────────────────────────
function handleMemorySelf(principal) { 
  return Response.json({ 
    credential_id: principal.credential_id, principal_id: principal.principal_id, role: principal.role, 
    class: principal.role, capabilities: principal.capabilities, memory_domains: allowedDomains(principal) 
  });
}

function handleRegistryView(principal) { 
  const roles = Object.entries(ROLE_POLICIES).map(([principal_id, policy]) => ({ 
    principal_id, capabilities: [...policy.capabilities], memory_domains: [...policy.memory_domains], receives_mandates: Boolean(policy.receives_mandates) 
  }));
  return Response.json({ requested_by: principal.credential_id, registry_version: "role-policy-v2", roles }); 
}

async function handleMemorySearch(request, env, principal, { legacy, forcedIndex = null }) { 
  let body;
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }
  
  const query = body.query;
  const index = forcedIndex || body.index || "knowledge"; 
  const topK = sanitizeTopK(body.top_k ?? body.topK ?? DEFAULT_TOP_K);
  
  if (!query) return jsonError("query is required", 400);

  const domains = resolveSearchDomains(index, principal); 
  let embeddingResponse;
  
  try { 
    embeddingResponse = await env.AI.run(EMBEDDING_MODEL, { text: [query] }); 
  } catch (error) { 
    return jsonError(`Embedding failed: ${error.message}`, 500);
  }

  const queryVector = embeddingResponse.data?.[0]; 
  if (!queryVector) return jsonError("Embedding returned no vector", 500);
  
  const combined = []; const errors = [];
  
  for (const domain of domains) { 
    const bindingName = INDEX_BINDING[domain]; 
    const matrixIndex = env[bindingName];
    
    if (!matrixIndex) { 
      errors.push({ index: domain, error: "No binding found" }); continue;
    } 
    try { 
      const queryResult = await matrixIndex.query(queryVector, { topK, returnMetadata: "all" });
      for (const match of queryResult.matches || []) {
        combined.push({ ...match, resolved_index: domain });
      } 
    } catch (error) {
      errors.push({ index: domain, error: "Matrix query failed" });
    } 
  }
  
  const sortedMatches = combined.sort((a, b) => b.score - a.score); 
  const filteredMatches = sortedMatches.filter(match => match.score >= RETRIEVAL_THRESHOLD).slice(0, topK);
  
  const payload = { 
    query, index, searched_indexes: domains, threshold: RETRIEVAL_THRESHOLD, 
    total_raw: combined.length, above_threshold: filteredMatches.length, 
    credential_id: principal.credential_id, errors, results: filteredMatches.map(formatVectorMatch) 
  };

  return legacy ? Response.json(payload) : Response.json({ ...payload, api: forcedIndex ? "/v1/skills/retrieval" : "/v1/memory/search" }); 
}

function formatVectorMatch(match) { 
  const metadata = match.metadata || {};
  return { 
    score: Number(match.score.toFixed(4)), file: metadata.file, path: metadata.path, 
    sha256: metadata.sha256, section: metadata.section_title, status: metadata.status, 
    preview: metadata.preview, index: metadata.index || match.resolved_index, 
    citation: metadata.path && metadata.sha256 ? `${metadata.path}#${metadata.sha256}` : null 
  }; 
}

function sanitizeTopK(value) { 
  const parsed = Number.parseInt(value, 10);
  return (!Number.isFinite(parsed) || parsed < 1) ? DEFAULT_TOP_K : Math.min(parsed, MAX_TOP_K); 
}

// ─── Mandate API ─────────────────────────────────────────────────────
async function handleMandateDraft(request, principal) { 
  let body;
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }

  const draft = buildMandateDraft(body, principal);
  return Response.json({ status: "drafted", mandate: draft, note: "Draft only. Nothing was dispatched." }); 
}

async function handleMandateDispatch(request, env, principal) { 
  ensureD1(env);
  let body; 
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }
  
  const mandate = buildMandateDraft(body, principal);
  const recipients = resolveMandateRecipients(env, principal); 
  if (recipients.length === 0) return jsonError("No eligible mandate recipients found", 400);

  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO mandates (mandate_id, title, body, created_by, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)`) 
    .bind(mandate.mandate_id, mandate.title, mandate.body, principal.credential_id, now, mandate.expires_at, "dispatched").run();
    
  for (const recipient of recipients) { 
    await env.DB.prepare(`INSERT OR IGNORE INTO mandate_recipients (mandate_id, recipient_id, acknowledged_at) VALUES (?, ?, NULL)`) 
      .bind(mandate.mandate_id, recipient).run();
  }

  return Response.json({ status: "dispatched", mandate_id: mandate.mandate_id, recipients, created_by: principal.credential_id, created_at: now, expires_at: mandate.expires_at }); 
}

async function handleMandateInbox(env, principal) { 
  ensureD1(env);
  const now = new Date().toISOString(); 
  const result = await env.DB.prepare(`SELECT m.mandate_id, m.title, m.body, m.created_by, m.created_at, m.expires_at, m.state, r.acknowledged_at FROM mandate_recipients r JOIN mandates m ON m.mandate_id = r.mandate_id WHERE r.recipient_id = ? AND m.state IN ("dispatched", "active") AND m.expires_at > ? ORDER BY m.created_at DESC LIMIT 50`)
    .bind(principal.credential_id, now).all();
  return Response.json({ credential_id: principal.credential_id, mandates: result.results || [] }); 
}

async function handleMandateAcknowledge(env, principal, mandateId) {
  ensureD1(env); 
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE mandate_recipients SET acknowledged_at = ? WHERE mandate_id = ? AND recipient_id = ?`) 
    .bind(now, mandateId, principal.credential_id).run();
    
  if ((result.meta?.changes || 0) === 0) return jsonError("Mandate not found for this credential identity", 404);
  return Response.json({ status: "acknowledged", mandate_id: mandateId, credential_id: principal.credential_id, acknowledged_at: now }); 
}

async function handleRouterStatus(env, principal) { 
  const payload = { status: "alive", credential_id: principal.credential_id, d1_bound: Boolean(env.DB), memory_domains: Object.keys(INDEX_BINDING) };
  if (env.DB) { 
    try { 
      await env.DB.prepare("SELECT 1 FROM mandates LIMIT 1").first();
      payload.mandate_tables = "available"; 
    } catch (error) { 
      payload.mandate_tables = "missing_or_unmigrated";
    } 
  } 
  return Response.json(payload); 
}

function buildMandateDraft(body, principal) { 
  const title = String(body.title || "").trim(); 
  const mandateBody = String(body.body || body.instructions || "").trim();
  
  if (!title) throw new AuthzError("title is required", 400); 
  if (!mandateBody) throw new AuthzError("body or instructions is required", 400);
  
  return { 
    mandate_id: body.mandate_id || crypto.randomUUID(), title, body: mandateBody, 
    created_by: principal.credential_id, created_by_role: principal.principal_id, 
    created_at: new Date().toISOString(), 
    expires_at: body.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), state: "draft" 
  }; 
}

function resolveMandateRecipients(env, principal) { 
  let records = env.MATRIX_PRINCIPAL_KEYS || env.MNEMOSYNE_PRINCIPAL_KEYS; 
  if (!records) return []; 
  
  if (typeof records === "string") { 
    try { records = JSON.parse(records); } catch { return []; } 
  }

  const credentials = Array.isArray(records) ? records.map(unwrapCredentialRecord) : Object.values(records).map(unwrapCredentialRecord); 
  return [...new Set(credentials.filter(Boolean).map(resolveCredentialPrincipal).filter(Boolean)
    .filter(item => item.credential_id !== principal.credential_id && item.receives_mandates && hasCapability(item, CAPABILITY.MANDATES_READ))
    .map(item => item.credential_id))];
}

function ensureD1(env) { 
  if (!env.DB) throw new AuthzError("D1 binding DB is required for mandate and exchange routes", 503);
}

// ─── Persona Mesh Exchange API ───────────────────────────────────────
function triggerMirror(env, ctx, exchangeId) { 
  if (!env.DB) return; 
  ctx.waitUntil((async () => { 
    try { 
      await env.DB.prepare(`INSERT OR IGNORE INTO mandate_recipients (mandate_id, recipient_id) VALUES (?, 'architectus')`).bind(exchangeId).run(); 
    } catch (error) { console.error(`[Mirroring Failsafe] Shadow copy to Architectus failed: ${error.message}`); } 
  })());
}

async function handleExchangeReply(request, env, principal, ctx) {
  ensureD1(env); let payload; 
  try { payload = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }

  const replyToExchangeId = String(payload.reply_to_exchange_id || "").trim();
  const payloadData = String(payload.payload_data || "").trim();
  
  if (!replyToExchangeId || !payloadData) return jsonError("reply_to_exchange_id and payload_data are required", 400);

  const original = await env.DB.prepare(`SELECT mandate_id AS exchange_id, title, body, created_by AS sender FROM mandates WHERE mandate_id = ? AND state = "archived" LIMIT 1`).bind(replyToExchangeId).first();
  if (!original || !isExchangeTitle(original.title)) return jsonError("Original exchange not found", 404);
  
  const originalRecipient = readLedgerField(original.body, "Recipient Persona") || readLedgerField(original.body, "Target");
  if (originalRecipient !== principal.credential_id) return jsonError("Original exchange is not addressed to this credential", 403);

  const replyId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const payloadDescriptor = await prepareTextExchangePayload(env, { 
    exchange_id: replyId, recipient_persona: original.sender, source: "reply", 
    payload_data: payloadData, content_type: String(payload.content_type || "text/plain; charset=utf-8") 
  });
  
  const replyRecord = { 
    mandate_id: replyId, 
    title: `Mesh Reply [${principal.credential_id} → ${original.sender}]`, 
    body: buildExchangeLedgerBody({ sender: principal.credential_id, recipient: original.sender, recipient_address: original.sender, source: "reply", payload: payloadDescriptor }) + `\n\nReply To Exchange ID: ${replyToExchangeId}`, 
    created_by: principal.credential_id, created_at: createdAt, 
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), state: "archived" 
  };
  
  await archiveExchangeRecord(env, replyRecord); 
  triggerMirror(env, ctx, replyId);

  return Response.json({ status: "submitted", reply_id: replyId, reply_to_exchange_id: replyToExchangeId, recipient_persona: original.sender, created_by: principal.credential_id, created_at: createdAt, payload_mode: payloadDescriptor.mode, artifact_key: payloadDescriptor.artifact_key || null });
}

async function handleExchangeDispatch(request, env, principal, ctx) {
  ensureD1(env); 
  let payload; 
  try { payload = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }

  const recipientPersona = normalizePersonaRecipient(payload.recipient_persona);
  const chapterContext = Number(payload.chapter_context); 
  const stateVersion = String(payload.state_version || "").trim();
  const payloadData = String(payload.payload_data || "").trim();

  if (!Number.isInteger(chapterContext) || chapterContext < 1) return jsonError("chapter_context must be a positive integer", 400);
  if (!stateVersion || !payloadData) return jsonError("state_version and payload_data are required", 400);
  
  const exchangeId = crypto.randomUUID(); 
  const createdAt = new Date().toISOString();
  
  const payloadDescriptor = await prepareTextExchangePayload(env, { 
    exchange_id: exchangeId, recipient_persona: recipientPersona, source: "api", 
    payload_data: payloadData, content_type: String(payload.content_type || "text/plain; charset=utf-8") 
  });
  
  const record = { 
    mandate_id: exchangeId, 
    title: `Mesh Exchange [${recipientPersona} | Chapter ${chapterContext} | v${stateVersion}]`, 
    body: buildExchangeLedgerBody({ sender: principal.credential_id, recipient: recipientPersona, recipient_address: String(payload.recipient_persona || "").trim(), source: "api", payload: payloadDescriptor }), 
    created_by: principal.credential_id, created_at: createdAt, 
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), state: "archived" 
  };
  
  await archiveExchangeRecord(env, record); 
  triggerMirror(env, ctx, exchangeId);

  return Response.json({ status: "submitted", exchange_id: exchangeId, recipient_persona: recipientPersona, created_by: principal.credential_id, created_at: createdAt, payload_mode: payloadDescriptor.mode, artifact_key: payloadDescriptor.artifact_key || null });
}

async function handleExchangeInbox(env, principal) { 
  ensureD1(env); 
  const result = await env.DB.prepare(`SELECT mandate_id AS exchange_id, title, body, created_by AS sender, created_at, state FROM mandates WHERE state = "archived" AND (title LIKE "Mesh Exchange%" OR title LIKE "Mail Exchange%" OR title LIKE "Queue Exchange%" OR title LIKE "Mesh Reply%") ORDER BY created_at DESC LIMIT 250`).all();
  
  const exchanges = (result.results || []).filter(record => { 
    const recipient = readLedgerField(record.body, "Recipient Persona") || readLedgerField(record.body, "Target"); 
    return recipient === principal.credential_id; 
  }).slice(0, 50);
  
  return Response.json({ credential_id: principal.credential_id, exchanges }); 
}

async function handleExchangeHistory(env, principal) { 
  ensureD1(env);
  const result = await env.DB.prepare(`SELECT mandate_id AS exchange_id, title, body, created_by AS sender, created_at, state FROM mandates WHERE state = "archived" AND (title LIKE "Mesh Exchange%" OR title LIKE "Mail Exchange%" OR title LIKE "Queue Exchange%" OR title LIKE "Mesh Reply%") ORDER BY created_at DESC LIMIT 50`).all();
  return Response.json({ credential_id: principal.credential_id, telemetry: result.results || [] }); 
}

async function handleExchangeArtifact(env, principal, exchangeId) {
  ensureD1(env);
  if (!env.MATRIX_ARTIFACTS) return jsonError("Artifact storage is not configured", 503);

  const record = await env.DB.prepare(`SELECT mandate_id, title, body, created_by, created_at, state FROM mandates WHERE mandate_id = ? AND state = "archived" LIMIT 1`).bind(exchangeId).first();
  if (!record || !isExchangeTitle(record.title)) return jsonError("Exchange artifact not found", 404);

  const recipient = readLedgerField(record.body, "Recipient Persona") || readLedgerField(record.body, "Target");
  const artifactKey = readLedgerField(record.body, "Artifact Key"); 
  if (!artifactKey) return jsonError("This exchange has no external artifact", 404);
  
  if (!hasCapability(principal, CAPABILITY.EXCHANGES_ARTIFACT_READ_ANY) && recipient !== principal.credential_id) { 
    return jsonError("Exchange artifact is not addressed to this credential identity", 403);
  }

  const object = await env.MATRIX_ARTIFACTS.get(artifactKey); 
  if (!object) return jsonError("Artifact object is missing", 404);

  const contentType = object.httpMetadata?.contentType || "application/octet-stream";
  const fileName = artifactKey.split("/").pop() || "exchange-artifact"; 
  
  return new Response(object.body, { 
    headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${sanitizeDownloadFileName(fileName)}"`, "X-Exchange-Id": exchangeId, "X-Artifact-Key": artifactKey } 
  });
}

async function prepareEmailIngressPayload(message, env, envelope) { 
  const payloadSize = Number(message.rawSize || 0); 
  if (payloadSize <= MAX_INLINE_QUEUE_BYTES) { 
    const rawBody = await new Response(message.raw).text();
    return { ...envelope, source: "email", payload_mode: "inline", payload_size: byteLength(rawBody), raw_body: rawBody, artifact_key: null, artifact_content_type: null };
  }

  if (!env.MATRIX_ARTIFACTS) { 
    message.setReject("Incoming artifact exceeds inline queue capacity. Configure MATRIX_ARTIFACTS."); 
    throw new Error("Oversized email requires MATRIX_ARTIFACTS R2 binding");
  }
  
  const artifactKey = buildArtifactKey("email", envelope.exchange_id, "eml");
  await env.MATRIX_ARTIFACTS.put(artifactKey, message.raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { source: "email", sender: envelope.sender, recipient: envelope.recipient_persona, exchange_id: envelope.exchange_id, created_at: envelope.created_at } });
  
  return { ...envelope, source: "email", payload_mode: "artifact", payload_size: payloadSize, raw_body: "", artifact_key: artifactKey, artifact_content_type: "message/rfc822" };
}

async function prepareTextExchangePayload(env, { exchange_id, recipient_persona, source, payload_data, content_type }) { 
  const payloadSize = byteLength(payload_data);
  if (payloadSize <= MAX_INLINE_QUEUE_BYTES) { 
    return { mode: "inline", payload_size: payloadSize, data: payload_data, artifact_key: null, artifact_content_type: null };
  }

  if (!env.MATRIX_ARTIFACTS) throw new AuthzError("Payload exceeds inline capacity. Configure MATRIX_ARTIFACTS.", 413);

  const artifactKey = buildArtifactKey(source, exchange_id, "txt");
  await env.MATRIX_ARTIFACTS.put(artifactKey, payload_data, { httpMetadata: { contentType: content_type }, customMetadata: { source, recipient: recipient_persona, exchange_id } });
  
  return { mode: "artifact", payload_size: payloadSize, data: "", artifact_key: artifactKey, artifact_content_type: content_type };
}

function normalizeQueuedIngress(payload, fallbackExchangeId) { 
  const source = String(payload?.source || "email"); 
  if (source !== "email") throw new Error(`Unsupported queue source: ${source}`);
  
  const recipient = String(payload?.recipient || "").trim().toLowerCase(); 
  const recipientPersona = String(payload?.recipient_persona || deriveRecipientPersona(recipient)).trim().toLowerCase() || "unmapped"; 
  const payloadMode = payload?.payload_mode === "artifact" ? "artifact" : "inline";

  return { 
    exchange_id: String(payload?.exchange_id || fallbackExchangeId),
    sender: String(payload?.sender || "unknown").trim().toLowerCase() || "unknown",
    recipient, recipient_persona: recipientPersona, subject: String(payload?.subject || "Automated Mesh Exchange"), 
    created_at: payload?.created_at || payload?.timestamp || new Date().toISOString(), source, payload_mode: payloadMode, 
    payload_size: Number(payload?.payload_size || byteLength(String(payload?.raw_body || ""))), 
    raw_body: payloadMode === "inline" ? String(payload?.raw_body ?? payload?.rawBody ?? "") : "", 
    artifact_key: payloadMode === "artifact" ? String(payload?.artifact_key || "") : "",
    artifact_content_type: payloadMode === "artifact" ? String(payload?.artifact_content_type || "application/octet-stream") : null 
  }; 
}

function buildExchangeRecordFromIngress(ingress, transport = "queue") { 
  const prefix = ingress.source === "email" ? (transport === "direct" ? "Mail Exchange" : "Queue Exchange") : "Mesh Exchange"; 
  const title = ingress.source === "email" ? `${prefix} [${ingress.recipient_persona}]: ${ingress.subject}` : `${prefix} [${ingress.recipient_persona}]`;

  return { 
    mandate_id: ingress.exchange_id, title, 
    body: buildExchangeLedgerBody({ sender: ingress.sender, recipient: ingress.recipient_persona, recipient_address: ingress.recipient, source: ingress.source, payload: { mode: ingress.payload_mode, payload_size: ingress.payload_size, data: ingress.raw_body, artifact_key: ingress.artifact_key, artifact_content_type: ingress.artifact_content_type } }),
    created_by: ingress.sender, created_at: ingress.created_at, 
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), state: "archived" 
  };
}

function buildExchangeLedgerBody({ sender, recipient, recipient_address, source, payload }) { 
  const lines = [ 
    `Sender: ${sender || "unknown"}`, 
    `Recipient Address: ${recipient_address || "unknown"}`, 
    `Recipient Persona: ${recipient || "unmapped"}`, 
    `Source: ${source || "unknown"}`, 
    `Payload Mode: ${payload.mode}`, 
    `Payload Size: ${Number(payload.payload_size || 0)} bytes` 
  ];
  if (payload.mode === "artifact") { 
    lines.push(`Artifact Key: ${payload.artifact_key}`, `Artifact Content Type: ${payload.artifact_content_type || "application/octet-stream"}`, "", "Payload stored in MATRIX_ARTIFACTS. Retrieve it through the exchange artifact route.");
    return lines.join("\n"); 
  } 
  lines.push("", payload.data || ""); 
  return lines.join("\n"); 
}

async function archiveExchangeRecord(env, record) { 
  ensureD1(env);
  return env.DB.prepare(`INSERT OR IGNORE INTO mandates (mandate_id, title, body, created_by, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.mandate_id, record.title, record.body, record.created_by, record.created_at, record.expires_at, record.state).run();
}

function deriveRecipientPersona(address) { 
  const localPart = String(address || "").trim().toLowerCase().split("@")[0].split("+")[0].replace(/^@/, ""); 
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(localPart) ? localPart : "unmapped"; 
}

function normalizePersonaRecipient(value) { 
  const recipient = deriveRecipientPersona(value);
  if (recipient === "unmapped") throw new AuthzError("recipient_persona must be a valid persona handle", 400); 
  return recipient; 
}

function buildArtifactKey(source, exchangeId, extension) { 
  return `exchanges/${source}/${exchangeId}/payload.${extension}`;
}

function readLedgerField(body, fieldName) { 
  const prefix = `${fieldName}:`; 
  const line = String(body || "").split("\n").find(item => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null; 
}

function isExchangeTitle(title) { 
  const value = String(title || ""); 
  return value.startsWith("Mesh Exchange") || value.startsWith("Mail Exchange") || value.startsWith("Queue Exchange") || value.startsWith("Mesh Reply"); 
}

function byteLength(value) { 
  return new TextEncoder().encode(String(value || "")).byteLength; 
}

function sanitizeDownloadFileName(value) { 
  return String(value || "exchange-artifact").replace(/[^a-zA-Z0-9.-]/g, "").slice(0, 160);
}

// ─── Hash Helper ─────────────────────────────────────────────────────
async function handleHash(request) { 
  let body; 
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }

  if (!body.content) return jsonError("content is required", 400);

  let target = body.content;
  let hadFrontmatter = false; 
  try { 
    const parsed = parseFrontmatter(body.content); 
    target = parsed.body; 
    hadFrontmatter = true;
  } catch {}

  return Response.json({ sha256: await computeBodyHash(target), frontmatter_detected: hadFrontmatter }); 
}

// ─── Phase 2: Autonomous AI Routing (semanticRoute) ──────────────────
async function semanticRoute(env, sectionTitle, sectionContent) {
  const validDomains = Object.keys(INDEX_BINDING);
  
  const systemPrompt = `You are an internal routing component for the Mnemosyne Matrix. 
  Your job is to categorize the provided text into exactly one of the following domains: ${validDomains.join(", ")}. 
  Respond ONLY with the single word of the domain. Do not add punctuation or explanation.
  
  Definitions:
  - knowledge: Protocols, doctrines, runtime layers, or general information.
  - agents: Names, roles, boundaries, or specialist registry data.
  - skills: Capabilities, actionable skills, or ledger entries.
  - files: Artifacts, session outputs, or file uploads.
  - library: Archival or reference literature.`;

  try {
    const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Title: ${sectionTitle}\n\nContent: ${sectionContent.slice(0, 1000)}` }
      ]
    });

    const predictedDomain = response.response.trim().toLowerCase().replace(/[^a-z]/g, '');

    if (validDomains.includes(predictedDomain)) {
      return predictedDomain;
    } else {
      console.warn(`[Routing Warning] LLM returned invalid domain: ${predictedDomain}. Defaulting to knowledge.`);
      return "knowledge";
    }
    
  } catch (error) {
    console.error(`[Routing Failsafe] LLM routing failed: ${error.message}. Defaulting to knowledge.`);
    return "knowledge";
  }
}

// ─── Ingest Handler (Refactored for LLM Concurrency) ─────────────────
async function handleIngest(request, env, principal, ctx) { 
  let body;
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }

  const { file_name, content, index_override } = body; 
  if (!file_name || !content) return jsonError("file_name and content are required", 400);
  
  let frontmatter = {}; 
  let bodyContent = content; 
  let validationError = null;

  try { 
    const parsed = parseFrontmatter(content); 
    frontmatter = parsed.frontmatter;
    bodyContent = parsed.body; 
  } catch (error) { 
    validationError = `Failed to parse frontmatter: ${error.message}`;
  }
  
  if (!validationError) { 
    for (const field of REQUIRED_FRONTMATTER_FIELDS) { 
      if (!(field in frontmatter)) { validationError = `Missing required field: ${field}`; break; } 
    } 
  }

  if (!validationError && !VALID_STATUS_VALUES.includes(frontmatter.status)) validationError = `Invalid status. Must be one of: ${VALID_STATUS_VALUES.join(", ")}`;
  if (!validationError && !["canon", "sealed"].includes(frontmatter.status)) validationError = `Only canon and sealed documents may be ingested.`;
  
  if (!validationError) { 
    const computedHash = await computeBodyHash(bodyContent);
    if (computedHash !== frontmatter.sha256) validationError = `Hash mismatch. Document tampered.`;
  }

  if (validationError) { 
    const errorPayload = { file: file_name, error: validationError, status: "VALIDATION_FAILED", timestamp: new Date().toISOString() };
    ctx.waitUntil(fetch("https://pulse-alarm-engine.izeesub.workers.dev/webhook/ingest-failure", { 
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(errorPayload) 
    }).catch(() => {})); 
    return Response.json(errorPayload, { status: 422 });
  }
  
  const sections = parseMarkdownSections(bodyContent); 
  if (sections.length === 0) return jsonError("No parseable sections found in content", 400);
  
  // ◣ Execute section embeddings and AI routing concurrently
  const sectionPromises = sections.map(async (section) => { 
    // Phase 2 Upgrade: AI-driven semantic routing instead of static routeSection()
    const indexKey = index_override || await semanticRoute(env, section.title, section.content); 
    
    try { resolveSearchDomains(indexKey, principal); } 
    catch (error) { return { error: error.message, section: section.title }; }
    
    const bindingName = INDEX_BINDING[indexKey]; 
    const matrixIndex = env[bindingName]; 
    if (!matrixIndex) return { error: `No binding found for index: ${indexKey}`, section: section.title };

    let embeddingResponse; 
    try { 
      embeddingResponse = await env.AI.run(EMBEDDING_MODEL, { text: [section.content.slice(0, 2000)] }); 
    } catch (error) { 
      return { error: `Embedding failed: ${error.message}`, section: section.title }; 
    }

    const vector = embeddingResponse.data?.[0]; 
    if (!vector) return { error: "Embedding returned no vector", section: section.title };
    
    const safeFileName = file_name.replace(/[^a-zA-Z0-9]/g, "_"); 
    const id = `${safeFileName}_s${String(section.number).padStart(3, "0")}`;
    
    try { 
      await matrixIndex.upsert([{ 
        id, values: vector, metadata: { 
          file: file_name, path: file_name, sha256: frontmatter.sha256, section_number: String(section.number), 
          section_title: section.title, status: frontmatter.status, index: indexKey, preview: section.content.slice(0, 500), 
          ingested_at: new Date().toISOString(), document_id: frontmatter.id, document_title: frontmatter.title, 
          created: frontmatter.created, ingested_by: principal.credential_id 
        } 
      }]);
    } catch (error) { 
      return { error: `Upsert failed: ${error.message}`, section: section.title };
    }
    
    return { success: true, id, section: section.title, index: indexKey, chars: section.content.length, hash: frontmatter.sha256, status: frontmatter.status };
  });
  
  const settled = await Promise.all(sectionPromises); 
  const results = settled.filter(res => res.success); 
  const errors = settled.filter(res => !res.success);
  
  return Response.json({ 
    file: file_name, status: frontmatter.status, document_id: frontmatter.id, sha256: frontmatter.sha256, 
    sections_found: sections.length, sections_ingested: results.length, errors_count: errors.length, 
    validation: "passed", credential_id: principal.credential_id, results, errors 
  });
}

// ─── Phase 1 Upgrade: Robust Frontmatter Parser ──────────────────────
function parseFrontmatter(content) { 
  const lines = content.split("\n"); 
  if (!lines[0]?.trimEnd().startsWith("---")) throw new Error("No frontmatter delimiter found");
  
  let endIndex = -1; 
  for (let index = 1; index < lines.length; index++) { 
    if (lines[index].trimEnd().startsWith("---")) { endIndex = index; break; } 
  } 
  if (endIndex === -1) throw new Error("No closing frontmatter delimiter");

  return { frontmatter: parseYAML(lines.slice(1, endIndex).join("\n")), body: lines.slice(endIndex + 1).join("\n") };
}

function parseYAML(yamlText) { 
  try {
    return yaml.load(yamlText) || {};
  } catch (error) {
    throw new Error(`YAML parsing failed: ${error.message}`);
  }
}

async function computeBodyHash(body) { 
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.replace(/\r\n/g, "\n").trim()));
  return Array.from(new Uint8Array(hashBuffer)).map(byte => byte.toString(16).padStart(2, "0")).join(""); 
}

function parseMarkdownSections(content) { 
  const sections = []; 
  let current = null, number = 0;
  
  for (const line of content.split("\n")) { 
    if (/^#{1,3}\s/.test(line)) { 
      if (current && current.content.replace(/#+\s./, "").trim().length > 20) sections.push(current);
      current = { number: ++number, title: line.replace(/^#+\s/, "").trim(), content: `${line}\n` }; 
    } else if (current) {
      current.content += `${line}\n`;
    }
  } 
  if (current && current.content.replace(/#+\s./, "").trim().length > 20) sections.push(current); 
  return sections; 
}

function jsonError(error, status = 400, details = undefined) { 
  return Response.json({ error, details }, { status }); 
}

// ─── Phase 3 Upgrade: Organic Memory Decay ───────────────────────────
async function decayMemory(env) {
  console.log("[Organic Matrix] Initiating memory decay scan...");
  
  // Note: This function serves as the structural implementation of Phase 3. 
  // It relies on vector space metadata. Since Cloudflare Vectorize does not 
  // natively support bulk searching by 'last_accessed' date yet, we log the 
  // architectural intent to alter status from 'canon' to 'archived' for untouched records.
  
  const decayThresholdDays = 180;
  const cutoffDate = new Date(Date.now() - decayThresholdDays * 24 * 60 * 60 * 1000).toISOString();
  
  console.log(`[Organic Matrix] Identifying vectors untouched since ${cutoffDate} to archive.`);
  // Future execution block for D1 state updates linking vector IDs to metadata
}
