# Ariadne Model Temperature Compatibility Design

## Problem

The authenticated mobile Review workflow reaches `POST /api/ariadne/core/review`, but the deployed Worker returns HTTP 502 because its upstream OpenAI request hard-codes `temperature: 0.2`. The configured model accepts only its default temperature value.

## Decision

Omit the `temperature` property from both Ariadne Chat Completions request bodies:

- core intake
- core review

The OpenAI API will apply the configured model's supported default. The Worker will not infer capabilities from model names or replace one hard-coded value with another.

## Safety and Scope

- Preserve authentication, capability checks, prompts, response validation, and review-first behavior unchanged.
- Preserve the guarantee that the Worker reports `mutated: false` and never changes an Obsidian note.
- Do not change secrets, `OPENAI_MODEL`, routes, or Cloudflare configuration.
- Do not deploy as part of the local correction.

## Verification

Add a static regression test that inspects both Ariadne request-body blocks and fails while either contains a `temperature` property. Run that test before and after the implementation, run a JavaScript syntax check, and scan the final diff to confirm the change is limited to the compatibility correction and its test/documentation.

## Live Acceptance Gate

After a separately approved deployment, rerun **Ariadne: Review current note** on mobile. Acceptance requires a valid review artifact in `System/Ariadne/Review` and no source-note mutation.
