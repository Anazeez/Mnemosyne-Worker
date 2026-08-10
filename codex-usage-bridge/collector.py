"""Local authenticated-browser collector for the Codex Usage Bridge.

Only Chrome DevTools Protocol's rendered ``document.body.innerText`` is read.
The collector refuses non-local DevTools sockets and never requests cookies,
headers, storage, or page HTML outside the rendered text.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import socket
import struct
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from usage_bridge import (
    DEFAULT_TIMEZONE,
    OBSERVATION_FIELDS,
    parse_usage_text,
    publish_observation,
)


CDP_EXACT_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
CDP_BODY_EXPRESSION = "document.body.innerText"


def _local_websocket_url(value: str) -> bool:
    parsed = urllib.parse.urlsplit(value)
    return parsed.scheme == "ws" and parsed.hostname in CDP_EXACT_LOCAL_HOSTS


def select_usage_target(
    targets: Iterable[Mapping[str, Any]],
    url_hint: Optional[str] = None,
) -> Mapping[str, Any]:
    candidates = []
    for target in targets:
        if not isinstance(target, Mapping) or target.get("type") != "page":
            continue
        page_url = str(target.get("url", ""))
        socket_url = str(target.get("webSocketDebuggerUrl", ""))
        if not _local_websocket_url(socket_url):
            continue
        if url_hint and url_hint not in page_url:
            continue
        lower_url = page_url.lower()
        if not ("usage" in lower_url and ("chatgpt.com" in lower_url or "openai.com" in lower_url)):
            continue
        candidates.append(target)
    if not candidates:
        raise ValueError("No local authenticated Codex Usage page was found")
    return candidates[0]


def _read_exact(connection: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            raise ConnectionError("The local browser connection closed")
        data.extend(chunk)
    return bytes(data)


class _CdpWebSocket:
    def __init__(self, websocket_url: str):
        if not _local_websocket_url(websocket_url):
            raise ValueError("The DevTools socket must remain on the local machine")
        parsed = urllib.parse.urlsplit(websocket_url)
        self._connection = socket.create_connection(
            (parsed.hostname, parsed.port or 80),
            timeout=5,
        )
        self._connection.settimeout(5)
        key = base64.b64encode(hashlib.sha1(websocket_url.encode()).digest()[:16]).decode()
        request = (
            f"GET {parsed.path or '/'}{'?' + parsed.query if parsed.query else ''} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port or 80}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self._connection.sendall(request)
        response = b""
        while b"\r\n\r\n" not in response:
            response += self._connection.recv(4096)
        header_text = response.decode("ascii", "replace")
        if not header_text.startswith("HTTP/1.1 101"):
            self.close()
            raise ConnectionError("The local browser did not accept the DevTools connection")
        expected = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
        ).digest()).decode()
        actual = next(
            (line.split(":", 1)[1].strip() for line in header_text.split("\r\n")
             if line.lower().startswith("sec-websocket-accept:")),
            "",
        )
        if not actual or not secrets_compare(actual, expected):
            self.close()
            raise ConnectionError("The local browser handshake could not be verified")

    def send_text(self, payload: str):
        data = payload.encode("utf-8")
        mask = hashlib.sha256(payload.encode("utf-8")).digest()[:4]
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        length = len(data)
        if length < 126:
            header = bytes([0x81, 0x80 | length])
        elif length < 65536:
            header = bytes([0x81, 0x80 | 126]) + struct.pack("!H", length)
        else:
            header = bytes([0x81, 0x80 | 127]) + struct.pack("!Q", length)
        self._connection.sendall(header + mask + masked)

    def receive_text(self) -> str:
        while True:
            first, second = _read_exact(self._connection, 2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", _read_exact(self._connection, 2))[0]
            elif length == 127:
                length = struct.unpack("!Q", _read_exact(self._connection, 8))[0]
            mask = _read_exact(self._connection, 4) if second & 0x80 else None
            data = bytearray(_read_exact(self._connection, length))
            if mask:
                for index in range(length):
                    data[index] ^= mask[index % 4]
            if opcode == 0x9:
                self._send_control(0xA, bytes(data))
                continue
            if opcode == 0x8:
                raise ConnectionError("The local browser closed the DevTools connection")
            if opcode != 0x1:
                continue
            return bytes(data).decode("utf-8")

    def _send_control(self, opcode: int, data: bytes):
        mask = b"\x00\x00\x00\x01"
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self._connection.sendall(bytes([0x80 | opcode, 0x80 | len(data)]) + mask + masked)

    def close(self):
        try:
            self._connection.close()
        except Exception:
            pass


def secrets_compare(left: str, right: str) -> bool:
    # Importing secrets in this tiny helper keeps all comparisons constant-time.
    import secrets

    return secrets.compare_digest(left, right)


def read_visible_body_text(websocket_url: str) -> str:
    client = _CdpWebSocket(websocket_url)
    try:
        client.send_text(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": CDP_BODY_EXPRESSION,
                "returnByValue": True,
                "awaitPromise": False,
            },
        }, separators=(",", ":")))
        while True:
            response = json.loads(client.receive_text())
            if response.get("id") != 1:
                continue
            result = response.get("result", {}).get("result", {})
            value = result.get("value")
            if result.get("type") != "string" or not isinstance(value, str):
                raise ValueError("The browser did not return verified visible text")
            return value
    finally:
        client.close()


def _discover_targets(discovery_url: str):
    parsed = urllib.parse.urlsplit(discovery_url)
    if parsed.hostname not in CDP_EXACT_LOCAL_HOSTS:
        raise ValueError("The DevTools discovery endpoint must remain local")
    with urllib.request.urlopen(discovery_url, timeout=5) as response:
        return json.loads(response.read(MAX_REQUEST_BYTES))


MAX_REQUEST_BYTES = 64 * 1024


def upload_observation(ingest_url: str, observation: Mapping[str, Any]):
    if set(observation) != set(OBSERVATION_FIELDS):
        raise ValueError("The upload observation shape is invalid")
    parsed = urllib.parse.urlsplit(ingest_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("The ingestion URL is invalid")
    body = json.dumps({field: observation[field] for field in OBSERVATION_FIELDS}, separators=(",", ":")).encode()
    request = urllib.request.Request(
        ingest_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "codex-usage-bridge-collector/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError("The ingestion endpoint rejected the observation")
            response.read(MAX_REQUEST_BYTES)
    except urllib.error.HTTPError as error:
        raise RuntimeError("The ingestion endpoint rejected the observation") from error
    except urllib.error.URLError as error:
        raise RuntimeError("The ingestion endpoint was unavailable") from error


def collect_from_cdp(
    cdp_url: str,
    state_path: Path,
    *,
    timezone_name: str = DEFAULT_TIMEZONE,
    url_hint: Optional[str] = None,
    upload_url: Optional[str] = None,
):
    if cdp_url.startswith("ws://"):
        websocket_url = cdp_url
    else:
        target = select_usage_target(_discover_targets(cdp_url), url_hint=url_hint)
        websocket_url = str(target["webSocketDebuggerUrl"])
    page_text = read_visible_body_text(websocket_url)
    observation = parse_usage_text(page_text, timezone_name=timezone_name)
    reset_detected = publish_observation(Path(state_path), observation)
    if upload_url:
        upload_observation(upload_url, observation)
    return {
        "weekly_remaining": observation["weekly_remaining"],
        "reset_at": observation["reset_at"],
        "credits_remaining": observation["credits_remaining"],
        "observed_at": observation["observed_at"],
        "reset_detected": reset_detected,
    }


def main(argv: Optional[Iterable[str]] = None):
    parser = argparse.ArgumentParser(description="Collect Codex Usage from a local browser")
    parser.add_argument("--cdp-url", default="http://127.0.0.1:9222/json/list")
    parser.add_argument("--state", type=Path, default=Path("state/usage.sqlite3"))
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--url-hint")
    parser.add_argument("--upload-url")
    args = parser.parse_args(argv)
    print(json.dumps(collect_from_cdp(
        args.cdp_url,
        args.state,
        timezone_name=args.timezone,
        url_hint=args.url_hint,
        upload_url=args.upload_url,
    ), separators=(",", ":")))


if __name__ == "__main__":
    main()
