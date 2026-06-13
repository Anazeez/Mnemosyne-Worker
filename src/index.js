/**
 * Project Mnemosyne — Mnemosyne's Matrix (EQUILIBRIUM-COMPLIANT)
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker:  mnemosyne-worker
 * Role:    Vector memory ingestion and retrieval for Project Infinitum
 * Model:   @cf/baai/bge-large-en-v1.5  (1024 dims, cosine)
 *
 * CRITICAL: This worker enforces the Well Equilibrium.
 * Layer 0 (canon) is sacred. Layer 1 (Vectorize/D1) is shadow.
 * Deterministic validation PRECEDES probabilistic indexing.
 *
 * Routes:
 *   GET  /ping    → health check (no auth)
 *   POST /hash    → compute canonical body sha256 for a document (no ingest)
 *   POST /ingest  → validate frontmatter, verify hash, embed, upsert sections
 *   POST /query   → embed query, search index, return matches with citations
 *
 * Indexes (Mnemosyne's Matrix):
 *   MATRIX_KNOWLEDGE → doctrine, protocols, runtime, handoff contracts
 *   MATRIX_AGENTS    → roles, specialist DNA, destination registry
 *   MATRIX_SKILLS    → skill definitions, capability maps
 *   MATRIX_FILES     → uploaded artifacts, session outputs
 *
 * Auth:
 *   Header: X-Matrix-Key → must match MATRIX_AUTH_KEY secret
 *   /ping is exempt from auth
 *
 * v2 FIXES (2026-06-13):
 *   • returnMetadata: 'all'  (V2 string enum — boolean true returns no
 *     metadata, which silently destroys all citations)
 *   • New POST /hash route — returns the canonical sha256 the gate will
 *     compute, so عِز can paste the correct hash into frontmatter before
 *     admission. Removes the entire hash-mismatch failure class.
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
  files:     'MATRIX_FILES'
};

const EMBEDDING_MODEL     = '@cf/baai/bge-large-en-v1.5';
const RETRIEVAL_THRESHOLD = 0.85;

// ─── Well Frontmatter Schema ──────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_FIELDS = [
  'id', 'title', 'created', 'status',
  'sha256', 'parents', 'sources', 'tags', 'schema'
];

const VALID_STATUS_VALUES = ['intake', 'canon', 'sealed'];

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {

    const url    = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/ping' && method === 'GET') {
      return Response.json({
        status:      'alive',
        project:     'Project Mnemosyne',
        worker:      'mnemosyne-worker',
        matrix:      Object.keys(INDEX_BINDING),
        model:       EMBEDDING_MODEL,
        threshold:   RETRIEVAL_THRESHOLD,
        equilibrium: 'enforced'
      });
    }

    const authKey = request.headers.get('X-Matrix-Key');
    if (authKey !== env.MATRIX_AUTH_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (url.pathname === '/hash' && method === 'POST') {
      return handleHash(request);
    }

    if (url.pathname === '/ingest' && method === 'POST') {
      return handleIngest(request, env);
    }

    if (url.pathname === '/query' && method === 'POST') {
      return handleQuery(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

// ─── Hash Helper (no ingest, no writes) ──────────────────────────────────────
// Send the FULL document (frontmatter + body). The worker strips frontmatter
// exactly as the gate does and returns the sha256 it would expect to find in
// the frontmatter. Paste that value into the document's sha256 field.
// If the document has no frontmatter, the whole normalized content is hashed.

async function handleHash(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { content } = body;

  if (!content) {
    return Response.json({ error: 'content is required' }, { status: 400 });
  }

  let target       = content;
  let hadFrontmatter = false;

  try {
    const parsed   = parseFrontmatter(content);
    target         = parsed.body;
    hadFrontmatter = true;
  } catch {
    // No frontmatter — hash the whole normalized content.
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

async function handleIngest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { file_name, content, index_override } = body;

  if (!file_name || !content) {
    return Response.json({ error: 'file_name and content are required' }, { status: 400 });
  }

  // ─── DETERMINISTIC GATE ───────────────────────────────────────────────────

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

  // FIX: await async hash — was getRandomValues (random!), now SHA-256
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

  // ─── GATE PASSED ──────────────────────────────────────────────────────────

  const sections = parseMarkdownSections(bodyContent);

  if (sections.length === 0) {
    return Response.json({ error: 'No parseable sections found in content' }, { status: 400 });
  }

  const results = [];
  const errors  = [];

  for (const section of sections) {

    const indexKey    = index_override || routeSection(section.title);
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
          created:        frontmatter.created
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
    results,
    errors
  });
}

// ─── Query Handler ────────────────────────────────────────────────────────────

async function handleQuery(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { query, index = 'knowledge', top_k = 5 } = body;

  if (!query) {
    return Response.json({ error: 'query is required' }, { status: 400 });
  }

  const bindingName = INDEX_BINDING[index];
  const matrixIndex = env[bindingName];

  if (!matrixIndex) {
    return Response.json({ error: `Unknown index: ${index}` }, { status: 400 });
  }

  let embeddingResponse;
  try {
    embeddingResponse = await env.AI.run(EMBEDDING_MODEL, {
      text: [query]
    });
  } catch (e) {
    return Response.json({ error: `Embedding failed: ${e.message}` }, { status: 500 });
  }

  const queryVector = embeddingResponse.data[0];

  let queryResult;
  try {
    // FIX: V2 Vectorize requires the string enum 'all'.
    // Boolean true silently returns no metadata → citations become
    // undefined#undefined → no valid Well citations.
    queryResult = await matrixIndex.query(queryVector, {
      topK:           top_k,
      returnMetadata: 'all'
    });
  } catch (e) {
    return Response.json({ error: `Matrix query failed: ${e.message}` }, { status: 500 });
  }

  const allMatches      = queryResult.matches || [];
  const filteredMatches = allMatches.filter(m => m.score >= RETRIEVAL_THRESHOLD);

  return Response.json({
    query,
    index,
    threshold:       RETRIEVAL_THRESHOLD,
    total_raw:       allMatches.length,
    above_threshold: filteredMatches.length,
    results: filteredMatches.map(m => ({
      score:    Number(m.score.toFixed(4)),
      file:     m.metadata?.file,
      path:     m.metadata?.path,
      sha256:   m.metadata?.sha256,
      section:  m.metadata?.section_title,
      status:   m.metadata?.status,
      preview:  m.metadata?.preview,
      index:    m.metadata?.index,
      citation: `${m.metadata?.path}#${m.metadata?.sha256}`
    }))
  });
}

// ─── Frontmatter Parser ───────────────────────────────────────────────────────
// FIX: both delimiters use trimEnd().startsWith('---')
// Handles ----- (five dashes) used in equilibrium.md and well-canon-spec.md
// Opening: permissive — catches ---, -----, --- etc.
// Closing: same — finds first delimiter line after opening

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

// ─── Minimal YAML Parser ──────────────────────────────────────────────────────

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
      result[key] = value.slice(1, -1).split(',').map(v => v.trim());
    } else if (value.startsWith('"') && value.endsWith('"')) {
      result[key] = value.slice(1, -1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ─── Body Hash Computation (Layer 0 Integrity) ───────────────────────────────
// FIX: was crypto.getRandomValues (random every call) → now crypto.subtle.digest
// FIX: async — must be awaited in handleIngest

async function computeBodyHash(body) {
  const normalized = body
    .replace(/\r\n/g, '\n')
    .trim();

  const encoder    = new TextEncoder();
  const data       = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Markdown Section Parser ──────────────────────────────────────────────────

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

// ─── Section Router ───────────────────────────────────────────────────────────

function routeSection(title) {
  const t = title.toLowerCase();

  for (const [indexKey, keywords] of Object.entries(SECTION_ROUTING)) {
    if (keywords.some(kw => t.includes(kw))) {
      return indexKey;
    }
  }

  return 'knowledge';
}
