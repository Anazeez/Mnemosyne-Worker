"""Minimal, read-only Codex usage bridge.

The collector and the MCP server deliberately have a narrow boundary:
collector input is local browser text; the persisted record contains only the
four fields returned by the MCP operation.
"""

from __future__ import annotations

import argparse
import html.parser
import json
import os
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional


OBSERVATION_FIELDS = (
    "weekly_remaining",
    "reset_at",
    "credits_remaining",
    "observed_at",
)
DEFAULT_TIMEZONE = "Asia/Riyadh"
MCP_PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "codex-usage-bridge"
SERVER_VERSION = "0.1.0"
MAX_REQUEST_BYTES = 64 * 1024


class UsageBridgeError(Exception):
    """Base class for stable, non-sensitive bridge errors."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.public_message = message


class UsageParseError(UsageBridgeError):
    def __init__(self, message: str = "The usage page could not be verified"):
        super().__init__("USAGE_PARSE_UNCERTAIN", message)


class StateError(UsageBridgeError):
    def __init__(self, code: str, message: str):
        super().__init__(code, message)


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes = b""


class _VisibleTextParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._ignored = 0
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() in {"script", "style", "noscript", "template"}:
            self._ignored += 1

    def handle_endtag(self, tag):
        if tag.lower() in {"script", "style", "noscript", "template"}:
            self._ignored = max(0, self._ignored - 1)

    def handle_data(self, data):
        if not self._ignored:
            self._parts.append(data)

    @property
    def text(self):
        return " ".join(self._parts)


def html_to_visible_text(document: str) -> str:
    parser = _VisibleTextParser()
    parser.feed(document)
    parser.close()
    return parser.text


def _timezone(name: str):
    if name == "UTC":
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except (ImportError, KeyError):
        if name == DEFAULT_TIMEZONE:
            return timezone(timedelta(hours=3), name="+03:00")
        raise UsageParseError("The configured usage timezone is unsupported")


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise UsageParseError("The observation timestamp has no timezone")
    return value.astimezone(timezone.utc).replace(microsecond=0)


def _parse_reset_at(value: str, observed_at: datetime, timezone_name: str) -> str:
    candidate_text = value.strip().rstrip(".,")
    iso_text = candidate_text.replace("Z", "+00:00")
    try:
        candidate = datetime.fromisoformat(iso_text)
    except ValueError:
        candidate = None
    if candidate is not None:
        if candidate.tzinfo is None:
            candidate = candidate.replace(tzinfo=_timezone(timezone_name))
        return candidate.replace(microsecond=0).isoformat()

    local_zone = _timezone(timezone_name)
    local_observed = observed_at.astimezone(local_zone)
    match = re.fullmatch(
        r"(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?"
        r"(\d{1,2}):(\d{2})\s*(AM|PM)",
        candidate_text,
        re.IGNORECASE,
    )
    if not match:
        raise UsageParseError("The reset timestamp is not unambiguous")

    day_name, hour_text, minute_text, meridiem = match.groups()
    hour = int(hour_text)
    minute = int(minute_text)
    if hour < 1 or hour > 12 or minute > 59:
        raise UsageParseError("The reset timestamp is not valid")
    if meridiem.upper() == "PM" and hour != 12:
        hour += 12
    if meridiem.upper() == "AM" and hour == 12:
        hour = 0

    target_date = local_observed.date()
    if day_name:
        target_weekday = [
            "monday", "tuesday", "wednesday", "thursday",
            "friday", "saturday", "sunday",
        ].index(day_name.lower())
        target_date += timedelta(days=(target_weekday - target_date.weekday()) % 7)
    candidate = datetime.combine(target_date, time(hour, minute), tzinfo=local_zone)
    if candidate <= local_observed:
        candidate += timedelta(days=7 if day_name else 1)
    return candidate.replace(microsecond=0).isoformat()


def parse_usage_text(
    text: str,
    *,
    observed_at: Optional[datetime] = None,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> Dict[str, Any]:
    """Parse only a verified, rendered Usage page text into four fields."""

    if not isinstance(text, str):
        raise UsageParseError()
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        raise UsageParseError()
    if re.search(
        r"\b(sign\s+in|log\s+in|unauthorized|authentication\s+required|access\s+denied)\b",
        normalized,
        re.IGNORECASE,
    ):
        raise UsageParseError("Authentication state could not be verified")
    if not re.search(r"\bcodex\b|\busage\b", normalized, re.IGNORECASE):
        raise UsageParseError()

    weekly_match = re.search(
        r"(?:weekly\s+(?:allowance|usage)|allowance|usage).*?"
        r"(\d{1,3})\s*%\s*(?:remaining|left)\b",
        normalized,
        re.IGNORECASE,
    )
    if weekly_match is None:
        weekly_match = re.search(
            r"\b(\d{1,3})\s*%\s*(?:remaining|left)\b",
            normalized,
            re.IGNORECASE,
        )
    credits_match = re.search(
        r"\bcredits?\s*[:\-]\s*([0-9][0-9,]*)\b",
        normalized,
        re.IGNORECASE,
    )
    reset_match = re.search(
        r"\breset\s*[:\-]\s*(.+?)(?=\s+(?:credits?|weekly|allowance|usage)\s*[:\-]|$)",
        normalized,
        re.IGNORECASE,
    )
    if not weekly_match or not credits_match or not reset_match:
        raise UsageParseError("Required usage values are missing")

    weekly_remaining = int(weekly_match.group(1))
    credits_remaining = int(credits_match.group(1).replace(",", ""))
    if weekly_remaining > 100:
        raise UsageParseError("The weekly allowance is outside its valid range")

    if observed_at is None:
        observed_at = datetime.now(timezone.utc)
    observed_at = _aware_utc(observed_at)
    return {
        "weekly_remaining": weekly_remaining,
        "reset_at": _parse_reset_at(reset_match.group(1), observed_at, timezone_name),
        "credits_remaining": credits_remaining,
        "observed_at": observed_at.isoformat(),
    }


def parse_usage_html(
    document: str,
    *,
    observed_at: Optional[datetime] = None,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> Dict[str, Any]:
    return parse_usage_text(
        html_to_visible_text(document),
        observed_at=observed_at,
        timezone_name=timezone_name,
    )


def _validate_observation(observation: Mapping[str, Any]) -> Dict[str, Any]:
    if set(observation) != set(OBSERVATION_FIELDS):
        raise StateError("INVALID_OBSERVATION", "The observation shape is invalid")
    weekly = observation["weekly_remaining"]
    credits = observation["credits_remaining"]
    if type(weekly) is not int or not 0 <= weekly <= 100:
        raise StateError("INVALID_OBSERVATION", "The observation shape is invalid")
    if type(credits) is not int or credits < 0:
        raise StateError("INVALID_OBSERVATION", "The observation shape is invalid")
    try:
        reset_at = datetime.fromisoformat(str(observation["reset_at"]))
        observed_at = datetime.fromisoformat(str(observation["observed_at"]))
    except ValueError as exc:
        raise StateError("INVALID_OBSERVATION", "The observation shape is invalid") from exc
    if reset_at.tzinfo is None or observed_at.tzinfo is None:
        raise StateError("INVALID_OBSERVATION", "The observation shape is invalid")
    return {
        "weekly_remaining": weekly,
        "reset_at": reset_at.replace(microsecond=0).isoformat(),
        "credits_remaining": credits,
        "observed_at": observed_at.astimezone(timezone.utc).replace(microsecond=0).isoformat(),
    }


def _connect_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(path))
    connection.execute(
        "CREATE TABLE IF NOT EXISTS observations ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "weekly_remaining INTEGER NOT NULL, "
        "reset_at TEXT NOT NULL, "
        "credits_remaining INTEGER NOT NULL, "
        "observed_at TEXT NOT NULL"
        ")"
    )
    connection.commit()
    return connection


def read_current_observation(path: Path) -> Dict[str, Any]:
    connection = _connect_state(Path(path))
    try:
        row = connection.execute(
            "SELECT weekly_remaining, reset_at, credits_remaining, observed_at "
            "FROM observations ORDER BY id DESC LIMIT 1"
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        raise StateError("NO_OBSERVATION", "No verified usage observation is available")
    return {
        "weekly_remaining": row[0],
        "reset_at": row[1],
        "credits_remaining": row[2],
        "observed_at": row[3],
    }


def detect_reset(previous: Mapping[str, Any], current: Mapping[str, Any]) -> bool:
    previous_observation = _validate_observation(previous)
    current_observation = _validate_observation(current)
    return (
        current_observation["weekly_remaining"] > previous_observation["weekly_remaining"]
        or datetime.fromisoformat(current_observation["reset_at"])
        > datetime.fromisoformat(previous_observation["reset_at"])
    )


def publish_observation(path: Path, observation: Mapping[str, Any]) -> bool:
    normalized = _validate_observation(observation)
    previous = None
    try:
        previous = read_current_observation(Path(path))
    except StateError as error:
        if error.code != "NO_OBSERVATION":
            raise
    connection = _connect_state(Path(path))
    try:
        connection.execute(
            "INSERT INTO observations "
            "(weekly_remaining, reset_at, credits_remaining, observed_at) "
            "VALUES (?, ?, ?, ?)",
            (
                normalized["weekly_remaining"],
                normalized["reset_at"],
                normalized["credits_remaining"],
                normalized["observed_at"],
            ),
        )
        connection.commit()
    finally:
        connection.close()
    return previous is not None and detect_reset(previous, normalized)


MCP_TOOL = {
    "name": "get_codex_usage",
    "description": "Read the latest verified Codex usage observation.",
    "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
    "annotations": {
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
}


def _json_response(payload: Mapping[str, Any], status: int = 200) -> Response:
    return Response(
        status=status,
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
        body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
    )


def _rpc_result(identifier: Any, result: Mapping[str, Any]) -> Response:
    return _json_response({"jsonrpc": "2.0", "id": identifier, "result": result})


def _rpc_error(identifier: Any, code: int, message: str) -> Response:
    return _json_response({
        "jsonrpc": "2.0",
        "id": identifier,
        "error": {"code": code, "message": message},
    }, status=400)


class UsageBridgeApplication:
    def __init__(self, capability_token: str, state_path: Path):
        self._capability_token = capability_token
        self._state_path = Path(state_path)

    def _authorized_path(self, path: str) -> bool:
        if path == "/mcp":
            return False
        prefix = "/mcp/"
        if not path.startswith(prefix) or path.count("/") != 2:
            return False
        return secrets.compare_digest(path[len(prefix):], self._capability_token)

    def handle(
        self,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> Response:
        if path == "/mcp" or path.startswith("/mcp/"):
            if not self._authorized_path(path):
                return _json_response({"error": "unauthorized"}, status=401)
        else:
            return _json_response({"error": "not_found"}, status=404)
        if method != "POST":
            return Response(
                status=405,
                headers={"Allow": "POST", "Cache-Control": "no-store"},
            )
        if len(body) > MAX_REQUEST_BYTES:
            return _json_response({"error": "request_too_large"}, status=413)
        try:
            request = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _rpc_error(None, -32700, "Invalid JSON")
        if not isinstance(request, dict):
            return _rpc_error(None, -32600, "Invalid Request")
        identifier = request.get("id")
        method_name = request.get("method")
        if method_name == "notifications/initialized":
            return Response(status=202, headers={"Cache-Control": "no-store"})
        if method_name == "initialize":
            return _rpc_result(identifier, {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            })
        if method_name == "tools/list":
            return _rpc_result(identifier, {"tools": [MCP_TOOL]})
        if method_name == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict) or params.get("name") != MCP_TOOL["name"]:
                return _rpc_error(identifier, -32602, "Unknown tool")
            arguments = params.get("arguments", {})
            if arguments not in ({}, None):
                return _rpc_error(identifier, -32602, "The usage tool takes no arguments")
            try:
                observation = read_current_observation(self._state_path)
            except StateError as error:
                return _rpc_result(identifier, {
                    "content": [{
                        "type": "text",
                        "text": json.dumps({"error": {
                            "code": error.code,
                            "message": error.public_message,
                        }}, separators=(",", ":")),
                    }],
                    "isError": True,
                })
            text = json.dumps(observation, separators=(",", ":"))
            return _rpc_result(identifier, {
                "content": [{"type": "text", "text": text}],
                "structuredContent": observation,
            })
        return _rpc_error(identifier, -32601, "Method not found")


class _McpHandler(BaseHTTPRequestHandler):
    server_version = "CodexUsageBridge/0.1"

    def log_message(self, format, *args):
        # The request path contains the capability token; never log it.
        return

    def do_POST(self):
        length_text = self.headers.get("Content-Length", "0")
        try:
            length = int(length_text)
        except ValueError:
            length = MAX_REQUEST_BYTES + 1
        body = self.rfile.read(min(length, MAX_REQUEST_BYTES + 1))
        response = self.server.application.handle(
            "POST", self.path.split("?", 1)[0], self.headers, body
        )
        self.send_response(response.status)
        for name, value in response.headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if response.body:
            self.wfile.write(response.body)

    def do_GET(self):
        response = self.server.application.handle(
            "GET", self.path.split("?", 1)[0], self.headers, b""
        )
        self.send_response(response.status)
        for name, value in response.headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if response.body:
            self.wfile.write(response.body)


def run_server(host: str, port: int, capability_token: str, state_path: Path):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", capability_token):
        raise SystemExit("USAGE_BRIDGE_CAPABILITY_TOKEN must be at least 32 URL-safe characters")
    httpd = ThreadingHTTPServer((host, port), _McpHandler)
    httpd.application = UsageBridgeApplication(capability_token, state_path)
    print(f"Codex Usage Bridge listening on {host}:{port}", flush=True)
    httpd.serve_forever()


def _cli_collect_text(path: Path, state_path: Path, timezone_name: str):
    observation = parse_usage_html(
        path.read_text(encoding="utf-8"),
        timezone_name=timezone_name,
    )
    reset_detected = publish_observation(state_path, observation)
    print(json.dumps({
        "weekly_remaining": observation["weekly_remaining"],
        "reset_at": observation["reset_at"],
        "credits_remaining": observation["credits_remaining"],
        "observed_at": observation["observed_at"],
        "reset_detected": reset_detected,
    }, separators=(",", ":")))


def main(argv: Optional[Iterable[str]] = None):
    parser = argparse.ArgumentParser(description="Run the read-only Codex Usage Bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve")
    serve.add_argument("--host", default=os.environ.get("USAGE_BRIDGE_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.environ.get("USAGE_BRIDGE_PORT", "8787")))
    serve.add_argument("--state", type=Path, default=Path(os.environ.get(
        "USAGE_BRIDGE_STATE_PATH", "state/usage.sqlite3"
    )))
    collect = subparsers.add_parser("collect-text")
    collect.add_argument("path", type=Path)
    collect.add_argument("--state", type=Path, default=Path(os.environ.get(
        "USAGE_BRIDGE_STATE_PATH", "state/usage.sqlite3"
    )))
    collect.add_argument("--timezone", default=os.environ.get(
        "USAGE_BRIDGE_TIMEZONE", DEFAULT_TIMEZONE
    ))
    args = parser.parse_args(argv)
    if args.command == "serve":
        token = os.environ.get("USAGE_BRIDGE_CAPABILITY_TOKEN", "")
        run_server(args.host, args.port, token, args.state)
    elif args.command == "collect-text":
        _cli_collect_text(args.path, args.state, args.timezone)


if __name__ == "__main__":
    main()
