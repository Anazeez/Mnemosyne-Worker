import assert from "node:assert/strict";
import test from "node:test";

import {
  applySpecialistMigration,
  migratedSpecialistEnvironment,
} from "./helpers/d1-specialists.mjs";
import {
  assertSpecialistAccess,
  canObserveMessage,
  observableMessageView,
} from "../src/specialists/policy.js";
import { SPECIALIST_CONTRACTS } from "../src/specialists/contracts.js";

const haavaPrincipal = {
  principal_id: "haava",
  specialist_id: "haava",
  tenant_id: "personal",
  project_ids: ["project-infinitum"],
  domain_ids: ["visual-design-expression"],
  identity_ids: ["haava"],
  capabilities: ["memory.search"],
  lane_permissions: ["root-local", "savae-routed"],
};

const savaePrincipal = {
  ...haavaPrincipal,
  principal_id: "savae",
  specialist_id: "savae",
  domain_ids: ["mesh-orchestration"],
  identity_ids: ["savae"],
};

test("specialist migration is repeatable and creates constrained tables", async () => {
  const env = await migratedSpecialistEnvironment();
  await applySpecialistMigration(env.DB);
  await applySpecialistMigration(env.DB);

  for (const table of [
    "specialist_principals",
    "specialist_assistant_bindings",
    "legacy_credentials",
    "mesh_messages",
    "security_preflights",
  ]) {
    assert.equal(await env.DB.hasTable(table), true, table);
  }
});

test("Haava cannot request Vitruvius domain memory", () => {
  assert.throws(
    () => assertSpecialistAccess(haavaPrincipal, {
      tenant_id: "personal",
      project_id: "project-infinitum",
      domain_id: "ui-ux-full-stack",
      identity_id: "haava",
      lane: "root-local",
    }, "memory.search"),
    (error) => error.code === "DOMAIN_SCOPE_DENIED",
  );
});

test("Savae cannot observe an unforwarded root-local message", () => {
  assert.equal(canObserveMessage(savaePrincipal, {
    lane: "root-local",
    target_specialist: "hearken",
    forwarded_by_architectus: 0,
  }), false);
});

test("Synn sees only a redacted confirmed-critical alarm", () => {
  const synn = { ...haavaPrincipal, principal_id: "synn", specialist_id: "synn" };
  const message = {
    message_id: "msg-critical-1",
    lane: "root-local",
    target_specialist: "hearken",
    forwarded_by_architectus: 0,
    payload_json: "secret payload",
    attachments_json: "secret attachment",
    security_state: "blocked",
    preflight: { severity: "critical", decision: "block", reason_codes: ["cross_tenant"] },
  };

  assert.equal(canObserveMessage(synn, message), true);
  assert.deepEqual(observableMessageView(synn, message), {
    message_id: "msg-critical-1",
    security_state: "blocked",
    severity: "critical",
    decision: "block",
    reason_codes: ["cross_tenant"],
    redacted: true,
  });
});

test("every specialist contract includes the universal authenticated mesh operations", () => {
  const universalCapabilities = [
    "skills.retrieval",
    "mandates.read",
    "mandates.ack",
    "exchanges.inbox",
    "exchanges.ack",
    "exchanges.reply",
    "exchanges.artifact.read.own",
  ];

  for (const specialist of Object.values(SPECIALIST_CONTRACTS)) {
    for (const capability of universalCapabilities) {
      assert.ok(
        specialist.capabilities.includes(capability),
        `${specialist.specialist_id} lacks ${capability}`,
      );
    }
  }
});

test("only Savae receives mesh routing capabilities", () => {
  const routingCapabilities = [
    "mandates.draft",
    "mandates.dispatch",
    "router.status",
    "exchanges.dispatch",
    "exchanges.history",
    "exchanges.artifact.read.any",
  ];

  for (const [specialistId, specialist] of Object.entries(SPECIALIST_CONTRACTS)) {
    for (const capability of routingCapabilities) {
      assert.equal(
        specialist.capabilities.includes(capability),
        specialistId === "savae",
        `${specialistId} routing boundary for ${capability}`,
      );
    }
  }
});
