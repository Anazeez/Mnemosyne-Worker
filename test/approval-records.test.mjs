import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const approvals = [
  ["docs/proposals/privileges/root-dashboard-overview.yaml", "approval.worker.root.dashboard-overview"],
  ["docs/proposals/privileges/dashboard-dashboard-overview.yaml", "approval.worker.dashboard.dashboard-overview"],
  ["docs/proposals/privileges/root-ariadne-core-openai-test.yaml", "approval.worker.root.ariadne-core-openai-test"],
  ["docs/proposals/privileges/orchestrator-ariadne-core-openai-test.yaml", "approval.worker.orchestrator.ariadne-core-openai-test"],
  ["docs/proposals/privileges/specialist-ariadne-core-openai-test.yaml", "approval.worker.specialist.ariadne-core-openai-test"],
  ["docs/proposals/authentication/dashboard-key-path.yaml", "approval.worker.dashboard.authentication-path"],
];

test("each approved baseline relationship has separately scoped provenance", async () => {
  for (const [path, approvalId] of approvals) {
    const source = await readFile(path, "utf8");
    assert.match(source, new RegExp(`approval_id: ${approvalId.replaceAll(".", "\\.")}`));
    assert.match(source, /approval_state: approved/);
    assert.match(source, /authority_identity: architectus/);
    assert.match(source, /authority_basis: docs\/root-registry-rule\.md/);
    assert.match(source, /source_commit: 82cccaf86633abdd24f39e14a0fe96a4f2a96137/);
    assert.match(source, /deployment_authorized: false/);
    assert.match(source, /binding_activation_authorized: false/);
  }
});
