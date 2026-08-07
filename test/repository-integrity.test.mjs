import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const repositoryRoot = new URL("../", import.meta.url);
const executeFile = promisify(execFile);

async function repositoryFiles() {
  const { stdout } = await executeFile(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot }
  );
  return stdout.trim().split("\n").filter(Boolean).sort();
}

function vectorizeBindings(wrangler) {
  return [...wrangler.matchAll(/\[\[vectorize\]\]([\s\S]*?)(?=\n\[\[|$)/g)].map(
    match => ({
      binding: match[1].match(/^binding\s*=\s*["']([^"']+)["']/m)?.[1],
      indexName: match[1].match(/^index_name\s*=\s*["']([^"']+)["']/m)?.[1],
    }),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("generated local state is ignored and absent from the Git tree", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const requiredRules = [
    ".wrangler/",
    "node_modules/",
    ".env",
    ".env.*",
    ".dev.vars",
    "*.log",
    "*.sqlite*",
    "*.map"
  ];

  for (const rule of requiredRules) {
    assert.equal(ignore.split("\n").includes(rule), true, `missing ignore rule: ${rule}`);
  }

  const prohibited = (await repositoryFiles()).filter(path =>
    path.startsWith(".wrangler/") ||
    path.includes("production-snapshots/") ||
    /(^|\/)(?:node_modules|dist|build)\//.test(path) ||
    /\.(?:sqlite(?:-shm|-wal)?|map|log)$/.test(path)
  );

  assert.deepEqual(prohibited, []);
});

test("new tracked evidence does not duplicate account-style identifiers", async () => {
  const emailLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const candidates = (await repositoryFiles()).filter(path =>
    path !== "src/index.js" &&
    path !== "src/worker.js" &&
    !path.endsWith(".sqlite") &&
    !path.endsWith(".sqlite-shm") &&
    !path.endsWith(".sqlite-wal")
  );

  const findings = [];
  for (const path of candidates) {
    const content = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    if (emailLike.test(content)) {
      findings.push(path);
    }
    emailLike.lastIndex = 0;
  }

  assert.deepEqual(findings, []);
});

test("README documents every configured Vectorize binding", async () => {
  const [wrangler, readme] = await Promise.all([
    readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  const bindings = vectorizeBindings(wrangler);
  assert.ok(bindings.length > 0, "wrangler.toml must define a Vectorize binding");
  for (const { binding, indexName } of bindings) {
    assert.ok(binding && indexName, "each Vectorize binding needs a name and index");
    const row = new RegExp(
      "\\| `" + escapeRegExp(binding) + "` \\| `" +
      escapeRegExp(indexName) + "` \\|",
    );
    assert.match(readme, row, `README.md is missing ${binding} (${indexName})`);
  }
});
