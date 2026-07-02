/**
 * Project Mnemosyne — Mnemosyne's Matrix (EQUILIBRIUM-COMPLIANT)
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker:  mnemosyne-worker
 * Role:    Governed vector memory, identity authorization, mandate dispatch,
 *          and buffered persona-mesh ingress.
 * Model:   @cf/baai/bge-large-en-v1.5  (1024 dims, cosine)
 *
 * Exchange transport:
 * - Mandates remain the formal actionable channel.
 * - Exchanges remain the asynchronous material / handoff channel.
 * - Email ingress is buffered by MATRIX_EMAIL_QUEUE when bound.
 * - Inline queue payloads are capped below Cloudflare's 128 KB message limit.
 * - Oversized payloads are placed in MATRIX_ARTIFACTS (R2) and queued by pointer.
 */

// ─── Routing Table ────────────────────────────────────────────────────────────

const SECTION_ROUTING = {
  agents:    ['names', 'roles', 'specialist', 'destination', 'registry', 'haava', 'boundary'],
  knowledge: ['identity', 'layer', 'protocols', 'handoff', 'runtime', 'automation', 'doctrine'],
  skills:    ['skill', 'capability', 'ledger'],
  files:     ['artifact', 'output', 'session', 'upload']
};

const INDEX_BINDING = {
  knowledge: 'MATRIX_KNOWLEDGE',
  agents:    'MATRIX_AGENTS',
  skills:    'MATRIX_SKILLS',
  files:     'MATRIX_FILES',
  library:   'MATRIX_LIBRARY'
};

const EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';
const RETRIEVAL_THRESHOLD = 0.65;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 25;
const MAX_INLINE_QUEUE_BYTES = 64_000;
const REQUIRED_FRONTMATTER_FIELDS = [
  'id', 'title', 'created', 'status',
  'sha256', 'parents', 'sources', 'tags', 'schema'
];
const VALID_STATUS_VALUES = ['intake', 'canon', 'sealed'];

const CAPABILITY = {
  MEMORY_SEARCH:          'memory.search',
  MEMORY_INGEST:          'memory.ingest',
  HASH:                   'memory.hash',
  MANDATES_READ:          'mandates.read',
  MANDATES_ACK:           'mandates.ack',
  MANDATES_DRAFT:         'mandates.draft',
  MANDATES_DISPATCH:      'mandates.dispatch',
  ROUTER_STATUS:          'router.status',
  EXCHANGES_DISPATCH:     'exchanges.dispatch',
  EXCHANGES_INBOX:        'exchanges.inbox',
  EXCHANGES_HISTORY:      'exchanges.history',
  EXCHANGES_ARTIFACT_READ:'exchanges.artifact.read'
};

const LEGACY_ARCHITECT_PRINCIPAL = {
  principal_id: 'architectus',
  class: 'orchestrator',
  capabilities: ['*'],
  memory_domains: ['*']
};

// ─── Main Export (Entry Points) ──────────────────────────────────────────────

