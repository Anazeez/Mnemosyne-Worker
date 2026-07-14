import { readFile } from "node:fs/promises";

let workerPromise;

export function loadWorker() {
  if (!workerPromise) {
    workerPromise = readFile(new URL("../../src/index.js", import.meta.url), "utf8")
      .then(source => import(
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
      ))
      .then(module => module.default);
  }

  return workerPromise;
}

export function scopedEnvironment(role, overrides = {}) {
  return {
    MATRIX_PRINCIPAL_KEYS: {
      "test-key": {
        credential_id: `test-${role}`,
        principal_id: role
      }
    },
    ...overrides
  };
}

export function authenticatedRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("X-Matrix-Key", "test-key");

  return new Request(`https://worker.invalid${path}`, {
    ...options,
    headers
  });
}

export async function withStubbedFetch(stub, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function providerChatResponse(content, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
