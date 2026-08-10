import base64
import hashlib
import json
import socket
import socketserver
import struct
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

from collector import (
    collect_from_cdp,
    select_usage_target,
    upload_observation,
)


PAGE_TEXT = (
    "Codex Usage\nWeekly allowance: 84% remaining\n"
    "Reset: Saturday, 11:51 PM\nCredits: 211"
)


class _CdpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        request = b""
        while b"\r\n\r\n" not in request:
            request += self.request.recv(4096)
        headers = request.decode("ascii")
        key = next(
            line.split(":", 1)[1].strip()
            for line in headers.split("\r\n")
            if line.lower().startswith("sec-websocket-key:")
        )
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
        ).digest()).decode()
        self.request.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
        )
        payload = self._read_frame()
        request_payload = json.loads(payload.decode())
        self.assertEqual(request_payload["method"], "Runtime.evaluate")
        response = json.dumps({
            "id": request_payload["id"],
            "result": {"result": {"type": "string", "value": PAGE_TEXT}},
        }).encode()
        if len(response) < 126:
            frame = bytes([0x81, len(response)]) + response
        else:
            frame = bytes([0x81, 126]) + struct.pack("!H", len(response)) + response
        self.request.sendall(frame)

    def _read_frame(self):
        first, second = self._read_exact(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        mask = self._read_exact(4)
        data = bytearray(self._read_exact(length))
        for index in range(length):
            data[index] ^= mask[index % 4]
        return bytes(data)

    def _read_exact(self, length):
        data = b""
        while len(data) < length:
            data += self.request.recv(length - len(data))
        return data

    def assertEqual(self, left, right):
        if left != right:
            raise AssertionError((left, right))


class CollectorTests(unittest.TestCase):
    def test_selects_only_a_local_usage_page(self):
        target = select_usage_target([
            {
                "type": "page",
                "url": "https://chatgpt.com/codex/usage",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/one",
            },
            {
                "type": "page",
                "url": "https://example.invalid/usage",
                "webSocketDebuggerUrl": "ws://203.0.113.10:9222/devtools/page/two",
            },
        ])
        self.assertEqual(target["url"], "https://chatgpt.com/codex/usage")

    def test_rejects_a_remote_devtools_target(self):
        with self.assertRaises(ValueError):
            select_usage_target([
                {
                    "type": "page",
                    "url": "https://chatgpt.com/codex/usage",
                    "webSocketDebuggerUrl": "ws://203.0.113.10:9222/devtools/page/one",
                },
            ])

    def test_reads_visible_body_text_and_publishes_sanitized_state(self):
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _CdpHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                result = collect_from_cdp(
                    f"ws://127.0.0.1:{server.server_address[1]}/devtools/page/test",
                    Path(directory) / "state.sqlite3",
                    timezone_name="Asia/Riyadh",
                )
                self.assertEqual(set(result), {
                    "weekly_remaining", "reset_at", "credits_remaining",
                    "observed_at", "reset_detected",
                })
                self.assertNotIn("PAGE_TEXT", json.dumps(result))
        finally:
            server.shutdown()
            server.server_close()

    def test_uploads_only_the_four_sanitized_fields(self):
        captured = {}

        class IngestHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                captured["path"] = self.path
                captured["user_agent"] = self.headers.get("User-Agent")
                captured["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), IngestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            observation = {
                "weekly_remaining": 84,
                "reset_at": "2026-08-15T23:51:00+03:00",
                "credits_remaining": 211,
                "observed_at": "2026-08-10T00:00:00+00:00",
            }
            upload_observation(
                f"http://127.0.0.1:{server.server_address[1]}/ingest/private-token",
                observation,
            )
            self.assertEqual(captured["body"], observation)
            self.assertEqual(set(captured["body"]), {
                "weekly_remaining", "reset_at", "credits_remaining", "observed_at",
            })
            self.assertEqual(
                captured.get("user_agent"),
                "codex-usage-bridge-collector/1",
            )
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
