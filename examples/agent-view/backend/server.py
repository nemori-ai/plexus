"""
server.py — the Agent View backend HTTP server (zero third-party deps).

A thin streaming HTTP server built on the Python **stdlib** ``http.server`` (chosen
over Starlette/FastAPI so the demo + e2e run with nothing but a Python interpreter —
no install, no LLM key, no gateway). It exposes the EVENT CONTRACT over SSE:

    POST /api/chat   { message, mode?, scenario? }  -> text/event-stream of AgentEvent
    GET  /api/health                                -> { ok, mode }

``mode`` defaults to ``"demo"`` (deterministic replay of ``recordings/<scenario>.json``;
``scenario`` defaults to ``demo-cc-codex``). ``mode:"live"`` drives the real deepagent
loop (needs an LLM key + a running gateway; see :mod:`agent_runner`).

CORS: the Vite dev origin ``http://localhost:5173`` is allowed (plus ``127.0.0.1``)
so the web app connects in dev; preflight ``OPTIONS`` is handled.

Run:
    python server.py                      # 0.0.0.0:8848, default mode=demo
    PORT=9000 python server.py            # custom port
    # or, as a module from the backend dir:
    python -m server
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator, Optional

# Ensure sibling modules import whether run as a script or a module.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from events import to_sse  # noqa: E402
from demo_mode import iter_demo_events  # noqa: E402

DEFAULT_MODE = os.environ.get("AGENT_VIEW_MODE", "demo")
ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}


# ── event source selection ─────────────────────────────────────────────────────


def _event_source(
    message: str, mode: str, scenario: Optional[str]
) -> Iterator[Any]:
    """Pick the AgentEvent iterator for the requested mode.

    demo  → deterministic recording replay (no deps).
    live  → the real deepagent loop (imported lazily so demo never needs deepagents).
    """
    if mode == "live":
        from agent_runner import iter_live_events  # lazy: demo must not need deepagents.

        return iter_live_events(message)
    return iter_demo_events(message, scenario)


# ── request handler ────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "PlexusAgentView/0.1"
    protocol_version = "HTTP/1.1"  # keep-alive + chunked streaming.

    # Quieter logging (one line per request is enough).
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[server] " + (fmt % args) + "\n")

    # ── CORS helpers ───────────────────────────────────────────────────────────

    def _cors_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            return origin
        # Permissive fallback for dev tooling / curl (no Origin header).
        return origin or "*"

    def _send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self) -> None:  # noqa: N802 — http.server naming.
        self.send_response(204)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── routes ─────────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/api/health":
            return self._send_json(200, {"ok": True, "mode": DEFAULT_MODE})
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/api/chat":
            return self._send_json(404, {"ok": False, "error": "not found"})

        body = self._read_json_body()
        if body is None:
            return self._send_json(400, {"ok": False, "error": "invalid JSON body"})

        message = str(body.get("message", "")).strip()
        mode = str(body.get("mode") or DEFAULT_MODE)
        scenario = body.get("scenario")
        if mode not in ("demo", "live"):
            return self._send_json(400, {"ok": False, "error": f"unknown mode {mode!r}"})

        self._stream_sse(message, mode, scenario)

    # ── SSE streaming ──────────────────────────────────────────────────────────

    def _stream_sse(self, message: str, mode: str, scenario: Optional[str]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")  # disable proxy buffering.
        self._send_cors()
        self.end_headers()

        try:
            for event in _event_source(message, mode, scenario):
                self._write_chunk(to_sse(event))
            # A terminal comment so clients can detect a clean close.
            self._write_chunk(": stream-complete\n\n")
            self._write_final_chunk()
        except (BrokenPipeError, ConnectionResetError):
            return  # client navigated away; nothing to do.
        except Exception as exc:  # noqa: BLE001 — surface as an SSE error frame.
            try:
                self._write_chunk(to_sse({"type": "error", "message": str(exc)}))
                self._write_final_chunk()
            except OSError:
                pass

    # ── low-level chunked writes ───────────────────────────────────────────────

    def _write_chunk(self, text: str) -> None:
        """Write one HTTP/1.1 chunked-transfer chunk and flush (SSE needs flush)."""
        data = text.encode("utf-8")
        self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _write_final_chunk(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    # ── helpers ────────────────────────────────────────────────────────────────

    def _read_json_body(self) -> Optional[dict[str, Any]]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else None
        except (ValueError, UnicodeDecodeError):
            return None

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._send_cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass


# ── entrypoint ─────────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8848"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(
        f"[server] Plexus Agent View backend on http://{host}:{port} "
        f"(default mode={DEFAULT_MODE})\n"
        f"[server]   POST /api/chat  {{message, mode?, scenario?}}  -> SSE AgentEvent\n"
        f"[server]   GET  /api/health"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] shutting down")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
