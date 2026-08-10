import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path

from usage_bridge import (
    UsageParseError,
    UsageBridgeApplication,
    _McpHandler,
    detect_reset,
    parse_usage_text,
    publish_observation,
    read_current_observation,
)


BASE_TIME = datetime.fromisoformat("2026-08-09T12:00:00+00:00")


class UsageParsingTests(unittest.TestCase):
    def test_parses_only_the_sanitized_usage_fields(self):
        observation = parse_usage_text(
            "Codex Usage\nWeekly allowance: 84% remaining\n"
            "Reset: Saturday, 11:51 PM\nCredits: 211",
            observed_at=BASE_TIME,
            timezone_name="Asia/Riyadh",
        )

        self.assertEqual(
            observation,
            {
                "weekly_remaining": 84,
                "reset_at": "2026-08-15T23:51:00+03:00",
                "credits_remaining": 211,
                "observed_at": "2026-08-09T12:00:00+00:00",
            },
        )
        self.assertEqual(
            set(observation),
            {"weekly_remaining", "reset_at", "credits_remaining", "observed_at"},
        )

    def test_rejects_uncertain_authentication_state(self):
        with self.assertRaises(UsageParseError):
            parse_usage_text(
                "Sign in to continue\nWeekly allowance: 84% remaining\n"
                "Reset: Saturday, 11:51 PM\nCredits: 211",
                observed_at=BASE_TIME,
                timezone_name="Asia/Riyadh",
            )

    def test_rejects_partial_or_ambiguous_usage_page(self):
        with self.assertRaises(UsageParseError):
            parse_usage_text(
                "Codex Usage\nWeekly allowance: 84% remaining",
                observed_at=BASE_TIME,
                timezone_name="Asia/Riyadh",
            )


class ObservationStateTests(unittest.TestCase):
    def test_previous_observation_drives_deterministic_reset_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.sqlite3"
            first = parse_usage_text(
                "Codex Usage\nWeekly allowance: 12% remaining\n"
                "Reset: Saturday, 11:51 PM\nCredits: 40",
                observed_at=BASE_TIME,
                timezone_name="Asia/Riyadh",
            )
            second = parse_usage_text(
                "Codex Usage\nWeekly allowance: 98% remaining\n"
                "Reset: Saturday, 11:51 PM\nCredits: 211",
                observed_at=datetime.fromisoformat("2026-08-16T00:02:00+00:00"),
                timezone_name="Asia/Riyadh",
            )

            self.assertFalse(publish_observation(state_path, first))
            self.assertTrue(publish_observation(state_path, second))
            self.assertEqual(read_current_observation(state_path), second)
            self.assertTrue(detect_reset(first, second))

    def test_failed_parse_cannot_publish_a_new_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.sqlite3"
            first = parse_usage_text(
                "Codex Usage\nWeekly allowance: 12% remaining\n"
                "Reset: Saturday, 11:51 PM\nCredits: 40",
                observed_at=BASE_TIME,
                timezone_name="Asia/Riyadh",
            )
            publish_observation(state_path, first)
            with self.assertRaises(UsageParseError):
                parse_usage_text("Sign in to continue", observed_at=BASE_TIME)
            self.assertEqual(read_current_observation(state_path), first)


class McpContractTests(unittest.TestCase):
    def test_mcp_exposes_exactly_one_read_only_tool(self):
        app = UsageBridgeApplication("test-capability-token", self._state())
        response = app.handle(
            "POST",
            "/mcp/test-capability-token",
            {"content-type": "application/json"},
            self._rpc(1, "tools/list", {}),
        )
        self.assertEqual(response.status, 200)
        payload = json.loads(response.body)
        tools = payload["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["get_codex_usage"])
        self.assertTrue(tools[0]["annotations"]["readOnlyHint"])
        self.assertFalse(tools[0]["annotations"]["destructiveHint"])

    def test_mcp_rejects_missing_and_wrong_capability_tokens(self):
        app = UsageBridgeApplication("test-capability-token", self._state())
        body = self._rpc(1, "initialize", {})
        self.assertEqual(app.handle("POST", "/mcp", {}, body).status, 401)
        self.assertEqual(
            app.handle("POST", "/mcp/wrong-token", {}, body).status,
            401,
        )

    def test_valid_mcp_call_returns_exact_sanitized_observation(self):
        app = UsageBridgeApplication("test-capability-token", self._state())
        response = app.handle(
            "POST",
            "/mcp/test-capability-token",
            {"content-type": "application/json"},
            self._rpc(2, "tools/call", {"name": "get_codex_usage", "arguments": {}}),
        )
        self.assertEqual(response.status, 200)
        payload = json.loads(response.body)
        returned = json.loads(payload["result"]["content"][0]["text"])
        self.assertEqual(set(returned), {
            "weekly_remaining", "reset_at", "credits_remaining", "observed_at",
        })
        self.assertNotIn("reset_detected", returned)

    def test_empty_mcp_call_returns_one_coherent_no_observation_error(self):
        app = UsageBridgeApplication(
            "test-capability-token",
            Path(tempfile.mkdtemp()) / "empty.sqlite3",
        )
        response = app.handle(
            "POST",
            "/mcp/test-capability-token",
            {"content-type": "application/json"},
            self._rpc(4, "tools/call", {
                "name": "get_codex_usage",
                "arguments": {},
            }),
        )
        payload = json.loads(response.body)
        expected_error = {
            "error": {
                "code": "NO_OBSERVATION",
                "message": "No verified usage observation is available",
            },
        }
        self.assertEqual(
            json.loads(payload["result"]["content"][0]["text"]),
            expected_error,
        )
        self.assertEqual(payload["result"]["structuredContent"], expected_error)
        self.assertTrue(payload["result"]["isError"])
        self.assertNotIn("error_code", payload)

    def test_live_http_server_proves_missing_wrong_and_valid_auth(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _McpHandler)
        server.application = UsageBridgeApplication("test-capability-token", self._state())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = self._rpc(3, "tools/call", {
                "name": "get_codex_usage",
                "arguments": {},
            })
            for path in ("/mcp", "/mcp/wrong-token"):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(
                        urllib.request.Request(
                            f"http://127.0.0.1:{server.server_address[1]}{path}",
                            data=body,
                            method="POST",
                        )
                    )
                self.assertEqual(caught.exception.code, 401)
            response = urllib.request.urlopen(
                urllib.request.Request(
                    f"http://127.0.0.1:{server.server_address[1]}"
                    "/mcp/test-capability-token",
                    data=body,
                    method="POST",
                )
            )
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            self.assertEqual(
                set(payload["result"]["structuredContent"]),
                {"weekly_remaining", "reset_at", "credits_remaining", "observed_at"},
            )
        finally:
            server.shutdown()
            server.server_close()

    @staticmethod
    def _rpc(identifier, method, params):
        return json.dumps({
            "jsonrpc": "2.0",
            "id": identifier,
            "method": method,
            "params": params,
        }).encode()

    @staticmethod
    def _state():
        directory = tempfile.mkdtemp()
        path = Path(directory) / "state.sqlite3"
        observation = parse_usage_text(
            "Codex Usage\nWeekly allowance: 84% remaining\n"
            "Reset: Saturday, 11:51 PM\nCredits: 211",
            observed_at=BASE_TIME,
            timezone_name="Asia/Riyadh",
        )
        publish_observation(path, observation)
        return path


if __name__ == "__main__":
    unittest.main()
