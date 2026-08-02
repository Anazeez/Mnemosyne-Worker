import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_SCOPE_CAPABILITIES,
  assertGraphAccess,
  principalFromOAuthClaims
} from "../src/graph-memory/policy.js";

function claims(overrides = {}) {
  return {
    tenant_id: "tenant-a",
    credential_id: "portal-a",
    assistant_id: "chatgpt-work",
    role: "portal",
    project_ids: ["project.one"],
    identity_ids: ["assistant-a"],
    scopes: [
      "memory:read",
      "memory:search",
      "memory:propose",
      "memory:candidate:read"
    ],
    ...overrides
  };
}

test("public scopes map only to the approved portal capabilities", () => {
  assert.deepEqual(PUBLIC_SCOPE_CAPABILITIES, {
    "memory:read": ["memory.read", "continuity.read"],
    "memory:search": ["memory.search"],
    "memory:propose": ["memory.propose"],
    "memory:candidate:read": ["memory.candidate.read.own"],
    "mesh:inbox": ["exchanges.inbox"]
  });

  const principal = principalFromOAuthClaims(claims());
  assert.deepEqual(principal.capabilities, [
    "memory.read",
    "continuity.read",
    "memory.search",
    "memory.propose",
    "memory.candidate.read.own"
  ]);
});

test("unrecognized scopes never expand portal authority", () => {
  const principal = principalFromOAuthClaims(claims({
    scopes: ["memory:read", "memory:publish", "continuity.write"]
  }));

  assert.deepEqual(principal.capabilities, [
    "memory.read",
    "continuity.read"
  ]);
});

test("human review scope maps only for an owner principal", () => {
  const owner = principalFromOAuthClaims(claims({
    credential_id: "github-42",
    assistant_id: "human-review-console",
    role: "owner",
    scopes: ["memory:review"]
  }));
  assert.deepEqual(owner.capabilities, [
    "memory.review",
    "memory.validate",
    "memory.resolve",
    "memory.publish"
  ]);

  const portal = principalFromOAuthClaims(claims({
    scopes: ["memory:review"]
  }));
  assert.deepEqual(portal.capabilities, []);
});

test("graph access requires exact tenant project and capability", () => {
  const principal = principalFromOAuthClaims(claims());
  assert.doesNotThrow(() => assertGraphAccess(
    principal,
    { tenant_id: "tenant-a", project_id: "project.one" },
    "memory.propose"
  ));

  for (const [target, capability, code] of [
    [
      { tenant_id: "tenant-b", project_id: "project.one" },
      "memory.read",
      "TENANT_SCOPE_DENIED"
    ],
    [
      { tenant_id: "tenant-a", project_id: "private" },
      "memory.read",
      "PROJECT_SCOPE_DENIED"
    ],
    [
      { tenant_id: "tenant-a", project_id: "project.one" },
      "memory.publish",
      "CAPABILITY_DENIED"
    ]
  ]) {
    assert.throws(
      () => assertGraphAccess(principal, target, capability),
      error => error.code === code
    );
  }
});

test("OAuth claims require a bounded tenant credential assistant and projects", () => {
  for (const invalid of [
    { tenant_id: "../tenant" },
    { credential_id: "" },
    { assistant_id: "x" },
    { project_ids: [] },
    { role: "root" }
  ]) {
    assert.throws(
      () => principalFromOAuthClaims(claims(invalid)),
      error => error.code === "INVALID_OAUTH_CLAIMS"
    );
  }
});
