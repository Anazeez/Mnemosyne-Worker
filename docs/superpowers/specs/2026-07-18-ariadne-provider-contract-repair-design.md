# Ariadne Provider Contract Repair Design

## Context

Ariadne Review worked after commit `2a4f602` removed the unsupported
`temperature` parameter from its OpenAI requests. That compatibility commit
remained isolated on `codex/ariadne-model-compat` and was not merged into
`main`.

The July 15 Worker reconstruction consolidated Intake and Review behind
`requestProviderChat()`. In doing so, it reintroduced `temperature: 0.2`,
reduced each typed output contract to a list of field names, removed the
compatibility regression test, and mapped every non-successful provider
response to `provider_unavailable`. GitHub Actions subsequently deployed
`main` commit `61a4666`, replacing the previously working production code.

## Goal

Restore deterministic, review-first Ariadne Intake and Review provider calls
on the reconstructed Worker without changing authentication, capabilities,
memory behavior, secrets, deployment configuration, or source-note safety.

## Chosen Approach

Repair the shared `requestProviderChat()` boundary on a branch from current
`origin/main`:

1. Omit `temperature` entirely so the configured model controls its supported
   default.
2. Send an explicit typed JSON contract for each workflow rather than only a
   comma-separated field list.
3. Preserve the existing post-response validators as the final safety gate.
4. Return bounded, non-secret upstream diagnostics containing the upstream
   HTTP status and error code/type, while never reflecting prompts, provider
   response bodies, credentials, or API keys.
5. Add source-level and behavior-level regression tests that fail against the
   deployed July 15 implementation.

This is preferred over reverting the reconstruction because the current
`main` branch contains approved continuity and deployment work that is
unrelated to Ariadne. It is also preferred over model-specific branching or
automatic model fallback because those approaches conceal configuration
errors and make review behavior nondeterministic.

## Provider Boundary

`requestProviderChat(env, request)` remains the only outbound Chat Completions
boundary used by Ariadne Intake and Review. Its request input will include:

- `system`: the workflow's non-mutation instruction;
- `input`: the bounded source-note envelope;
- `contract`: a JSON-serializable description of every required field and
  type.

The user message will require one JSON object matching that contract and will
continue to include the bounded input envelope. No provider output is trusted
until the existing workflow validator accepts it.

## Error Contract

The Worker will distinguish these stages without leaking sensitive content:

- missing provider configuration: `provider_unavailable`, HTTP 503;
- network failure: `provider_unavailable`, HTTP 502;
- provider HTTP failure: `provider_request_failed`, HTTP 502, with bounded
  `upstreamStatus` and optional `upstreamCode`;
- non-JSON provider response body: `invalid_provider_response`, HTTP 502;
- successful provider envelope without message content:
  `invalid_provider_response`, HTTP 502;
- message content that fails the workflow schema:
  `invalid_provider_output`, HTTP 502.

The response must not include the upstream message, raw body, prompt, note
content, authorization header, or model secret.

## Testing

Regression coverage will prove that:

- no Ariadne Chat Completions request contains `temperature`;
- Review sends the complete typed contract and still returns a non-mutating
  validated result;
- Intake sends its complete typed contract and still returns a review-first
  non-mutating proposal;
- upstream HTTP status and code are visible through bounded fields;
- upstream messages and arbitrary response content are not reflected;
- malformed provider output remains blocked;
- the complete Worker suite remains green.

The tests will use the existing Node test harness and mocked outbound `fetch`
boundary. No live OpenAI call, Cloudflare deployment, secret, or vault write
is required.

## Scope and Safety

Only `src/index.js` and focused Ariadne tests will change. The implementation
will not deploy, push to `main`, rotate credentials, alter model allowlists,
change Worker bindings, or mutate any Obsidian source note. Review artifacts
remain proposal-only and are created only after the plugin validates a
successful Worker response.

## Risks

- A configured model can still be unavailable or disallowed by the OpenAI
  project. The repaired diagnostic will expose that as an upstream request
  failure rather than mislabeling it as a generic provider outage.
- Prompt-only JSON contracts cannot guarantee valid output. Existing strict
  validators remain mandatory, and invalid output remains a visible failure.
- Changing the shared provider boundary affects both Intake and Review, so
  both workflows require direct regression coverage before integration.
