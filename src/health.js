import { graphMemoryFeatureState } from "./graph-memory/flags.js";
import { SPECIALIST_POLICY_VERSION } from "./specialists/contracts.js";

export function buildHealthPayload(env = {}) {
  const flags = graphMemoryFeatureState(env);
  const hasD1 = Boolean(env.DB);
  const meshSecretBytes = new TextEncoder().encode(
    String(env.MESH_GATEWAY_SECRET ?? ""),
  ).byteLength;
  return {
    status: "ok",
    worker: "ready",
    d1: hasD1 ? "available" : "unavailable",
    oauth: env.OAUTH_KV ? "available" : "unavailable",
    graph_memory: flags,
    specialist_policy_version: SPECIALIST_POLICY_VERSION,
    mesh_ingress: hasD1 && meshSecretBytes >= 32 ? "ready" : "unavailable",
  };
}
