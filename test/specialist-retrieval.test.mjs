import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthorizedVectorFilter } from "../src/specialists/retrieval.js";
import {
  loadWorker,
  migrateTestPrincipalEnvironment,
} from "./helpers/worker-harness.mjs";

const haavaPrincipal = {
  tenant_id: "personal",
  credential_id: "haava",
  principal_id: "haava",
  role: "specialist",
  specialist_id: "haava",
  project_ids: ["project-infinitum"],
  domain_ids: ["visual-design-expression"],
  identity_ids: ["haava"],
  capabilities: ["memory.search"],
  lane_permissions: ["root-local", "savae-routed"],
};

function specialistEnvironment() {
  return migrateTestPrincipalEnvironment({
    MATRIX_PRINCIPAL_KEYS: {
      "haava-key-with-enough-entropy": {
        credential_id: "haava",
        principal_id: "specialist",
        project_ids: ["project-infinitum"],
      },
    },
    AI: { async run() { return { data: [[0.1, 0.2]] }; } },
    MATRIX_KNOWLEDGE: { async query() { return { matches: [] }; } },
  });
}

function searchRequest(body) {
  return new Request("https://worker.invalid/v1/memory/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Matrix-Key": "haava-key-with-enough-entropy",
    },
    body: JSON.stringify({ query: "brand system", ...body }),
  });
}

test("legacy specialist search denies an ungranted project before embedding", async () => {
  const worker = await loadWorker();
  let embeddingCalls = 0;
  const env = specialistEnvironment();
  env.AI = { async run() { embeddingCalls += 1; return { data: [[0.1]] }; } };
  const response = await worker.fetch(searchRequest({
    project_id: "other-project",
    domain_id: "visual-design-expression",
  }), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "PROJECT_SCOPE_DENIED");
  assert.equal(embeddingCalls, 0);
});

test("client metadata cannot replace the server-owned specialist domain filter", () => {
  assert.throws(
    () => buildAuthorizedVectorFilter(haavaPrincipal, {
      tenant_id: "personal",
      project_id: "project-infinitum",
      domain_id: "ui-ux-full-stack",
      metadata: { domain_id: "visual-design-expression" },
    }),
    (error) => error.code === "DOMAIN_SCOPE_DENIED",
  );
});

test("authorized specialist filter always contains tenant project and sole domain", () => {
  assert.deepEqual(buildAuthorizedVectorFilter(haavaPrincipal, {
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    scope_key: "brand-refresh",
    metadata: {
      tenant_id: "other-tenant",
      project_id: "other-project",
      domain_id: "ui-ux-full-stack",
    },
  }), {
    tenant_id: "personal",
    project_id: "project-infinitum",
    domain_id: "visual-design-expression",
    scope_key: "brand-refresh",
  });
});

test("Ariadne-only domain guard rejects another specialist", () => {
  assert.throws(
    () => buildAuthorizedVectorFilter(haavaPrincipal, {
      tenant_id: "personal",
      project_id: "project-infinitum",
      domain_id: "logic-trend-analysis",
      identity_id: "ariadne",
    }),
    (error) => ["DOMAIN_SCOPE_DENIED", "IDENTITY_SCOPE_DENIED"].includes(error.code),
  );
});
