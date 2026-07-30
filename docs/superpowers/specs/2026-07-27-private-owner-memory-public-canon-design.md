# Private Owner Memory and Public Canon Design

Date: 2026-07-27
Status: approved design, pending implementation

## Objective

Make Mnemosyne usable as durable cross-assistant project memory for the owner
while publishing only the reusable knowledge-graph methodology to the universal
plugin directory.

The live memory service is private. It is not represented as a public,
multi-tenant memory product.

## Decisions

### Distribution split

- Publish `mnemosyne-shared-memory` as a skills-only public plugin.
- Keep the MCP and Actions service private and owner-only.
- Connect the private MCP to supported ChatGPT Work and Codex surfaces through
  developer-mode configuration.
- Connect each custom GPT separately through the same OAuth-protected Actions
  contract. Custom GPTs do not inherit a universal plugin connection.

This follows the private-service path instead of submitting an owner-locked MCP
as a public integration.

### Permanent origin

Use `memory.azzayezz.com` as the production origin:

- MCP: `https://memory.azzayezz.com/mcp`
- OAuth callback: `https://memory.azzayezz.com/callback`
- OpenAI domain challenge:
  `https://memory.azzayezz.com/.well-known/openai-apps-challenge`

The hostname currently points to an unused Cloudflare Tunnel application whose
origin returns HTTP 502. Preserve its route configuration as rollback evidence,
then replace it with a Worker Custom Domain only after the Worker passes
default-off tests through its existing `workers.dev` endpoint.

### Identity boundary

- GitHub OAuth is the upstream identity proof.
- Only the immutable numeric GitHub account identifier resolved from the
  confirmed `Anazeez` account may receive a Mnemosyne authorization grant.
- The username is display metadata and is never the authorization key.
- Unknown GitHub identities fail before a Mnemosyne access token is issued.
- OAuth uses authorization code flow with S256 PKCE, explicit consent, narrowed
  scopes, CSRF protection, one-hour access tokens, and bounded refresh tokens.
- OAuth state and client registrations use a dedicated KV namespace.
- Secrets are stored in Cloudflare or GitHub Actions secret storage and never
  committed or pasted into project documentation.

### Tenant and assistant attribution

- The owner has one private tenant.
- Each OAuth client receives a stable, pseudonymous assistant identifier
  derived from its registered client identity.
- Candidate, retrieval, decision, and authorization receipts record that
  assistant identifier.
- Assistants cannot impersonate one another by supplying an identifier in a
  tool argument.

### Project authorization

- The orchestrator may access all owner projects.
- Each specialist receives only its assigned projects.
- Every authorized assistant may read the `global-canon` project.
- Project-specific facts remain in their project and do not silently propagate
  into `global-canon`.
- A specialist requesting an unassigned project is denied unless an active
  owner-approved access grant exists.
- The specialist or orchestrator may request access but cannot approve it.
- An approval specifies assistant, project, capabilities, approver, start time,
  expiry, and reason.
- Assigned-project grants may remain active until revoked.
- Exceptional grants expire after 24 hours by default and may be made permanent
  only by the owner.
- Approval, denial, expiry, and revocation create immutable audit receipts.
- New access takes effect after token refresh; existing tokens never gain
  authority retroactively.

## Memory lifecycle

No assistant writes observations directly into accepted memory.

1. An authorized assistant submits a bounded candidate.
2. Deterministic validation checks schema, ontology, provenance, project scope,
   secrets, and instruction-bearing content.
3. Entity resolution auto-merges only high-confidence, reversible matches.
4. Ambiguous, contradictory, unsupported, low-confidence, or unauthorized
   observations enter quarantine with a stable reason code.
5. Controlled review records an evidence-linked decision.
6. Controlled publication creates a versioned accepted snapshot.
7. Retrieval serves only accepted, authorized facts plus material temporal
   conflicts and cited evidence.
8. Rollback restores a verified predecessor snapshot without deleting audit
   history.

Public MCP and Actions expose retrieval, proposal, and the caller's own candidate
status only. Review, fusion, publication, rollback, export, deletion, and
authorization administration remain private operations.

## Retrieval and token discipline

