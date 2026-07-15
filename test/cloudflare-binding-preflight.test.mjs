import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingShapeSummary,
  bindingSummary,
  findVersionId,
} from "../scripts/cloudflare-binding-preflight.mjs";

test("preflight extracts the version without exposing unrelated identifiers", () => {
  assert.equal(findVersionId([{ versions: [{ version_id: "version-secret" }] }]), "version-secret");
});

test("binding shape audit exposes keys but never values", () => {
  const summary = bindingShapeSummary({ bindings: [
    { type: "d1", name: "DB", id: "private-id" },
  ] });
  assert.deepEqual(summary, [{ keys: ["id", "name", "type"], name: "DB", type: "d1" }]);
  assert.doesNotMatch(JSON.stringify(summary), /private-id/);
});

test("binding audit emits aliases and types only", () => {
  const summary = bindingSummary({ resources: { bindings: [
    { type: "d1", name: "DB", id: "private-id" },
    { type: "kv_namespace", name: "KV_MATRIX", namespace_id: "private-kv" },
  ] } });
  assert.deepEqual(summary, [
    { name: "DB", type: "d1" },
    { name: "KV_MATRIX", type: "kv_namespace" },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /private/);
});
