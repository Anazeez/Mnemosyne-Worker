const OBSERVATION_FIELDS = Object.freeze([
  "weekly_remaining",
  "reset_at",
  "credits_remaining",
  "observed_at",
]);

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = Object.freeze({
  name: "codex-usage-bridge",
  version: "0.2.0",
});
const MAX_BODY_BYTES = 64 * 1024;

const MCP_TOOL = Object.freeze({
  name: "get_codex_usage",
  description: "Read the latest verified Codex usage observation.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
});

const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
});

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

function configuredToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function tokenPath(pathname, route, expectedToken) {
  const parts = pathname.split("/");
  return parts.length === 3
    && parts[0] === ""
    && parts[1] === route
    && constantTimeEqual(parts[2], expectedToken);
}

function exactKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === OBSERVATION_FIELDS.slice().sort().join("\u0000");
}

function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function sanitizeObservation(value) {
  if (!exactKeys(value)) return null;
  if (!Number.isInteger(value.weekly_remaining) || value.weekly_remaining < 0 || value.weekly_remaining > 100) {
    return null;
  }
  if (!Number.isInteger(value.credits_remaining) || value.credits_remaining < 0) {
    return null;
  }
  if (!validTimestamp(value.reset_at) || !validTimestamp(value.observed_at)) {
    return null;
  }
  return {
    weekly_remaining: value.weekly_remaining,
    reset_at: value.reset_at,
    credits_remaining: value.credits_remaining,
    observed_at: value.observed_at,
  };
}

async function readBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return null;
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function stateStub(env) {
  const id = env.USAGE_STATE.idFromName("codex-owner");
  return env.USAGE_STATE.get(id);
}

async function stateRequest(env, operation, observation) {
  const response = await stateStub(env).fetch("https://state.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, observation }),
  });
  if (!response.ok) throw new Error("state_unavailable");
  return response.json();
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result }, 200, {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  });
}

function rpcError(id, code, message) {
  return json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  }, 400, { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION });
}

async function handleMcp(request, env) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST", ...NO_STORE_HEADERS } });
  }
  const body = await readBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return rpcError(null, -32700, "Invalid JSON");
  }
  const id = body.id ?? null;
  if (body.method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: NO_STORE_HEADERS });
  }
  if (body.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (body.method === "tools/list") {
    return rpcResult(id, { tools: [MCP_TOOL] });
  }
  if (body.method !== "tools/call") {
    return rpcError(id, -32601, "Method not found");
  }
  const params = body.params;
  if (!params || params.name !== MCP_TOOL.name || (params.arguments ?? {}) instanceof Array) {
    return rpcError(id, -32602, "Unknown tool");
  }
  if (params.arguments && Object.keys(params.arguments).length !== 0) {
    return rpcError(id, -32602, "The usage tool takes no arguments");
  }
  let state;
  try {
    state = await stateRequest(env, "read");
  } catch {
    return rpcResult(id, {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: {
            code: "NO_OBSERVATION",
            message: "No verified usage observation is available",
          },
        }),
      }],
      isError: true,
    });
  }
  const observation = sanitizeObservation(state?.observation);
  if (!observation) {
    return rpcResult(id, {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: {
            code: "NO_OBSERVATION",
            message: "No verified usage observation is available",
          },
        }),
      }],
      isError: true,
    });
  }
  const text = JSON.stringify(observation);
  return rpcResult(id, {
    content: [{ type: "text", text }],
    structuredContent: observation,
  });
}

async function handleIngestion(request, env) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST", ...NO_STORE_HEADERS } });
  }
  const body = await readBody(request);
  const observation = sanitizeObservation(body);
  if (!observation) return json({ error: "invalid_observation" }, 400);
  try {
    await stateRequest(env, "write", observation);
  } catch {
    return json({ error: "state_unavailable" }, 503);
  }
  return json({ ok: true });
}

export class UsageState {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const body = await request.json();
    const observations = (await this.state.storage.get("observations")) || [];
    if (body.operation === "read") {
      return json({ observation: observations.at(-1) ?? null });
    }
    if (body.operation === "write") {
      const observation = sanitizeObservation(body.observation);
      if (!observation) return json({ error: "invalid_observation" }, 400);
      const next = observations.filter(item => item.observed_at !== observation.observed_at);
      next.push(observation);
      await this.state.storage.put("observations", next.slice(-256));
      return json({ ok: true });
    }
    return json({ error: "unsupported_operation" }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!configuredToken(env.CAPABILITY_TOKEN) || !configuredToken(env.INGEST_TOKEN)) {
      return json({ error: "service_not_configured" }, 503);
    }
    if (url.pathname === "/health" || url.pathname === "/health/") {
      return unauthorized();
    }
    if (url.pathname.startsWith("/health/")) {
      if (!tokenPath(url.pathname, "health", env.CAPABILITY_TOKEN)) return unauthorized();
      return json({ status: "ok", backend: "durable-object" });
    }
    if (url.pathname.startsWith("/mcp")) {
      if (!tokenPath(url.pathname, "mcp", env.CAPABILITY_TOKEN)) return unauthorized();
      return handleMcp(request, env);
    }
    if (url.pathname.startsWith("/ingest")) {
      if (!tokenPath(url.pathname, "ingest", env.INGEST_TOKEN)) return unauthorized();
      return handleIngestion(request, env);
    }
    return json({ error: "not_found" }, 404);
  },
};