- Use direct deterministic lookup before semantic or graph expansion.
- Require an explicit tenant and project target.
- Bound result count, traversal depth, response bytes, evidence count, and
  execution time.
- Retrieve only facts relevant to the current task.
- Return provenance adjacent to each accepted assertion.
- Do not inject entire histories into a model context.
- Keep assistant proposals and quarantined material out of accepted retrieval.
- Reuse a current accepted generation within an invocation rather than querying
  repeatedly.

## Rollout

1. Add owner allowlisting, assistant attribution, access grants, and the OpenAI
   domain challenge endpoint behind tests.
2. Create and bind a dedicated OAuth KV namespace.
3. Configure the GitHub OAuth application for the permanent callback.
4. Store the OAuth client secret and deployment credentials outside source
   control.
5. Deploy through `workers.dev` with every graph-memory feature flag off.
6. Verify OAuth metadata, S256 PKCE, owner success, non-owner denial, project
   denial, privacy operations, replay, rollback, and deletion.
7. Save the existing Tunnel route configuration.
8. Remove the unused Tunnel hostname mapping and attach
   `memory.azzayezz.com` as the Worker Custom Domain.
9. Verify TLS, challenge response, OAuth callback, MCP discovery, and Actions
   schema at the permanent origin.
10. Enable accepted-memory reads.
11. Connect and test the orchestrator.
12. Enable MCP, Actions, and candidate proposals.
13. Connect one representative specialist and verify both allowed and denied
    project access.
14. Connect the remaining specialists after the representative test passes.
15. Keep automated review and publication disabled.
16. Submit the separate skills-only plugin for OpenAI review and publish it
    after approval.

## Failure and rollback

- Feature gates fail closed.
- OAuth or KV failure prevents token issuance.
- Authorization failure occurs before graph or vector access.
- Custom-domain failure rolls back to the prior saved hostname route or the
  verified `workers.dev` origin.
- Disabling read, MCP, Actions, or proposal flags does not delete evidence.
- An incompatible server contract rolls back instead of changing a reviewed
  contract in place.
- Failed candidates and authorization requests retain stable reason codes
  without exposing secrets or unrelated identifiers.

## Acceptance tests

- The confirmed owner GitHub identity completes OAuth.
- A different GitHub identity fails before token issuance.
- Consent rejects CSRF mismatch and non-S256 PKCE.
- Each registered assistant receives stable, non-user-controlled attribution.
- The orchestrator can read an owner project and `global-canon`.
- A specialist can read its assigned project and `global-canon`.
- The same specialist is denied an unassigned project without a grant.
- A 24-hour owner-approved grant permits that project after token refresh.
- Expiry or revocation denies the project after token refresh.
- Two authorized assistants retrieve the same accepted assertion and
  provenance.
- A candidate remains absent from accepted retrieval until controlled
  publication.
- Ambiguous entity resolution quarantines rather than merges.
- Replay is idempotent and byte-stable for the golden fixture.
- Rollback restores the previous accepted generation.
- Export and deletion affect only the owner tenant and rebuild projections from
  accepted authoritative records.
- Responses stay within configured hop, count, evidence, byte, and time limits.
- The production hostname passes TLS, OAuth metadata, MCP discovery, and
  OpenAPI smoke tests.
- The public skills bundle passes validation, fresh discovery tests, secret
  scanning, and the submission portal's automated checks.

## Required operator inputs

Implementation may prepare all code and deployment machinery before these
values exist, but live activation requires:

- a restricted Cloudflare API token able to manage the target Worker, Worker
  custom domain for `azzayezz.com`, Workers KV, and required Worker secrets;
- a GitHub OAuth App client ID and client secret with callback
  `https://memory.azzayezz.com/callback`;
- the OpenAI plugin portal's generated domain-verification challenge token;
- explicit portal confirmation for the public skills-only submission,
  attestations, review submission, and post-approval publication.

Secrets must be entered through provider secret controls, not through chat or
committed files.

## Deliberate exclusions

- No public or multi-tenant memory service.
- No direct memory writes.
- No automatic review or publication.
- No automatic access expansion based on assistant claims.
- No promise that universal plugin publication attaches the private service to
  custom GPTs.
- No mobile, ordinary Chat, or IDE-extension availability claim where the
  product surface does not support plugins.
