import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedRequest,
  loadWorker,
  scopedEnvironment,
} from "./helpers/worker-harness.mjs";

test("exchange artifact retrieval uses the existing Matrixium R2 binding", async () => {
  const worker = await loadWorker();
  const env = scopedEnvironment("root", {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  mandate_id: "exchange-1",
                  title: "Mesh Exchange: diagnostic",
                  body: [
                    "Recipient Persona: synn",
                    "Artifact Key: exchanges/api/exchange-1/payload.txt",
                  ].join("\n"),
                  created_by: "savae",
                  created_at: "2026-08-04T00:00:00Z",
                  state: "archived",
                };
              },
            };
          },
        };
      },
    },
    R2_MATRIXIUM: {
      async get(key) {
        assert.equal(key, "exchanges/api/exchange-1/payload.txt");
        return {
          body: "artifact payload",
          httpMetadata: { contentType: "text/plain" },
        };
      },
    },
  });

  const response = await worker.fetch(
    authenticatedRequest("/v1/exchanges/exchange-1/artifact"),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "artifact payload");
  assert.equal(response.headers.get("Content-Type"), "text/plain");
  assert.equal(response.headers.get("X-Exchange-Id"), "exchange-1");
});

test("exchange artifact retrieval cannot escape its R2 namespace", async () => {
  const worker = await loadWorker();
  let storageRead = false;
  const env = scopedEnvironment("root", {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  mandate_id: "exchange-2",
                  title: "Mesh Exchange: hostile reference",
                  body: [
                    "Recipient Persona: synn",
                    "Artifact Key: accepted/private-memory.json",
                  ].join("\n"),
                  created_by: "savae",
                  created_at: "2026-08-04T00:00:00Z",
                  state: "archived",
                };
              },
            };
          },
        };
      },
    },
    R2_MATRIXIUM: {
      async get() {
        storageRead = true;
        return { body: "must not be returned" };
      },
    },
  });

  const response = await worker.fetch(
    authenticatedRequest("/v1/exchanges/exchange-2/artifact"),
    env,
  );

  assert.equal(response.status, 404);
  assert.equal(storageRead, false);
});
