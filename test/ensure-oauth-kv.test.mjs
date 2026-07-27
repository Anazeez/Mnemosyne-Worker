import assert from "node:assert/strict";
import test from "node:test";

import { ensureOAuthKvNamespace } from "../scripts/ensure-oauth-kv.mjs";

test("reuses the exact OAuth KV namespace", async () => {
  const requests = [];
  const result = await ensureOAuthKvNamespace({
    accountId: "account",
    apiToken: "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({
        success: true,
        result: [
          { id: "other", title: "other" },
          { id: "oauth-id", title: "mnemosyne-worker-OAUTH_KV" },
        ],
      });
    },
  });
  assert.deepEqual(result, { id: "oauth-id", created: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.Authorization, "Bearer token");
});

test("creates a missing OAuth KV namespace once", async () => {
  const methods = [];
  const result = await ensureOAuthKvNamespace({
    accountId: "account",
    apiToken: "token",
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === "GET") {
        return Response.json({ success: true, result: [] });
      }
      assert.deepEqual(JSON.parse(init.body), {
        title: "mnemosyne-worker-OAUTH_KV",
      });
      return Response.json({
        success: true,
        result: { id: "new-oauth-id" },
      });
    },
  });
  assert.deepEqual(result, { id: "new-oauth-id", created: true });
  assert.deepEqual(methods, ["GET", "POST"]);
});
