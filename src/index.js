/**
 * Project Mnemosyne — Mnemosyne's Matrix (EQUILIBRIUM-COMPLIANT)
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker:  mnemosyne-worker
 * Role:    Governed vector memory, identity authorization, and mandate dispatch
 * Model:   @cf/baai/bge-large-en-v1.5  (1024 dims, cosine)
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

const EMBEDDING_MODEL     = '@cf/baai/bge-large-en-v1.5';
const RETRIEVAL_THRESHOLD = 0.65;
const DEFAULT_TOP_K       = 5;
const MAX_TOP_K           = 25;
const REQUIRED_FRONTMATTER_FIELDS = [
  'id', 'title', 'created', 'status',
  'sha256', 'parents', 'sources', 'tags', 'schema'
];
const VALID_STATUS_VALUES = ['intake', 'canon', 'sealed'];

const CAPABILITY = {
  MEMORY_SEARCH:      'memory.search',
  MEMORY_INGEST:      'memory.ingest',
  HASH:               'memory.hash',
  MANDATES_READ:      'mandates.read',
  MANDATES_ACK:       'mandates.ack',
  MANDATES_DRAFT:     'mandates.draft',
  MANDATES_DISPATCH:  'mandates.dispatch',
  ROUTER_STATUS:      'router.status'
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
    const url    = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/ping' && method === 'GET') {
      return Response.json({
        status:      'alive',
        project:     'Project Mnemosyne',
        worker:      'mnemosyne-worker',
        api:         'v1-governed-memory',
        matrix:      Object.keys(INDEX_BINDING),
        model:       EMBEDDING_MODEL,
        threshold:   RETRIEVAL_THRESHOLD,
        equilibrium: 'enforced',
        identity:    'enabled',
        mandates:    Boolean(env.DB) ? 'd1-enabled' : 'd1-not-bound',
        email_route: Boolean(env.MATRIX_MAIL) ? 'active-event-driven' : 'missing-binding',
        queue_state: Boolean(env.MATRIX_EMAIL_QUEUE) ? 'buffered-pipeline-active' : 'no-queue-binding'
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

      // ─── NEW: Persona Mesh Exchange HTTP Handlers ───
      
      // Handles dispatching versions from peer nodes
      if (url.pathname === '/v1/exchanges/dispatch' && method === 'POST') {
         let payload;
         try {
           payload = await request.json();
         } catch {
           return jsonError('Invalid JSON format', 400);
         }
         
         const { recipient_persona, chapter_context, state_version, payload_data } = payload;
         ensureD1(env);
         
         const mandateId = crypto.randomUUID();
         const defaultExpiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
         
         await env.DB.prepare(`
           INSERT INTO mandates (mandate_id, title, body, created_by, created_at, expires_at, state)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         `).bind(
           mandateId,
           `Mesh Exchange [Chapter ${chapter_context} | v${state_version}]`,
           `Target: ${recipient_persona}\nData: ${payload_data}`,
           principal.principal_id,
           new Date().toISOString(),
           defaultExpiration,
           'archived'
         ).run();
         
         return Response.json({ status: "Exchange submitted to the tracking ledger." });
      }

      // Handles the Mnemosyne Portal pulling the telemetry dashboard
      if (url.pathname === '/v1/exchanges/history' && method === 'GET') {
         ensureD1(env);
         const { results } = await env.DB.prepare(
           "SELECT * FROM mandates WHERE title LIKE 'Mesh Exchange%' ORDER BY created_at DESC LIMIT 20"
         ).all();
         return Response.json({ telemetry: results });
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

  // 2. Asynchronous Push Email Handler (Queue Producer + Email Mirroring)
  async email(message, env, ctx) {
    const sender = message.from;
    const recipient = message.to;
    const subject = message.headers.get("subject") || "Automated Mesh Exchange";
    const rawBody = await new Response(message.raw).text();

    ctx.waitUntil(
      (async () => {
        try {
          // Offload to Matrix Queue Buffer (if active)
          if (env.MATRIX_EMAIL_QUEUE) {
            await env.MATRIX_EMAIL_QUEUE.send({
              sender,
              subject,
              rawBody,
              timestamp: new Date().toISOString()
            });
            console.log(`[Queue Pipeline] Buffered incoming email from ${sender}`);
          }

          // Direct D1 Fallback Logging for immediate tracking
          if (env.DB) {
             const mandateId = crypto.randomUUID();
             const defaultExpiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
             await env.DB.prepare(`
               INSERT INTO mandates (mandate_id, title, body, created_by, created_at, expires_at, state)
               VALUES (?, ?, ?, ?, ?, ?, ?)
             `).bind(
               mandateId,
               `Mail Exchange: ${subject}`,
               `From: ${sender} | To: ${recipient}\n\n${rawBody}`,
               sender,
               new Date().toISOString(),
               defaultExpiration,
               'archived'
             ).run();
          }

          // MIRROR TO ARCHITECTUS:
          // NOTE: Update 'your.real.email@gmail.com' in the line below with your actual verified destination address!
          await message.forward("your.real.email@gmail.com");

        } catch (err) {
          console.error(`[Email Intercept Exception]: ${err.message}`);
        }
      })()
    );
  },

  // 3. Queue Consumer Handler (Drains buffer asynchronously into D1)
  async queue(batch, env, ctx) {
    ensureD1(env);

    for (const message of batch.messages) {
      const { sender, subject, rawBody, timestamp } = message.body;
      
      try {
        const mandateId = crypto.randomUUID();
        const defaultExpiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        // Safe sequence write into D1 database without blocking routing runtime
        await env.DB.prepare(`
          INSERT INTO mandates (mandate_id, title, body, created_by, created_at, expires_at, state)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          mandateId,
          `Queue Email via ${sender}: ${subject}`,
          rawBody,
          sender,
          timestamp,
          defaultExpiration,
          'dispatched'
        ).run();

        // Commit message deletion from queue
        message.ack();
        console.log(`[Queue Consumer] Successfully stored mandate ${mandateId} from queue payload.`);
      } catch (err) {
        console.error(`[Queue Consumer Exception] Failed processing queue slot: ${err.message}`);
        // No acknowledgment means Cloudflare handles automated safe redelivery
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
  const topK  = sanitizeTopK(body.top_k ?? body.topK ?? DEFAULT_TOP_K);

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
    score:    Number(m.score.toFixed(4)),
    file:     metadata.file,
    path:     metadata.path,
    sha256:   metadata.sha256,
    section:  metadata.section_title,
    status:   metadata.status,
    preview:  metadata.preview,
    index:    metadata.index || m.resolved_index,
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
    throw new AuthzError('D1 binding DB is required for mandate routes', 503);
  }
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

  let frontmatter     = {};
  let bodyContent     = content;
  let validationError = null;

  try {
    const parsed = parseFrontmatter(content);
    frontmatter  = parsed.frontmatter;
    bodyContent  = parsed.body;
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
      file:      file_name,
      error:     validationError,
      status:    'VALIDATION_FAILED',
      timestamp: new Date().toISOString()
    };
    try {
      await fetch('https://pulse-alarm-engine.izeesub.workers.dev/webhook/ingest-failure', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(errorPayload)
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
  const errors  = [];
  for (const section of sections) {
    const indexKey    = index_override || routeSection(section.title);
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

    const vector       = embeddingResponse.data[0];
    const safeFileName = file_name.replace(/[^a-zA-Z0-9]/g, '_');
    const id           = `${safeFileName}_s${String(section.number).padStart(3, '0')}`;
    try {
      await matrixIndex.upsert([{
        id,
        values:   vector,
        metadata: {
          file:           file_name,
          path:           file_name,
          sha256:         frontmatter.sha256,
          section_number: String(section.number),
          section_title:  section.title,
          status:         frontmatter.status,
          index:          indexKey,
          preview:        section.content.slice(0, 500),
          ingested_at:    new Date().toISOString(),
          document_id:    frontmatter.id,
          document_title: frontmatter.title,
          created:        frontmatter.created,
          ingested_by:    principal.principal_id
        }
      }]);
    } catch (e) {
      errors.push({ section: section.title, error: `Upsert failed: ${e.message}` });
      continue;
    }

    results.push({
      id,
      section: section.title,
      index:   indexKey,
      chars:   section.content.length,
      hash:    frontmatter.sha256,
      status:  frontmatter.status
    });
  }

  return Response.json({
    file:              file_name,
    status:            frontmatter.status,
    document_id:       frontmatter.id,
    sha256:            frontmatter.sha256,
    sections_found:    sections.length,
    sections_ingested: results.length,
    errors_count:      errors.length,
    validation:        'passed',
    principal_id:      principal.principal_id,
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
  const body            = lines.slice(endIndex + 1).join('\n');
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
  const lines  = yamlText.split('\n');
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;

    const key   = match[1];
    let   value = match[2].trim();
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
  const encoder    = new TextEncoder();
  const data       = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseMarkdownSections(content) {
  const lines    = content.split('\n');
  const sections = [];
  let current    = null;
  let number     = 0;
  for (const line of lines) {
    const isHeading = /^#{1,3}\s/.test(line);
    if (isHeading) {
      if (current && current.content.replace(/#+\s.*/, '').trim().length > 20) {
        sections.push(current);
      }
      number++;
      current = {
        number,
        title:   line.replace(/^#+\s/, '').trim(),
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
