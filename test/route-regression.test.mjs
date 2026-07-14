import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/main-routes.json", import.meta.url),
  "utf8"
));

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function staticRouteIsRepresented(method, path) {
  const route = `url\\.pathname\\s*===\\s*["']${escapeRegex(path)}["']`;
  const verb = `method\\s*===\\s*["']${method}["']`;
  return new RegExp(`${route}[\\s\\S]{0,160}${verb}|${verb}[\\s\\S]{0,160}${route}`).test(source);
}

function dynamicRouteIsRepresented(method, path) {
  const fragments = path.split("/").filter(part => part && !part.startsWith(":"));
  return fragments.every(fragment => source.includes(fragment)) &&
    new RegExp(`method\\s*===\\s*["']${method}["']`).test(source);
}

test("all main and proposed routes are represented while logs remain excluded", () => {
  for (const [method, path] of [...fixture.main_routes, ...fixture.proposed_routes]) {
    const represented = path.includes(":")
      ? dynamicRouteIsRepresented(method, path)
      : staticRouteIsRepresented(method, path);
    assert.equal(represented, true, `missing route: ${method} ${path}`);
  }

  for (const [, path] of fixture.excluded_routes) {
    assert.equal(source.includes(path), false, `excluded route present: ${path}`);
  }
});

test("README labels reconstructed routes as proposed and non-active", () => {
  assert.match(readme, /Reconstructed review surface/);
  assert.match(readme, /proposed; not active/i);

  for (const [, path] of fixture.proposed_routes) {
    assert.equal(readme.includes(path), true, `undocumented proposed route: ${path}`);
  }
  assert.equal(readme.includes("/api/ariadne/core/logs"), false);
});
