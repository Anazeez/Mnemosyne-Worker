import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function repositoryFiles(directory = repositoryRoot, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await repositoryFiles(new URL(`${entry.name}/`, directory), path));
    } else {
      files.push(path);
    }
  }

  return files.sort();
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
