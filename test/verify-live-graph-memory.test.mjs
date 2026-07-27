import assert from "node:assert/strict";
import test from "node:test";

import { verifyLiveGraphMemory } from "../scripts/verify-live-graph-memory.mjs";

test("live verification binds metadata to the expected HTTPS origin", async () => {
  const responses = new Map([
    ["/ping", json({ graph_memory: { mcp: false, actions: false } })],
    [
      "/.well-known/oauth-authorization-server",
      json({
        issuer: "https://memory.azzayezz.com",
        authorization_endpoint: "https://memory.azzayezz.com/authorize",
        token_endpoint: "https://memory.azzayezz.com/token",
        code_challenge_methods_supported: ["S256"],
      }),
    ],
    [
      "/.well-known/oauth-protected-resource",
      json({
        resource: "https://memory.azzayezz.com",
        scopes_supported: [
          "memory:read",
          "memory:search",
          "memory:propose",
          "memory:candidate:read",
          "memory:review",
        ],
      }),
    ],
    [
      "/openapi.json",
      json({
        paths: {
          "/v1/memory/rehydrate": {},
          "/v1/memory/search": {},
          "/v1/memory/traverse": {},
          "/v1/memory/candidates": {},
          "/v1/memory/candidates/{id}": {},
        },
      }),
    ],
    ["/.well-known/openai-apps-challenge", text("challenge-value")],
    ["/mcp", json({ error: "unauthorized" }, 401)],
    ["/v1/memory/search", json({ error: "unauthorized" }, 401)],
  ]);

  const report = await verifyLiveGraphMemory({
    baseUrl: "https://memory.azzayezz.com",
    expectedOrigin: "https://memory.azzayezz.com",
    expectTools: 0,
    expectActions: 0,
    expectChallenge: true,
    fetchImpl: async input => {
      const url = new URL(input);
      return responses.get(url.pathname) ?? json({ error: "not_found" }, 404);
    },
  });

  assert.equal(report.status, "verified");
  assert.equal(report.origin, "https://memory.azzayezz.com");
  assert.equal(report.challenge, "present");
  assert.equal(report.protected_routes, "denied_without_token");
  assert.doesNotMatch(JSON.stringify(report), /challenge-value/);
});

test("live verification rejects metadata that escapes the expected origin", async () => {
  await assert.rejects(
    verifyLiveGraphMemory({
      baseUrl: "https://memory.azzayezz.com",
      expectedOrigin: "https://memory.azzayezz.com",
      fetchImpl: async input => {
        const url = new URL(input);
        if (url.pathname === "/ping") {
          return json({ graph_memory: { mcp: false, actions: false } });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return json({
            issuer: "https://attacker.example",
            authorization_endpoint: "https://attacker.example/authorize",
            token_endpoint: "https://attacker.example/token",
            code_challenge_methods_supported: ["S256"],
          });
        }
        return json({
          resource: "https://memory.azzayezz.com",
          scopes_supported: [
            "memory:read",
            "memory:search",
            "memory:traverse",
            "memory:propose",
          ],
          paths: {},
        });
      },
    }),
    /oauth_origin_invalid/,
  );
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}
