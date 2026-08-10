# Codex Usage Bridge

This is a deliberately small, read-only bridge for the private Codex Usage
page. It has two local pieces:

```text
authenticated browser tab
        │  local CDP: document.body.innerText only
        ▼
collector.py ── strict parser ── SQLite previous observation
        │  four-field sanitized record over a separate ingest token
        ▼
Cloudflare Worker ── Durable Object observation history
        │  one token-gated Streamable HTTP MCP tool
        ▼
ChatGPT developer-mode app
```

The collector never requests or exports cookies, passwords, authorization
headers, local storage, session identifiers, or page source. It refuses a
non-local DevTools socket, a page that is not an OpenAI Usage page, an uncertain
authentication state, or an incomplete parse. A failed collection is not
published.

## Local operation

Open the already authenticated Codex Usage page in a browser started with
Chrome DevTools Protocol enabled on localhost. Then collect the rendered text:

```bash
python3 collector.py \
  --cdp-url http://127.0.0.1:9222/json/list \
  --state state/usage.sqlite3 \
  --timezone Asia/Riyadh
```

The collector prints only the four sanitized fields plus its local
`reset_detected` result. The SQLite file retains prior observations; it is not
served as a file and is never sent to ChatGPT. When `--upload-url` is supplied,
the same four fields are sent to the Cloudflare ingestion route; no OpenAI
credential or browser artifact is included.

For local-only testing, start the Python MCP server with a fresh, random
URL-safe capability token held in the deployment secret store or process
environment:

```bash
CODEX_BRIDGE_TOKEN='<32+ random URL-safe characters>' \
python3 -m usage_bridge serve \
  --host 127.0.0.1 \
  --port 8787 \
  --state state/usage.sqlite3
```

The endpoint is:

```text
https://<private-tunnel-host>/mcp/<capability-token>
```

The tokenized URL is a credential. Do not commit it, print it in logs, put it
in screenshots or receipts, or paste it into chat. Put it only in ChatGPT's
private app configuration. Rotation means replacing the token and restarting
the server; disablement means stopping the server or removing the tunnel
route.

## Git-backed Cloudflare deployment

The production adapter is `worker/src/index.js`. It uses a Cloudflare Durable
Object for the latest observation and bounded history, so the MCP does not
depend on this machine's SQLite file. `wrangler.jsonc` declares the Worker and
SQLite Durable Object migration. The Worker keeps these Cloudflare secrets:

```text
CODEX_BRIDGE_TOKEN
INGEST_TOKEN
```

`CODEX_BRIDGE_TOKEN` is the single ChatGPT-facing capability token. The
collector uses the separate `INGEST_TOKEN`; it is never entered into ChatGPT.
Both values must be distinct, random, URL-safe, and at least 32 characters.
They never appear in Git, source, logs, or this README.

After the first successful GitHub Actions deployment, configure the collector
with the returned private URL without placing it in chat or source:

```bash
python3 collector.py \
  --cdp-url http://127.0.0.1:9222/json/list \
  --state state/usage.sqlite3 \
  --upload-url "$USAGE_BRIDGE_INGEST_URL"
```

The deployment workflow does not publish a URL until Cloudflare reports a
successful deployment. The exact Worker revision, missing/wrong-token probes,
`initialize`, `tools/list`, and a representative `tools/call` must be checked
before the URL is connected in ChatGPT.

## MCP contract

The server exposes exactly one operation:

```text
get_codex_usage()
```

Its successful result contains exactly:

```json
{
  "weekly_remaining": 84,
  "reset_at": "2026-08-15T23:51:00+03:00",
  "credits_remaining": 211,
  "observed_at": "2026-08-09T12:00:00+00:00"
}
```

Missing or incorrect capability tokens return `401`. No tool can write to
OpenAI or mutate the local browser. The server does not log request paths,
because the capability token is in the path.

## Scheduled-task prompt

After the app is connected and a real call succeeds, use this prompt for an
hourly task:

```text
Every hour, call get_codex_usage. Compare weekly_remaining and reset_at with
the prior successful observation in this task. Notify me only when the weekly
allowance increases or reset_at moves forward; include the four returned
fields. Otherwise remain silent. Do not infer a reset from a failed, missing,
or uncertain observation.
```

Custom MCP access from Scheduled Tasks must be verified in the target ChatGPT
account; it is not assumed by this repository. The custom-app surface is
ChatGPT web developer mode. OpenAI's current documentation says custom apps
are not available on mobile, so this project does not claim native/mobile app
invocation.

## Verification

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q usage_bridge.py collector.py tests
node --test worker/test/index.test.mjs
git diff --check
```

The tests cover strict parsing, authentication uncertainty, failed-parse
non-publication, deterministic reset detection, local CDP text collection,
exact tool inventory, exact response fields, and missing/wrong capability
tokens. The Worker tests additionally cover the separate ingestion boundary
and Durable Object persistence.
