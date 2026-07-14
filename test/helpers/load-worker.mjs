import { readFile } from "node:fs/promises";

let workerPromise;

export function loadWorker() {
  if (!workerPromise) {
    workerPromise = readFile(
      new URL("../../src/index.js", import.meta.url),
      "utf8"
    ).then(source => import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )).then(module => module.default);
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
    OPENAI_API_KEY: "test-openai-key",
    ...overrides
  };
}

export function intakeRequest(body, authenticated = true) {
  const headers = { "Content-Type": "application/json" };

  if (authenticated) {
    headers["X-Matrix-Key"] = "test-key";
  }

  return new Request("https://worker.invalid/api/ariadne/core/intake", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

export const validIntake = Object.freeze({
  title: "Interface reconciliation",
  content: "Verify the review-first provider contract.",
  source: "obsidian-plugin",
  metadata: {
    vaultPath: "Inbox/interface-reconciliation.md",
    originalLocation: "Inbox"
  },
  reviewFirst: true
});

export function openAIResponse(content, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export const validProposal = Object.freeze({
  classification: "implementation-review",
  summary: "A review-first interface compatibility check.",
  proposedDestination: "Projects/Mnemosyne",
  proposedTags: ["mnemosyne", "compatibility"],
  proposedLinks: ["Mnemosyne Worker"],
  warnings: []
});