export default {
  // 1. HTTP Fetch Handler
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/ping' && method === 'GET') {
      return Response.json({
        status: 'alive',
        project: 'Project Mnemosyne',
        worker: 'mnemosyne-worker',
        api: 'v1-governed-memory',
        matrix: Object.keys(INDEX_BINDING),
        model: EMBEDDING_MODEL,
        threshold: RETRIEVAL_THRESHOLD,
        equilibrium: 'enforced',
        identity: 'enabled',
        mandates: Boolean(env.DB) ? 'd1-enabled' : 'd1-not-bound',
        email_route: Boolean(env.MATRIX_MAIL) ? 'active-event-driven' : 'missing-binding',
        queue_state: Boolean(env.MATRIX_EMAIL_QUEUE) ? 'buffered-pipeline-active' : 'no-queue-binding',
        artifacts: Boolean(env.MATRIX_ARTIFACTS) ? 'r2-enabled' : 'inline-only'
      });
    }

    const auth = authenticateRequest(request, env);
    if (!auth.ok) {
      return jsonError(auth.error, auth.status);
    }

    const principal = auth.principal;

    try {
      if (url.pathname === '/hash' && method === 'POST') {
        requireCapability(principal, CAPABILITY.HASH);
        return handleHash(request);
      }

      if (url.pathname === '/ingest' && method === 'POST') {
        requireCapability(principal, CAPABILITY.MEMORY_INGEST);
        return handleIngest(request, env, principal);
      }

      if (url.pathname === '/query' && method === 'POST') {
        requireCapability(principal, CAPABILITY.MEMORY_SEARCH);
        return handleMemorySearch(request, env, principal, { legacy: true });
      }

      if (url.pathname === '/v1/memory/self' && method === 'GET') {
        return handleMemorySelf(principal);
      }

      if (url.pathname === '/v1/memory/search' && method === 'POST') {
        requireCapability(principal, CAPABILITY.MEMORY_SEARCH);
        return handleMemorySearch(request, env, principal, { legacy: false });
      }

      if (url.pathname === '/v1/mandates/inbox' && method === 'GET') {
        requireCapability(principal, CAPABILITY.MANDATES_READ);
        return handleMandateInbox(env, principal);
      }

      const acknowledgeMatch = url.pathname.match(/^\/v1\/mandates\/([^/]+)\/acknowledge$/);
      if (acknowledgeMatch && method === 'POST') {
        requireCapability(principal, CAPABILITY.MANDATES_ACK);
        return handleMandateAcknowledge(env, principal, acknowledgeMatch[1]);
      }

      if (url.pathname === '/v1/router/mandates/draft' && method === 'POST') {
        requireCapability(principal, CAPABILITY.MANDATES_DRAFT);
        return handleMandateDraft(request, principal);
      }

      if (url.pathname === '/v1/router/mandates/dispatch' && method === 'POST') {
        requireCapability(principal, CAPABILITY.MANDATES_DISPATCH);
        return handleMandateDispatch(request, env, principal);
      }

      if (url.pathname === '/v1/router/status' && method === 'GET') {
        requireCapability(principal, CAPABILITY.ROUTER_STATUS);
        return handleRouterStatus(env, principal);
      }

      // ─── Persona Mesh Exchange HTTP Handlers ───────────────────────────────

      if (url.pathname === '/v1/exchanges/dispatch' && method === 'POST') {
        requireCapability(principal, CAPABILITY.EXCHANGES_DISPATCH);
        return handleExchangeDispatch(request, env, principal);
      }

      if (url.pathname === '/v1/exchanges/inbox' && method === 'GET') {
        requireCapability(principal, CAPABILITY.EXCHANGES_INBOX);
        return handleExchangeInbox(env, principal);
      }

      if (url.pathname === '/v1/exchanges/history' && method === 'GET') {
        requireCapability(principal, CAPABILITY.EXCHANGES_HISTORY);
        return handleExchangeHistory(env, principal);
      }

      const artifactMatch = url.pathname.match(/^\/v1\/exchanges\/([^/]+)\/artifact$/);
      if (artifactMatch && method === 'GET') {
        requireCapability(principal, CAPABILITY.EXCHANGES_ARTIFACT_READ);
        return handleExchangeArtifact(env, principal, artifactMatch[1]);
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (e instanceof AuthzError) {
        return jsonError(e.message, e.status, e.details);
      }
      console.error('Unhandled worker error:', e);
      return jsonError('Internal worker error', 500);
    }
  },

  // 2. External Email Ingress
  async email(message, env, ctx) {
    const sender = String(message.from || '').trim().toLowerCase() || 'unknown';
    const recipient = String(message.to || '').trim().toLowerCase();
    const recipientPersona = deriveRecipientPersona(recipient);
    const subject = message.headers.get('subject') || 'Automated Mesh Exchange';
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
        // Queue is the primary buffer. Do not fall through to D1 on a queue-backed path.
        await env.MATRIX_EMAIL_QUEUE.send(ingress);
        console.log(`[Queue Pipeline] Buffered exchange ${exchangeId} for ${recipientPersona}`);
      } else {
        // Direct D1 mode is only a no-queue fallback.
        ensureD1(env);
        await archiveExchangeRecord(env, buildExchangeRecordFromIngress(ingress, 'direct'));
        console.log(`[Direct Ingress] Stored exchange ${exchangeId} for ${recipientPersona}`);
      }
    } catch (err) {
      console.error(`[Email Intercept Exception]: ${err.message}`);
      throw err;
    }

    const mirrorDestination = env.MATRIX_MAIL_FORWARD_TO || 'izeesub@gmail.com';
    if (mirrorDestination && message.canBeForwarded) {
      ctx.waitUntil(
        message.forward(mirrorDestination).catch(err => {
          console.error(`[Email Mirror Exception]: ${err.message}`);
        })
      );
    }
  },

  // 3. Queue Consumer Handler (drains buffered email ingress into D1)
  async queue(batch, env) {
    ensureD1(env);

    for (const message of batch.messages) {
      try {
        const ingress = normalizeQueuedIngress(message.body, message.id);
        await archiveExchangeRecord(env, buildExchangeRecordFromIngress(ingress, 'queue'));

        // Explicit acknowledgement only after a successful, idempotent D1 write.
        message.ack();
        console.log(`[Queue Consumer] Stored exchange ${ingress.exchange_id} for ${ingress.recipient_persona}`);
      } catch (err) {
        console.error(`[Queue Consumer Exception] Failed queue slot ${message.id}: ${err.message}`);

        // A caught exception would otherwise let the batch complete successfully.
        // Explicit retry preserves the message for Cloudflare retry / DLQ handling.
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
  const authKey = request.headers.get('X-Matrix-Key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!authKey) {
    return { ok: false, status: 401, error: 'Missing action key' };
  }

  if (env.MATRIX_AUTH_KEY && authKey === env.MATRIX_AUTH_KEY) {
    return { ok: true, principal: LEGACY_ARCHITECT_PRINCIPAL };
  }

  const principal = principalFromScopedKey(authKey, env);
  if (!principal) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  return { ok: true, principal: normalizePrincipal(principal) };
}

function principalFromScopedKey(authKey, env) {
  let records = env.MATRIX_PRINCIPAL_KEYS || env.MNEMOSYNE_PRINCIPAL_KEYS;
  if (!records) return null;

  if (typeof records === 'string') {
    try {
      records = JSON.parse(records);
    } catch (e) {
      console.error('Failed to parse MATRIX_PRINCIPAL_KEYS:', e.message);
      return null;
    }
  }

  if (Array.isArray(records)) {
    const record = records.find(item =>
      item?.key === authKey ||
      item?.action_key === authKey
    );
    return unwrapPrincipalRecord(record);
  }

  if (typeof records === 'object') {
    return unwrapPrincipalRecord(records[authKey]);
  }

  return null;
}

function unwrapPrincipalRecord(record) {
  if (!record) return null;

  if (record.principal) {
    return {
      ...record.principal,
      capabilities:
        record.principal.capabilities ||
        record.capabilities,
      memory_domains:
        record.principal.memory_domains ||
        record.principal.allowed_domains ||
        record.memory_domains ||
        record.allowed_domains
    };
  }

  const { key, action_key, ...principal } = record;
  return principal;
}

function normalizePrincipal(principal) {
  return {
    principal_id: String(
      principal.principal_id ||
      principal.id ||
      principal.name ||
      'unknown'
    ),
    class: String(
      principal.class ||
      principal.type ||
      'standard'
    ),
    capabilities: normalizeStringList(principal.capabilities),
    memory_domains: normalizeStringList(
      principal.memory_domains ||
      principal.allowed_domains ||
      principal.domains
    )
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function hasCapability(principal, capability) {
  return principal.capabilities.includes('*') || principal.capabilities.includes(capability);
}

function requireCapability(principal, capability) {
  if (!hasCapability(principal, capability)) {
    throw new AuthzError(`Principal lacks capability: ${capability}`, 403, {
      principal_id: principal.principal_id,
      required: capability
    });
  }
}

function allowedDomains(principal) {
  const allDomains = Object.keys(INDEX_BINDING);
  if (principal.memory_domains.includes('*')) return allDomains;
  return principal.memory_domains.filter(domain => domain in INDEX_BINDING);
}

function resolveSearchDomains(requestedIndex, principal) {
  const allowed = allowedDomains(principal);

  if (requestedIndex === 'all') {
    return allowed;
  }

  if (!(requestedIndex in INDEX_BINDING)) {
    throw new AuthzError(`Unknown memory domain: ${requestedIndex}`, 400);
  }

  if (!allowed.includes(requestedIndex)) {
    throw new AuthzError(`Principal is not allowed to search memory domain: ${requestedIndex}`, 403, {
      principal_id: principal.principal_id,
      allowed_domains: allowed
    });
  }

  return [requestedIndex];
}

// ─── v1 Memory API ────────────────────────────────────────────────────────────

function handleMemorySelf(principal) {
  return Response.json({
    principal_id: principal.principal_id,
    class: principal.class,
    capabilities: principal.capabilities,
    memory_domains: allowedDomains(principal)
  });
}

async function handleMemorySearch(request, env, principal, { legacy }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const query = body.query;
  const index = body.index || 'knowledge';
  const topK = sanitizeTopK(body.top_k ?? body.topK ?? DEFAULT_TOP_K);

  if (!query) {
    return jsonError('query is required', 400);
  }

  const domains = resolveSearchDomains(index, principal);

  let embeddingResponse;
  try {
    embeddingResponse = await env.AI.run(EMBEDDING_MODEL, { text: [query] });
  } catch (e) {
    return jsonError(`Embedding failed: ${e.message}`, 500);
  }

  const queryVector = embeddingResponse.data?.[0];
  if (!queryVector) {
    return jsonError('Embedding returned no vector', 500);
  }

  const combined = [];
  const errors = [];

  for (const domain of domains) {
    const bindingName = INDEX_BINDING[domain];
    const matrixIndex = env[bindingName];

    if (!matrixIndex) {
      errors.push({ index: domain, error: `No binding found for index: ${domain}` });
      continue;
    }

    try {
      const queryResult = await matrixIndex.query(queryVector, {
        topK,
        returnMetadata: 'all'
      });
      for (const match of queryResult.matches || []) {
        combined.push({ ...match, resolved_index: domain });
      }
    } catch (e) {
      errors.push({ index: domain, error: `Matrix query failed: ${e.message}` });
    }
  }

  const sortedMatches = combined.sort((a, b) => b.score - a.score);
  const filteredMatches = sortedMatches
    .filter(m => m.score >= RETRIEVAL_THRESHOLD)
    .slice(0, topK);

  const payload = {
    query,
    index,
    searched_indexes: domains,
    threshold: RETRIEVAL_THRESHOLD,
    total_raw: combined.length,
    above_threshold: filteredMatches.length,
    principal_id: principal.principal_id,
    errors,
    results: filteredMatches.map(formatVectorMatch)
  };

  if (legacy) return Response.json(payload);

  return Response.json({
    ...payload,
    api: '/v1/memory/search'
  });
}

function formatVectorMatch(m) {
  const metadata = m.metadata || {};
  return {
    score: Number(m.score.toFixed(4)),
    file: metadata.file,
    path: metadata.path,
    sha256: metadata.sha256,
    section: metadata.section_title,
    status: metadata.status,
    preview: metadata.preview,
    index: metadata.index || m.resolved_index,
    citation: metadata.path && metadata.sha256 ? `${metadata.path}#${metadata.sha256}` : null
  };
}

function sanitizeTopK(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TOP_K;
  return Math.min(parsed, MAX_TOP_K);
}

// ─── Mandate API ──────────────────────────────────────────────────────────────

async function handleMandateDraft(request, principal) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const draft = buildMandateDraft(body, principal);
  return Response.json({
    status: 'drafted',
    mandate: draft,
    note: 'Draft only. Nothing was dispatched.'
  });
}

async function handleMandateDispatch(request, env, principal) {
  ensureD1(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const mandate = buildMandateDraft(body, principal);
  const recipients = resolveMandateRecipients(env, principal);
  if (recipients.length === 0) {
    return jsonError('No eligible mandate recipients found', 400);
  }

  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO mandates (mandate_id, title, body, created_by, created_at, expires_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    mandate.mandate_id,
    mandate.title,
    mandate.body,
    principal.principal_id,
    now,
    mandate.expires_at,
    'dispatched'
  ).run();

  for (const recipient of recipients) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO mandate_recipients (mandate_id, recipient_id, acknowledged_at)
      VALUES (?, ?, NULL)
    `).bind(mandate.mandate_id, recipient).run();
  }

  return Response.json({
    status: 'dispatched',
    mandate_id: mandate.mandate_id,
    recipients,
    created_by: principal.principal_id,
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
    JOIN mandates m ON m.mandate_id = r.mandate_id
    WHERE r.recipient_id = ?
      AND m.state IN ('dispatched', 'active')
      AND m.expires_at > ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `).bind(principal.principal_id, now).all();

  return Response.json({
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
  `).bind(now, mandateId, principal.principal_id).run();

  const changed = result.meta?.changes || 0;
  if (changed === 0) {
    return jsonError('Mandate not found for this principal', 404);
  }

  return Response.json({
    status: 'acknowledged',
    mandate_id: mandateId,
    principal_id: principal.principal_id,
    acknowledged_at: now
  });
}

async function handleRouterStatus(env, principal) {
  const payload = {
    status: 'alive',
    principal_id: principal.principal_id,
    d1_bound: Boolean(env.DB),
    artifacts_bound: Boolean(env.MATRIX_ARTIFACTS),
    email_queue_bound: Boolean(env.MATRIX_EMAIL_QUEUE),
    memory_domains: Object.keys(INDEX_BINDING),
    mandate_tables: 'unknown'
  };

  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1 FROM mandates LIMIT 1').first();
      payload.mandate_tables = 'available';
    } catch (e) {
      payload.mandate_tables = 'missing_or_unmigrated';
      payload.mandate_error = e.message;
    }
  }

  return Response.json(payload);
}

function buildMandateDraft(body, principal) {
  const title = String(body.title || '').trim();
  const mandateBody = String(body.body || body.instructions || '').trim();

  if (!title) {
    throw new AuthzError('title is required', 400);
  }

  if (!mandateBody) {
    throw new AuthzError('body or instructions is required', 400);
  }

  const expiresAt = body.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    mandate_id: body.mandate_id || crypto.randomUUID(),
    title,
    body: mandateBody,
    created_by: principal.principal_id,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    state: 'draft'
  };
}

function resolveMandateRecipients(env, principal) {
  let records = env.MATRIX_PRINCIPAL_KEYS || env.MNEMOSYNE_PRINCIPAL_KEYS;
  if (!records) return [];

  if (typeof records === 'string') {
    try {
      records = JSON.parse(records);
    } catch (e) {
      console.error('Failed to parse MATRIX_PRINCIPAL_KEYS for recipients:', e.message);
      return [];
    }
  }

  const principals = Array.isArray(records)
    ? records.map(unwrapPrincipalRecord)
    : Object.values(records).map(unwrapPrincipalRecord);

  return [...new Set(
    principals
      .filter(Boolean)
      .map(normalizePrincipal)
      .filter(p => p.principal_id !== principal.principal_id)
      .filter(p => p.class !== 'orchestrator')
      .filter(p => p.class !== 'root')
      .filter(p => hasCapability(p, CAPABILITY.MANDATES_READ))
      .map(p => p.principal_id)
  )];
}

function sanitizeRecipients(recipients) {
  if (!Array.isArray(recipients)) return [];
  return [...new Set(
    recipients
      .map(r => String(r).trim().toLowerCase())
      .filter(r => /^[a-z0-9_-]{2,64}$/.test(r))
  )];
}

function ensureD1(env) {
  if (!env.DB) {
    throw new AuthzError('D1 binding DB is required for mandate and exchange routes', 503);
  }
}

// ─── Persona Mesh Exchange API ────────────────────────────────────────────────

async function handleExchangeDispatch(request, env, principal) {
  ensureD1(env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const recipientPersona = normalizePersonaRecipient(payload.recipient_persona);
  const chapterContext = Number(payload.chapter_context);
  const stateVersion = String(payload.state_version || '').trim();
  const payloadData = String(payload.payload_data || '').trim();

  if (!Number.isInteger(chapterContext) || chapterContext < 1) {
    return jsonError('chapter_context must be a positive integer', 400);
  }

  if (!stateVersion) {
    return jsonError('state_version is required', 400);
  }

  if (!payloadData) {
    return jsonError('payload_data is required', 400);
  }

  const exchangeId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const payloadDescriptor = await prepareTextExchangePayload(env, {
    exchange_id: exchangeId,
    recipient_persona: recipientPersona,
    source: 'api',
    payload_data: payloadData,
    content_type: String(payload.content_type || 'text/plain; charset=utf-8')
  });

  const record = {
    mandate_id: exchangeId,
    title: `Mesh Exchange [${recipientPersona} | Chapter ${chapterContext} | v${stateVersion}]`,
    body: buildExchangeLedgerBody({
      sender: principal.principal_id,
      recipient: recipientPersona,
      recipient_address: String(payload.recipient_persona || '').trim(),
      source: 'api',
      payload: payloadDescriptor
    }),
    created_by: principal.principal_id,
    created_at: createdAt,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    state: 'archived'
  };

  await archiveExchangeRecord(env, record);

  return Response.json({
    status: 'submitted',
    exchange_id: exchangeId,
    recipient_persona: recipientPersona,
    created_by: principal.principal_id,
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
    WHERE state = 'archived'
      AND (
        title LIKE 'Mesh Exchange%'
        OR title LIKE 'Mail Exchange%'
        OR title LIKE 'Queue Exchange%'
      )
      AND (
        instr(body, ?) > 0
        OR instr(body, ?) > 0
      )
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(
    `Recipient Persona: ${principal.principal_id}`,
    `Target: ${principal.principal_id}`
  ).all();

  return Response.json({
    principal_id: principal.principal_id,
    exchanges: result.results || []
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
    WHERE state = 'archived'
      AND (
        title LIKE 'Mesh Exchange%'
        OR title LIKE 'Mail Exchange%'
        OR title LIKE 'Queue Exchange%'
      )
    ORDER BY created_at DESC
    LIMIT 50
  `).all();

  return Response.json({
    principal_id: principal.principal_id,
    telemetry: result.results || []
  });
}

async function handleExchangeArtifact(env, principal, exchangeId) {
  ensureD1(env);

  if (!env.MATRIX_ARTIFACTS) {
    return jsonError('Artifact storage is not configured', 503);
  }

  const record = await env.DB.prepare(`
    SELECT mandate_id, title, body, created_by, created_at, state
    FROM mandates
    WHERE mandate_id = ?
      AND state = 'archived'
    LIMIT 1
  `).bind(exchangeId).first();

  if (!record || !isExchangeTitle(record.title)) {
    return jsonError('Exchange artifact not found', 404);
  }

  const recipient = readLedgerField(record.body, 'Recipient Persona') || readLedgerField(record.body, 'Target');
  const artifactKey = readLedgerField(record.body, 'Artifact Key');

  if (!artifactKey) {
    return jsonError('This exchange has no external artifact', 404);
  }

  const mayReadAnyExchange = principal.class === 'orchestrator' || principal.class === 'root';
  if (!mayReadAnyExchange && recipient !== principal.principal_id) {
    return jsonError('Exchange artifact is not addressed to this principal', 403);
  }

  const object = await env.MATRIX_ARTIFACTS.get(artifactKey);
  if (!object) {
    return jsonError('Artifact object is missing', 404);
  }

  const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
  const fileName = artifactKey.split('/').pop() || 'exchange-artifact';

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${sanitizeDownloadFileName(fileName)}"`,
      'X-Exchange-Id': exchangeId,
      'X-Artifact-Key': artifactKey
    }
  });
}

async function prepareEmailIngressPayload(message, env, envelope) {
  const payloadSize = Number(message.rawSize || 0);

  if (payloadSize <= MAX_INLINE_QUEUE_BYTES) {
    const rawBody = await new Response(message.raw).text();
    return {
      ...envelope,
      source: 'email',
      payload_mode: 'inline',
      payload_size: byteLength(rawBody),
      raw_body: rawBody,
      artifact_key: null,
      artifact_content_type: null
    };
  }

  if (!env.MATRIX_ARTIFACTS) {
    message.setReject(
      'Incoming artifact exceeds inline queue capacity. Configure MATRIX_ARTIFACTS or send an artifact reference.'
    );
    throw new Error('Oversized email requires MATRIX_ARTIFACTS R2 binding');
  }

  const artifactKey = buildArtifactKey('email', envelope.exchange_id, 'eml');
  await env.MATRIX_ARTIFACTS.put(artifactKey, message.raw, {
    httpMetadata: {
      contentType: 'message/rfc822'
    },
    customMetadata: {
      source: 'email',
      sender: envelope.sender,
      recipient: envelope.recipient_persona,
      exchange_id: envelope.exchange_id,
      created_at: envelope.created_at
    }
  });

  return {
    ...envelope,
    source: 'email',
    payload_mode: 'artifact',
    payload_size: payloadSize,
    raw_body: '',
    artifact_key: artifactKey,
    artifact_content_type: 'message/rfc822'
  };
}

async function prepareTextExchangePayload(env, {
  exchange_id,
  recipient_persona,
  source,
  payload_data,
  content_type
}) {
  const payloadSize = byteLength(payload_data);

  if (payloadSize <= MAX_INLINE_QUEUE_BYTES) {
    return {
      mode: 'inline',
      payload_size: payloadSize,
      data: payload_data,
      artifact_key: null,
      artifact_content_type: null
    };
  }

  if (!env.MATRIX_ARTIFACTS) {
    throw new AuthzError(
      'Payload exceeds inline exchange capacity. Configure MATRIX_ARTIFACTS or send an artifact reference.',
      413
    );
  }

  const artifactKey = buildArtifactKey(source, exchange_id, 'txt');
  await env.MATRIX_ARTIFACTS.put(artifactKey, payload_data, {
    httpMetadata: {
      contentType
    },
    customMetadata: {
      source,
      recipient: recipient_persona,
      exchange_id
    }
  });

  return {
    mode: 'artifact',
    payload_size: payloadSize,
    data: '',
    artifact_key: artifactKey,
    artifact_content_type: content_type
  };
}

function normalizeQueuedIngress(payload, fallbackExchangeId) {
  const source = String(payload?.source || 'email');
  if (source !== 'email') {
    throw new Error(`Unsupported queue payload source: ${source}`);
  }

  const recipient = String(payload?.recipient || '').trim().toLowerCase();
  const recipientPersona = String(
    payload?.recipient_persona || deriveRecipientPersona(recipient)
  ).trim().toLowerCase() || 'unmapped';
  const payloadMode = payload?.payload_mode === 'artifact' ? 'artifact' : 'inline';

  return {
    exchange_id: String(payload?.exchange_id || fallbackExchangeId),
    sender: String(payload?.sender || 'unknown').trim().toLowerCase() || 'unknown',
    recipient,
    recipient_persona: recipientPersona,
    subject: String(payload?.subject || 'Automated Mesh Exchange'),
    created_at: payload?.created_at || payload?.timestamp || new Date().toISOString(),
    source,
    payload_mode: payloadMode,
    payload_size: Number(payload?.payload_size || byteLength(String(payload?.raw_body || ''))),
    raw_body: payloadMode === 'inline' ? String(payload?.raw_body ?? payload?.rawBody ?? '') : '',
    artifact_key: payloadMode === 'artifact' ? String(payload?.artifact_key || '') : '',
    artifact_content_type: payloadMode === 'artifact'
      ? String(payload?.artifact_content_type || 'application/octet-stream')
      : null
  };
}

function buildExchangeRecordFromIngress(ingress, transport = 'queue') {
  const prefix = ingress.source === 'email'
    ? (transport === 'direct' ? 'Mail Exchange' : 'Queue Exchange')
    : 'Mesh Exchange';
  const title = ingress.source === 'email'
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
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    state: 'archived'
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
    `Sender: ${sender || 'unknown'}`,
    `Recipient Address: ${recipient_address || 'unknown'}`,
    `Recipient Persona: ${recipient || 'unmapped'}`,
    `Source: ${source || 'unknown'}`,
    `Payload Mode: ${payload.mode}`,
    `Payload Size: ${Number(payload.payload_size || 0)} bytes`
  ];

  if (payload.mode === 'artifact') {
    lines.push(`Artifact Key: ${payload.artifact_key}`);
    lines.push(`Artifact Content Type: ${payload.artifact_content_type || 'application/octet-stream'}`);
    lines.push('');
    lines.push('Payload stored in MATRIX_ARTIFACTS. Retrieve it through the exchange artifact route.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(payload.data || '');
  return lines.join('\n');
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
  `).bind(
    record.mandate_id,
    record.title,
    record.body,
    record.created_by,
    record.created_at,
    record.expires_at,
    record.state
  ).run();
}

function deriveRecipientPersona(address) {
  const localPart = String(address || '')
    .trim()
    .toLowerCase()
    .split('@')[0]
    .split('+')[0]
    .replace(/^@/, '');

  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(localPart)
    ? localPart
    : 'unmapped';
}

function normalizePersonaRecipient(value) {
  const recipient = deriveRecipientPersona(value);

  if (recipient === 'unmapped') {
    throw new AuthzError(
      'recipient_persona must be a valid persona handle or mailbox address',
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
  const line = String(body || '')
    .split('\n')
    .find(item => item.startsWith(prefix));

  return line ? line.slice(prefix.length).trim() : null;
}

function isExchangeTitle(title) {
  const value = String(title || '');
  return value.startsWith('Mesh Exchange') ||
    value.startsWith('Mail Exchange') ||
    value.startsWith('Queue Exchange');
}

function byteLength(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

function sanitizeDownloadFileName(value) {
  return String(value || 'exchange-artifact')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160);
}

// ─── Hash Helper ──────────────────────────────────────────────────────────────

async function handleHash(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { content } = body;
  if (!content) {
    return jsonError('content is required', 400);
  }

  let target = content;
  let hadFrontmatter = false;

  try {
    const parsed = parseFrontmatter(content);
    target = parsed.body;
    hadFrontmatter = true;
  } catch {
    // No frontmatter
  }

  const sha256 = await computeBodyHash(target);

  return Response.json({
    sha256,
    frontmatter_detected: hadFrontmatter,
    note: hadFrontmatter
      ? 'Hash computed on body only (frontmatter stripped). Paste this into the sha256 field.'
      : 'No frontmatter found. Hash computed on full normalized content.'
  });
}

// ─── Ingest Handler (EQUILIBRIUM GATE) ───────────────────────────────────────

async function handleIngest(request, env, principal) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { file_name, content, index_override } = body;
  if (!file_name || !content) {
    return jsonError('file_name and content are required', 400);
  }

  let frontmatter = {};
  let bodyContent = content;
  let validationError = null;

  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    bodyContent = parsed.body;
  } catch (e) {
    validationError = `Failed to parse frontmatter: ${e.message}`;
  }

  if (!validationError) {
    for (const field of REQUIRED_FRONTMATTER_FIELDS) {
      if (!(field in frontmatter)) {
        validationError = `Missing required field: ${field}`;
        break;
      }
    }
  }

  if (!validationError && !VALID_STATUS_VALUES.includes(frontmatter.status)) {
    validationError = `Invalid status: ${frontmatter.status}. Must be one of: ${VALID_STATUS_VALUES.join(', ')}`;
  }

  if (!validationError && !['canon', 'sealed'].includes(frontmatter.status)) {
    validationError = `Only canon and sealed documents may be ingested. Status is: ${frontmatter.status}`;
  }

  let computedHash = null;
  if (!validationError) {
    computedHash = await computeBodyHash(bodyContent);
    if (computedHash !== frontmatter.sha256) {
      validationError = `Hash mismatch. Stored: ${frontmatter.sha256}, Computed: ${computedHash}. Document tampered or corrupted.`;
    }
  }

  if (validationError) {
    const errorPayload = {
      file: file_name,
      error: validationError,
      status: 'VALIDATION_FAILED',
      timestamp: new Date().toISOString()
    };
    try {
      await fetch('https://pulse-alarm-engine.izeesub.workers.dev/webhook/ingest-failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorPayload)
      }).catch(() => {});
    } catch (e) {
      console.error('Webhook failed:', e.message);
    }

    return Response.json(errorPayload, { status: 422 });
  }

  const sections = parseMarkdownSections(bodyContent);
  if (sections.length === 0) {
    return jsonError('No parseable sections found in content', 400);
  }

  const results = [];
  const errors = [];
  for (const section of sections) {
    const indexKey = index_override || routeSection(section.title);
    try {
      resolveSearchDomains(indexKey, principal);
    } catch (e) {
      errors.push({ section: section.title, error: e.message });
      continue;
    }

    const bindingName = INDEX_BINDING[indexKey];
    const matrixIndex = env[bindingName];
    if (!matrixIndex) {
      errors.push({ section: section.title, error: `No binding found for index: ${indexKey}` });
      continue;
    }

    let embeddingResponse;
    try {
      embeddingResponse = await env.AI.run(EMBEDDING_MODEL, {
        text: [section.content.slice(0, 2000)]
      });
    } catch (e) {
      errors.push({ section: section.title, error: `Embedding failed: ${e.message}` });
      continue;
    }

    const vector = embeddingResponse.data[0];
    const safeFileName = file_name.replace(/[^a-zA-Z0-9]/g, '_');
    const id = `${safeFileName}_s${String(section.number).padStart(3, '0')}`;
    try {
      await matrixIndex.upsert([{
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
          ingested_by: principal.principal_id
        }
      }]);
    } catch (e) {
      errors.push({ section: section.title, error: `Upsert failed: ${e.message}` });
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
    validation: 'passed',
    principal_id: principal.principal_id,
    results,
    errors
  });
}

// ─── Frontmatter Parser ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (!lines[0]?.trimEnd().startsWith('---')) {
    throw new Error('No frontmatter delimiter found (missing opening ---)');
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd().startsWith('---')) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    throw new Error('No closing frontmatter delimiter (---) found');
  }

  const frontmatterText = lines.slice(1, endIndex).join('\n');
  const body = lines.slice(endIndex + 1).join('\n');
  let frontmatter = {};
  try {
    frontmatter = parseYAML(frontmatterText);
  } catch (e) {
    throw new Error(`YAML parse error: ${e.message}`);
  }

  return { frontmatter, body };
}

function parseYAML(yamlText) {
  const result = {};
  const lines = yamlText.split('\n');
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (value === 'null') {
      result[key] = null;
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map(v => v.trim()).filter(Boolean);
    } else if (value.startsWith('"') && value.endsWith('"')) {
      result[key] = value.slice(1, -1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

async function computeBodyHash(body) {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseMarkdownSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;
  let number = 0;
  for (const line of lines) {
    const isHeading = /^#{1,3}\s/.test(line);
    if (isHeading) {
      if (current && current.content.replace(/#+\s.*/, '').trim().length > 20) {
        sections.push(current);
      }
      number++;
      current = {
        number,
        title: line.replace(/^#+\s/, '').trim(),
        content: line + '\n'
      };
    } else if (current) {
      current.content += line + '\n';
    }
  }

  if (current && current.content.replace(/#+\s.*/, '').trim().length > 20) {
    sections.push(current);
  }

  return sections;
}

function routeSection(title) {
  const t = title.toLowerCase();

  for (const [indexKey, keywords] of Object.entries(SECTION_ROUTING)) {
    if (keywords.some(kw => t.includes(kw))) {
      return indexKey;
    }
  }

  return 'knowledge';
}

function jsonError(error, status = 400, details = undefined) {
  return Response.json({ error, details }, { status });
}
