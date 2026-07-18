let workerPromise;

export function loadWorker() {
  if (!workerPromise) {
    workerPromise = import(new URL("../../src/index.js", import.meta.url))
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

export function providerChatResponse(content, options = {}) {
  const {
    status = 200,
    finishReason = "stop",
    refusal
  } = options;
  const message = {
    content: typeof content === "string" ? content : JSON.stringify(content)
  };

  if (refusal !== undefined) {
    message.refusal = refusal;
  }

  return new Response(JSON.stringify({
    choices: [{ message, finish_reason: finishReason }]
  }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
