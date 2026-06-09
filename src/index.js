/**
 * Project Mnemosyne — Mnemosyne's Matrix
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker:  mnemosyne-worker
 * Role:    Vector memory ingestion and retrieval for Project Infinitum
 * Model:   @cf/baai/bge-large-en-v1.5  (1024 dims, cosine)
 *
 * Routes:
 *   GET  /ping    → health check
 *   POST /ingest  → parse, embed, upsert document sections
 *   POST /query   → embed query, search index, return matches
 *
 * Indexes (Mnemosyne's Matrix):
 *   MATRIX_KNOWLEDGE → doctrine, protocols, runtime, handoff contracts
 *   MATRIX_AGENTS    → roles, specialist DNA, destination registry
 *   MATRIX_SKILLS    → skill definitions, capability maps
 *   MATRIX_FILES     → uploaded artifacts, session outputs
 *
 * Auth:
 *   Header: X-Matrix-Key → must match MATRIX_AUTH_KEY secret
 *
 * Retrieval threshold: 0.85  (per Sentinel DNA spec)
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

const EMBEDDING_MODEL    = '@cf/baai/bge-large-en-v1.5';
const RETRIEVAL_THRESHOLD = 0.85; // Sentinel DNA spec

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {

    // Auth gate
    const authKey = request.headers.get('X-Matrix-Key');
    if (authKey !== env.MATRIX_AUTH_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const url    = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/ping' && method === 'GET') {
      return Response.json({
        status:    'alive',
        project:   'Project Mnemosyne',
        worker:    'mnemosyne-worker',
        matrix:    Object.keys(INDEX_BINDING),
        model:     EMBEDDING_MODEL,
        threshold: RETRIEVAL_THRESHOLD
      });
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

// ─── Ingest Handler ───────────────────────────────────────────────────────────

async function handleIngest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { file_name, content, index_override, version = 'unknown' } = body;

  if (!file_name || !content) {
    return Response.json({ error: 'file_name and content are required' }, { status: 400 });
  }

  const sections = parseMarkdownSections(content);

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

    // Generate embedding
    let embeddingResponse;
    try {
      embeddingResponse = await env.AI.run(EMBEDDING_MODEL, {
        text: [section.content.slice(0, 2000)]
      });
    } catch (e) {
      errors.push({ section: section.title, error: `Embedding failed: ${e.message}` });
      continue;
    }

    const vector      = embeddingResponse.data[0];
    const safeFileName = file_name.replace(/[^a-zA-Z0-9]/g, '_');
    const id          = `${safeFileName}_s${String(section.number).padStart(3, '0')}`;

    // Upsert into the Matrix
    try {
      await matrixIndex.upsert([{
        id,
        values: vector,
        metadata: {
          file:           file_name,
          section_number: String(section.number),
          section_title:  section.title,
          version,
          index:          indexKey,
          preview:        section.content.slice(0, 500),
          ingested_at:    new Date().toISOString()
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
      chars:   section.content.length
    });
  }

  return Response.json({
    file:              file_name,
    version,
    sections_found:    sections.length,
    sections_ingested: results.length,
    errors_count:      errors.length,
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

  // Embed the query
  let embeddingResponse;
  try {
    embeddingResponse = await env.AI.run(EMBEDDING_MODEL, {
      text: [query]
    });
  } catch (e) {
    return Response.json({ error: `Embedding failed: ${e.message}` }, { status: 500 });
  }

  const queryVector = embeddingResponse.data[0];

  // Search the Matrix
  let queryResult;
  try {
    queryResult = await matrixIndex.query(queryVector, {
      topK:           top_k,
      returnMetadata: true
    });
  } catch (e) {
    return Response.json({ error: `Matrix query failed: ${e.message}` }, { status: 500 });
  }

  // Apply Sentinel's 0.85 threshold
  const allMatches      = queryResult.matches || [];
  const filteredMatches = allMatches.filter(m => m.score >= RETRIEVAL_THRESHOLD);

  return Response.json({
    query,
    index,
    threshold:       RETRIEVAL_THRESHOLD,
    total_raw:       allMatches.length,
    above_threshold: filteredMatches.length,
    results: filteredMatches.map(m => ({
      score:   Number(m.score.toFixed(4)),
      file:    m.metadata?.file,
      section: m.metadata?.section_title,
      version: m.metadata?.version,
      preview: m.metadata?.preview,
      index:   m.metadata?.index
    }))
  });
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
