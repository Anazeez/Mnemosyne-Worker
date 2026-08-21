import { GraphMemoryError } from "./contracts.js";

export const GRAPH_MEMORY_FLAGS = Object.freeze({
  read: "GRAPH_MEMORY_READ_ENABLED",
  propose: "GRAPH_MEMORY_PROPOSE_ENABLED",
  validation: "GRAPH_MEMORY_VALIDATION_ENABLED",
  resolution: "GRAPH_MEMORY_RESOLUTION_ENABLED",
  owner_review: "GRAPH_MEMORY_OWNER_REVIEW_ENABLED",
  owner_commit: "GRAPH_MEMORY_OWNER_COMMIT_ENABLED",
  review: "GRAPH_MEMORY_REVIEW_ENABLED",
  publication: "GRAPH_MEMORY_PUBLICATION_ENABLED",
  handoff_accept: "GRAPH_MEMORY_HANDOFF_ACCEPT_ENABLED",
  mcp: "GRAPH_MEMORY_MCP_ENABLED",
  actions: "GRAPH_MEMORY_ACTIONS_ENABLED",
});

export function graphMemoryFeatureState(env) {
  return Object.fromEntries(
    Object.entries(GRAPH_MEMORY_FLAGS).map(([name, flag]) => [
      name,
      enabled(env?.[flag]),
    ]),
  );
}

export function featureGatedGraphServices(env, services) {
  const state = graphMemoryFeatureState(env);
  const read = service => async (...arguments_) => {
    if (!state.read) throw disabled("GRAPH_MEMORY_READ_DISABLED");
    if (typeof service !== "function") throw disabled("GRAPH_MEMORY_UNAVAILABLE");
    return service(...arguments_);
  };
  return {
    rehydrateAcceptedMemory: read(services.rehydrateAcceptedMemory),
    searchAcceptedMemory: read(services.searchAcceptedMemory),
    traverseAcceptedMemory: read(services.traverseAcceptedMemory),
    getOwnCandidate: read(services.getOwnCandidate),
    readLatestHandoffResource: read(services.readLatestHandoffResource),
    proposeHandoffCompaction: read(services.proposeHandoffCompaction),
    createMemoryCandidate: async (...arguments_) => {
      if (!state.propose) throw disabled("GRAPH_MEMORY_PROPOSE_DISABLED");
      if (typeof services.createMemoryCandidate !== "function") {
        throw disabled("GRAPH_MEMORY_UNAVAILABLE");
      }
      return services.createMemoryCandidate(...arguments_);
    },
    proposeHandoffDraft: async (...arguments_) => {
      if (!state.propose) throw disabled("GRAPH_MEMORY_PROPOSE_DISABLED");
      if (typeof services.proposeHandoffDraft !== "function") {
        throw disabled("GRAPH_MEMORY_UNAVAILABLE");
      }
      return services.proposeHandoffDraft(...arguments_);
    },
    acceptHandoffDraft: async (...arguments_) => {
      if (!state.handoff_accept) {
        throw disabled("GRAPH_MEMORY_HANDOFF_ACCEPT_DISABLED");
      }
      if (typeof services.acceptHandoffDraft !== "function") {
        throw disabled("GRAPH_MEMORY_UNAVAILABLE");
      }
      return services.acceptHandoffDraft(...arguments_);
    },
  };
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function disabled(code) {
  return new GraphMemoryError(
    code,
    "The requested graph memory feature is disabled",
    503,
  );
}
