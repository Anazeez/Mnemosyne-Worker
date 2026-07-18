# Ariadne Structured Output Repair Design

**Date:** 2026-07-18
**Status:** Approved design; implementation pending written-spec review
**Scope:** Mnemosyne Worker Ariadne Review and Intake provider boundary

## Problem

The deployed Worker now reaches OpenAI successfully, but Ariadne Review can
still fail with `HTTP 502: invalid_provider_output`. The current provider
request describes a typed contract in prompt text while the Worker later
requires an exact object shape. Prompt text does not guarantee valid JSON or
schema adherence, so a successful provider response can still fail local
parsing or validation.

This is distinct from the earlier transport regression. The request is sent,
the provider accepts it, and the failure occurs when the Worker consumes the
provider output.

## Goals

- Make successful Review and Intake provider responses conform to their exact
  required JSON contracts.
- Preserve the existing strict Worker validators as the final safety gate.
- Preserve review-first behavior and prohibit source-note mutation.
- Report the validation stage safely without returning provider output, note
  content, prompts, credentials, or refusal text.
- Keep the change confined to the shared Ariadne provider boundary, workflow
  schemas, and their tests.

## Non-goals

- Changing the configured OpenAI model or API key.
- Migrating Ariadne from Chat Completions to the Responses API.
- Adding retries, automatic output repair, or a fallback model.
- Changing Obsidian plugin artifacts or review/index/query behavior.
- Relaxing the exact-key or type validators.
- Altering secrets, bindings, memory domains, or source-note mutation policy.

## Considered Approaches

### 1. Prompt-only JSON instructions

Keep the current request and strengthen its wording or add examples.

This is the smallest code change but does not provide a deterministic output
contract. A model may still add Markdown fences, omit fields, add fields, or
use a wrong type. This approach is rejected because it recreates the current
failure mode.

### 2. JSON mode plus validation and retry

Set `response_format` to `json_object`, validate locally, and retry malformed
or mismatched output.

JSON mode prevents Markdown-wrapped or syntactically invalid JSON, but it does
not enforce field presence, exact keys, or value types. Retrying increases
latency, cost, and nondeterminism and could duplicate work during provider
instability. This approach is rejected for the primary path.

### 3. Strict JSON Schema Structured Outputs

Send a workflow-specific JSON Schema using Chat Completions
`response_format.type = "json_schema"`, with `strict: true`, all properties
required, and `additionalProperties: false`.

This is the recommended approach. It aligns the provider contract with the
Worker's existing exact-key/type validators and prevents the known mismatch at
the source. The current configured GPT-5 generation supports Structured
Outputs. The Worker validator remains authoritative even when the provider
claims schema compliance.

## Architecture

### Workflow schemas

Define two closed JSON schemas near the Ariadne provider boundary:

- `ARIADNE_INTAKE_SCHEMA`
- `ARIADNE_REVIEW_SCHEMA`

Both schemas use:

- root `type: "object"`
- explicit `properties`
- every property listed in `required`
- `additionalProperties: false`
- string arrays with string `items`

The Review confidence property additionally uses `type: "number"`,
`minimum: 0`, and `maximum: 1`.

### Provider request

`requestProviderChat` accepts a schema name and JSON schema rather than a
prompt-only type map. The outbound Chat Completions body includes:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "ariadne_review",
      "strict": true,
      "schema": {}
    }
  }
}
```

The existing system instruction, serialized note input, authentication, model,
and omitted `temperature` behavior remain unchanged.

### Provider response

The Worker continues to read `choices[0].message.content` and parse it as a
JSON object. It additionally checks bounded completion metadata before parsing:

- a non-empty refusal produces `provider_output_refused`
- a non-`stop` finish reason produces `provider_output_incomplete`
- unparsable content produces `invalid_provider_output` with
  `details.stage = "json_parse"`
- a parsed object that fails the local validator produces
  `invalid_provider_output` with `details.stage = "contract_validation"`

No provider content, refusal text, note content, or prompt content is returned
in an error response.

## Data Flow

1. Obsidian sends a review-first Intake or Review envelope.
2. The Worker authenticates, authorizes, bounds, and normalizes the envelope.
3. The workflow selects its closed JSON schema.
4. `requestProviderChat` sends the note input with strict Structured Outputs.
5. The Worker rejects provider request failures using the existing bounded
   upstream status/code response.
6. The Worker rejects refusals or incomplete completions with bounded codes.
7. The Worker parses the JSON and applies the existing exact local validator.
8. Only a validated object is returned to Obsidian; `mutated` remains `false`.

## Error Contract

The outer HTTP status remains `502` for provider-output failures.

Safe responses are limited to:

- `{ "error": "provider_output_refused" }`
- `{ "error": "provider_output_incomplete", "details": { "finishReason": "length" } }`
- `{ "error": "invalid_provider_output", "details": { "stage": "json_parse" } }`
- `{ "error": "invalid_provider_output", "details": { "stage": "contract_validation" } }`

`finishReason` must pass the same closed-format sanitizer used for provider
machine codes. Unknown or unsafe values are omitted.

## Testing

Tests must fail before implementation and then prove:

- Review sends its complete strict JSON Schema.
- Intake sends its complete strict JSON Schema.
- neither request contains `temperature`.
- valid schema-shaped responses still produce non-mutating success results.
- refusal text is never reflected.
- incomplete finish reasons are bounded and safe.
- JSON parse failures report only `stage: "json_parse"`.
- type/key mismatches report only `stage: "contract_validation"`.
- all existing authorization, review-first, diagnostic, status, continuity,
  binding, and privacy tests remain green.

## Delivery

1. Implement on `codex/ariadne-structured-output` from deployed `main`.
2. Run focused Ariadne tests and the complete Worker suite.
3. Obtain independent code review.
4. Push a draft PR and merge only after review.
5. Run production preflight.
6. Deploy only after preflight succeeds.
7. Verify the merge SHA is the SHA used by both successful workflows.
8. Ask the user to retry Review in Obsidian.

No plugin replacement is required because this repair is Worker-side.
