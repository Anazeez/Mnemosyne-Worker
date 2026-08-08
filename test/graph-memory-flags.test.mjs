import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import {
  GRAPH_MEMORY_FLAGS,
  featureGatedGraphServices,
  graphMemoryFeatureState,
} from "../src/graph-memory/flags.js";

test("all graph memory rollout flags default off", () => {
  assert.deepEqual(graphMemoryFeatureState({}), {
    read: false,
    propose: false,
    validation: false,
    resolution: false,
    owner_review: false,
    owner_commit: false,
    review: false,
    publication: false,
    handoff_accept: false,
    mcp: false,
    actions: false,
  });
  assert.equal(Object.keys(GRAPH_MEMORY_FLAGS).length, 11);
});

test("feature-gated services deny before calling implementations", async () => {
  let calls = 0;
  const service = async () => {
    calls += 1;
    return "called";
  };
  const gated = featureGatedGraphServices({}, {
    rehydrateAcceptedMemory: service,
    searchAcceptedMemory: service,
    traverseAcceptedMemory: service,
    createMemoryCandidate: service,
    getOwnCandidate: service,
    acceptHandoffDraft: service,
  });
  await assert.rejects(
    gated.searchAcceptedMemory({}),
    error => error.code === "GRAPH_MEMORY_READ_DISABLED",
  );
  await assert.rejects(
    gated.createMemoryCandidate({}),
    error => error.code === "GRAPH_MEMORY_PROPOSE_DISABLED",
  );
  assert.equal(calls, 0);
});

test("read and proposal can be enabled independently", async () => {
  const calls = [];
  const service = async name => {
    calls.push(name);
    return name;
  };
  const gated = featureGatedGraphServices({
    GRAPH_MEMORY_READ_ENABLED: "1",
    GRAPH_MEMORY_PROPOSE_ENABLED: "0",
  }, {
    rehydrateAcceptedMemory: () => service("rehydrate"),
    searchAcceptedMemory: () => service("search"),
    traverseAcceptedMemory: () => service("traverse"),
    createMemoryCandidate: () => service("propose"),
    getOwnCandidate: () => service("status"),
    acceptHandoffDraft: () => service("accept"),
  });
  assert.equal(await gated.searchAcceptedMemory({}), "search");
  assert.equal(await gated.getOwnCandidate({}), "status");
  await assert.rejects(
    gated.createMemoryCandidate({}),
    error => error.code === "GRAPH_MEMORY_PROPOSE_DISABLED",
  );
  assert.deepEqual(calls, ["search", "status"]);
});

test("handoff acceptance remains separately disabled until its rollout gate is on", async () => {
  const gated = featureGatedGraphServices({}, {
    acceptHandoffDraft: async () => "accepted",
  });
  await assert.rejects(
    gated.acceptHandoffDraft({}),
    error => error.code === "GRAPH_MEMORY_HANDOFF_ACCEPT_DISABLED",
  );

  const enabled = featureGatedGraphServices({
    GRAPH_MEMORY_HANDOFF_ACCEPT_ENABLED: "1",
  }, {
    acceptHandoffDraft: async () => "accepted",
  });
  assert.equal(await enabled.acceptHandoffDraft({}), "accepted");
});

test("public health reports the exact rollout state", async () => {
  const response = await worker.fetch(
    new Request("https://memory.example/ping"),
    {
      GRAPH_MEMORY_READ_ENABLED: "1",
      GRAPH_MEMORY_MCP_ENABLED: "true",
    },
  );
  const body = await response.json();
  assert.deepEqual(body.graph_memory, {
    read: true,
    propose: false,
    validation: false,
    resolution: false,
    owner_review: false,
    owner_commit: false,
    review: false,
    publication: false,
    handoff_accept: false,
    mcp: true,
    actions: false,
  });
});
