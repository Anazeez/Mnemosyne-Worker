import { appendFile } from "node:fs/promises";

const TITLE = "mnemosyne-worker-OAUTH_KV";

export async function ensureOAuthKvNamespace({
  accountId,
  apiToken,
  fetchImpl = fetch,
}) {
  if (!accountId || !apiToken) throw new Error("cloudflare_credentials_missing");
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  let page = 1;
  do {
    const response = await fetchImpl(`${base}?per_page=100&page=${page}`, {
      method: "GET",
      headers,
    });
    const body = await response.json();
    if (!response.ok || body.success !== true || !Array.isArray(body.result)) {
      throw new Error("oauth_kv_list_failed");
    }
    const existing = body.result.find(namespace => namespace.title === TITLE);
    if (existing?.id) return { id: existing.id, created: false };
    if (page >= Number(body.result_info?.total_pages || 1)) break;
    page += 1;
  } while (page <= 100);

  const response = await fetchImpl(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: TITLE }),
  });
  const body = await response.json();
  if (!response.ok || body.success !== true || !body.result?.id) {
    throw new Error("oauth_kv_create_failed");
  }
  return { id: body.result.id, created: true };
}

if (process.argv[1]?.endsWith("ensure-oauth-kv.mjs")) {
  const result = await ensureOAuthKvNamespace({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  process.stdout.write(`::add-mask::${result.id}\n`);
  if (!process.env.GITHUB_ENV) throw new Error("github_env_missing");
  await appendFile(
    process.env.GITHUB_ENV,
    `OAUTH_KV_NAMESPACE_ID=${result.id}\n`,
    "utf8",
  );
  process.stdout.write(
    result.created
      ? "OAuth KV namespace created and masked.\n"
      : "OAuth KV namespace reused and masked.\n",
  );
}
