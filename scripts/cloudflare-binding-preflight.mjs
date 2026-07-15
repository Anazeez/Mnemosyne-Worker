import { readFile } from "node:fs/promises";

export function findVersionId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVersionId(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (/version.*id/i.test(key) && typeof child === "string" && child) return child;
  }
  for (const child of Object.values(value)) {
    const found = findVersionId(child);
    if (found) return found;
  }
  return null;
}

export function bindingSummary(value) {
  const bindings = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string" && typeof node.name === "string") {
      bindings.push({ name: node.name, type: node.type });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return [...new Map(bindings.map(item => [`${item.type}:${item.name}`, item])).values()]
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

export function bindingShapeSummary(value) {
  const bindings = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string" && typeof node.name === "string") {
      bindings.push({
        name: node.name,
        type: node.type,
        keys: Object.keys(node).sort(),
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return bindings.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

if (process.argv[1]?.endsWith("cloudflare-binding-preflight.mjs")) {
  const deployments = JSON.parse(await readFile(process.argv[2], "utf8"));
  const versionId = findVersionId(deployments);
  if (!versionId) throw new Error("current_worker_version_unresolved");
  process.stdout.write(versionId);
}
