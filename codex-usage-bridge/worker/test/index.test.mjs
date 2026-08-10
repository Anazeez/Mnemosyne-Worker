import assert from "node:assert/strict";
import test from "node:test";

import worker, { UsageState } from "../src/index.js";

const CAPABILITY_TOKEN = "capability-token-012345678901234567890123";
const INGEST_TOKEN = "ingest-token-012345678901234567890123";
const OBSERVATION = {
  weekly_remaining: 84,
  reset_at: "2026-08-15T23:51:00+03:00",
  credits_remaining: 211,
  observed_at: "2026-08-10T00:00:00+00:00",
};

class FakeState {
  constructor() {
    this.observations = [];
  }

  async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.json();
    if (body.operation === "read") {
      return Response.json({ observation: this.observations.at(-1) ?? null });
    }
    if (body.operation === "write") {
      if (!this.observations.some(item => item.observed_at === body.observation.observed_at)) {
        this.observations.push(body.observation);
      }
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unsupported_operation" }, { status: 400 });
  }
}

function makeEnv() {
  const state = new FakeState();
  return {
    CAPABILITY_TOKEN,
    INGEST_TOKEN,
    USAGE_STATE: {
      idFromName() {
        return "owner";
      },
      get() {
        return state;
      },
    },
    _state: state,
  };
}

function request(path, method = "POST", body) {
  return new Request(`https://usage.example${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Worker rejects missing and wrong capability tokens", async () => {
  const env = makeEnv();
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  assert.equal((await worker.fetch(request("/mcp", "POST", body), env)).status, 401);
  assert.equal(
    (await worker.fetch(request("/mcp/wrong-token", "POST", body), env)).status,
    401,
  );
});

test("Worker initializes and publishes exactly one read-only MCP tool", async () => {
  const env = makeEnv();
  const init = await worker.fetch(
    request(`/mcp/${CAPABILITY_TOKEN}`, "POST", {
      jsonrpc: "2.0", id: 1, method: "initialize", params: {},
    }),
    env,
  );
  assert.equal(init.status, 200);

  const listed = await worker.fetch(
    request(`/mcp/${CAPABILITY_TOKEN}`, "POST", {
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    }),
    env,
  );
  const tools = (await listed.json()).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ["get_codex_usage"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].annotations.destructiveHint, false);
});

test("collector ingestion is separately token-gated and MCP returns four fields", async () => {
  const env = makeEnv();
  const denied = await worker.fetch(
    request("/ingest/wrong-token", "POST", OBSERVATION),
    env,
  );
  assert.equal(denied.status, 401);

  const ingested = await worker.fetch(
    request(`/ingest/${INGEST_TOKEN}`, "POST", OBSERVATION),
    env,
  );
  assert.equal(ingested.status, 200);

  const called = await worker.fetch(
    request(`/mcp/${CAPABILITY_TOKEN}`, "POST", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_codex_usage", arguments: {} },
    }),
    env,
  );
  const payload = await called.json();
  assert.deepEqual(payload.result.structuredContent, OBSERVATION);
  assert.deepEqual(Object.keys(payload.result.structuredContent).sort(), [
    "credits_remaining", "observed_at", "reset_at", "weekly_remaining",
  ]);
});

test("invalid ingestion shape is rejected without state mutation", async () => {
  const env = makeEnv();
  const response = await worker.fetch(
    request(`/ingest/${INGEST_TOKEN}`, "POST", {
      ...OBSERVATION,
      openai_cookie: "must-not-be-accepted",
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(env._state.observations.length, 0);
});

test("Durable Object state retains sanitized observations and deduplicates timestamps", async () => {
  const values = new Map();
  const state = new UsageState({
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
    },
  });
  const write = () => state.fetch(new Request("https://state.internal/", {
    method: "POST",
    body: JSON.stringify({ operation: "write", observation: OBSERVATION }),
  }));
  assert.equal((await write()).status, 200);
  assert.equal((await write()).status, 200);
  const read = await state.fetch(new Request("https://state.internal/", {
    method: "POST",
    body: JSON.stringify({ operation: "read" }),
  }));
  const payload = await read.json();
  assert.deepEqual(payload.observation, OBSERVATION);
  assert.equal(values.get("observations").length, 1);
});
