import assert from "node:assert/strict";
import test from "node:test";

import * as policy from "../src/graph-memory/policy.js";

const specialistClaims = {
  tenant_id: "personal",
  credential_id: "github-277895262",
  assistant_id: "oauth-11111111111111111111111111111111",
  principal_id: "synn",
  role: "specialist",
  specialist_id: "synn",
  project_ids: ["global-canon"],
  identity_ids: ["synn"],
  domain_ids: ["security-compliance-preflight"],
  memory_domains: ["knowledge"],
  lane_permissions: ["root-local"],
  scopes: ["identity:read"],
  capabilities: ["security.preflight"],
  grant_version: "a".repeat(64),
  package_version: "2026-08-03.1",
};

test("protected specialist requests reject a stale package token", async () => {
  assert.equal(typeof policy.assertCurrentSpecialistPackage, "function");
  assert.throws(
    () => policy.assertCurrentSpecialistPackage(
      policy.principalFromOAuthClaims(specialistClaims),
      "2026-08-03.2",
    ),
    error => error?.code === "SPECIALIST_PACKAGE_STALE" && error?.status === 401,
  );
});
