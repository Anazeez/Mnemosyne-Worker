const MAX_AGE_SECONDS = 300;

export class MeshSignatureError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = "MeshSignatureError";
    this.code = code;
    this.status = status;
  }
}

export async function signMeshEnvelope(rawBody, timestamp, secret) {
  const secretBytes = new TextEncoder().encode(String(secret ?? ""));
  if (secretBytes.byteLength < 32) {
    throw new MeshSignatureError("MESH_SECRET_INVALID", 503);
  }
  const bodyHash = await sha256Hex(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}\n${bodyHash}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyMeshEnvelope({
  rawBody,
  timestamp,
  signature,
  secret,
  now = () => new Date(),
}) {
  if (!/^[a-f0-9]{64}$/iu.test(String(signature ?? ""))) {
    throw new MeshSignatureError("MESH_SIGNATURE_INVALID");
  }
  const signedAt = Date.parse(String(timestamp ?? ""));
  const current = now().getTime();
  if (!Number.isFinite(signedAt) || Math.abs(current - signedAt) > MAX_AGE_SECONDS * 1_000) {
    throw new MeshSignatureError("MESH_TIMESTAMP_INVALID");
  }
  const expected = await signMeshEnvelope(rawBody, timestamp, secret);
  if (!constantTimeHexEqual(expected, String(signature).toLowerCase())) {
    throw new MeshSignatureError("MESH_SIGNATURE_INVALID");
  }
  return true;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value ?? "")),
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
