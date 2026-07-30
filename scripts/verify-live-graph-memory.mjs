import { pathToFileURL } from "node:url";

export async function verifyLiveGraphMemory({
  baseUrl,
  expectedOrigin = new URL(baseUrl).origin,
  expectTools = 0,
  expectActions = 0,
  expectChallenge = false,
  challengeToken,
  accessToken,
  fetchImpl = fetch,
}) {
  const base = new URL(baseUrl);
  const expected = new URL(expectedOrigin);
  assert(base.protocol === "https:", "https_required");
  assert(expected.protocol === "https:", "expected_origin_https_required");
  assert(base.origin === expected.origin, "base_origin_invalid");

  const ping = await getJson(fetchImpl, new URL("/ping", base));
  const authorization = await getJson(
    fetchImpl,
    new URL("/.well-known/oauth-authorization-server", base),
  );
  const resource = await getJson(
    fetchImpl,
    new URL("/.well-known/oauth-protected-resource", base),
  );
  const openapi = await getJson(fetchImpl, new URL("/openapi.json", base));

  assert(ping.graph_memory, "graph_memory_status_missing");
  assert(
    Array.isArray(authorization.code_challenge_methods_supported) &&
      authorization.code_challenge_methods_supported.includes("S256"),
    "s256_pkce_missing",
  );
  for (const value of [
    authorization.issuer,
    authorization.authorization_endpoint,
    authorization.token_endpoint,
  ]) {
    assert(new URL(value).origin === expected.origin, "oauth_origin_invalid");
  }
  assert(new URL(resource.resource).origin === expected.origin, "resource_origin_invalid");
  const expectedScopes = [
    "memory:candidate:read",
    "memory:propose",
    "memory:read",
    "memory:search",
  ];
  assert(
    Array.isArray(resource.scopes_supported) &&
      JSON.stringify([...resource.scopes_supported].sort()) ===
        JSON.stringify(expectedScopes),
    "protected_resource_scopes_invalid",
  );
  assert(Object.keys(openapi.paths).length === 5, "openapi_path_count_invalid");
  assert(
    !/publish|validate|resolve|invalidate|delete/i.test(
      Object.keys(openapi.paths).join(" "),
    ),
    "portal_publication_exposed",
  );
  assert(
    Boolean(ping.graph_memory.actions) === (expectActions > 0),
    "actions_state_invalid",
  );

  const protectedResponses = await Promise.all(
    ["/mcp", "/v1/memory/search"].map(path =>
      fetchImpl(new URL(path, base), {
        method: path === "/mcp" ? "POST" : "GET",
        headers: { Accept: "application/json" },
      }),
    ),
  );
  assert(
    protectedResponses.every(response => response.status === 401),
    "protected_route_allows_anonymous",
  );

  let challenge = "not_expected";
  if (expectChallenge) {
    const response = await fetchImpl(
      new URL("/.well-known/openai-apps-challenge", base),
      { headers: { Accept: "text/plain" } },
    );
    assert(response.ok, "challenge_missing");
    assert(
      response.headers.get("content-type")?.startsWith("text/plain"),
      "challenge_content_type_invalid",
    );
    const body = await response.text();
    assert(body.length > 0 && !body.includes("\n"), "challenge_shape_invalid");
    if (challengeToken) assert(body === challengeToken, "challenge_value_invalid");
    challenge = "present";
  }

  let toolCount = 0;
  if (expectTools > 0) {
    assert(accessToken, "access_token_required_for_tool_verification");
    const response = await fetchImpl(new URL("/mcp", base), {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert(response.ok, "mcp_tool_list_failed");
    toolCount = (await response.json()).result.tools.length;
    assert(toolCount === expectTools, "mcp_tool_count_invalid");
  } else {
    assert(ping.graph_memory.mcp === false, "mcp_expected_disabled");
  }

  return {
    status: "verified",
    origin: expected.origin,
    graph_memory: ping.graph_memory,
    oauth_s256: true,
    oauth_scopes: resource.scopes_supported,
    openapi_paths: Object.keys(openapi.paths).sort(),
    mcp_tool_count: toolCount,
    actions_operation_count: expectActions,
    challenge,
    protected_routes: "denied_without_token",
    portal_publication: "denied",
  };
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
  });
  assert(response.ok, `request_failed:${url.pathname}:${response.status}`);
  return response.json();
}

function parseArguments(values) {
  const read = name => {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] : undefined;
  };
  const has = name => values.includes(name);
  const base = read("--base-url");
  if (!base) throw new Error("base_url_required");
  return {
    baseUrl: base,
    expectedOrigin: read("--expected-origin") || new URL(base).origin,
    expectTools: Number(read("--expect-tools") || 0),
    expectActions: Number(read("--expect-actions") || 0),
    expectChallenge: has("--expect-challenge"),
    challengeToken: process.env.OPENAI_APPS_CHALLENGE,
    accessToken: process.env.MNEMOSYNE_ACCESS_TOKEN,
  };
}

function assert(condition, code) {
  if (!condition) throw new Error(`live_verification_failed:${code}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await verifyLiveGraphMemory(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
