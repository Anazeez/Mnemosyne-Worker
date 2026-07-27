const arguments_ = parseArguments(process.argv.slice(2));
const baseUrl = new URL(arguments_.baseUrl);
const ping = await getJson(new URL("/ping", baseUrl));
const authorization = await getJson(
  new URL("/.well-known/oauth-authorization-server", baseUrl),
);
const resource = await getJson(
  new URL("/.well-known/oauth-protected-resource", baseUrl),
);
const openapi = await getJson(new URL("/openapi.json", baseUrl));

assert(ping.graph_memory, "graph_memory_status_missing");
assert(
  Array.isArray(authorization.code_challenge_methods_supported) &&
    authorization.code_challenge_methods_supported.includes("S256"),
  "s256_pkce_missing",
);
assert(
  Array.isArray(resource.scopes_supported) &&
    resource.scopes_supported.length === 4,
  "protected_resource_scopes_invalid",
);
assert(Object.keys(openapi.paths).length === 5, "openapi_path_count_invalid");
assert(
  !/publish|validate|resolve|invalidate|delete/i.test(
    Object.keys(openapi.paths).join(" "),
  ),
  "portal_publication_exposed",
);

let toolCount = 0;
if (arguments_.expectTools > 0) {
  const token = process.env.MNEMOSYNE_ACCESS_TOKEN;
  assert(token, "access_token_required_for_tool_verification");
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
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
  assert(toolCount === arguments_.expectTools, "mcp_tool_count_invalid");
} else {
  assert(ping.graph_memory.mcp === false, "mcp_expected_disabled");
}

const report = {
  status: "verified",
  graph_memory: ping.graph_memory,
  oauth_s256: true,
  oauth_scopes: resource.scopes_supported,
  openapi_paths: Object.keys(openapi.paths).sort(),
  mcp_tool_count: toolCount,
  portal_publication: "denied",
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function getJson(url) {
  const response = await fetch(url, {
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
  const base = read("--base-url");
  if (!base) throw new Error("base_url_required");
  return {
    baseUrl: base,
    expectTools: Number(read("--expect-tools") || 0),
  };
}

function assert(condition, code) {
  if (!condition) throw new Error(`live_verification_failed:${code}`);
}
