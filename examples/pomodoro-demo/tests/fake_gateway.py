"""
A FAKE in-process Plexus gateway — a transport stub for the 4 wire endpoints the
helper touches, so the polling state machine + SKILL.md emission can be unit-tested
WITHOUT a running Plexus (which isn't up, and whose t2/t3 capabilities may not exist
yet). Models the request/response SHAPES from packages/protocol/src/types.ts.

It is fetch-shaped: ``request(method, url, headers, json)`` → an object with
``status_code`` / ``.json()`` / ``.text``. Drop it into ``PlexusClient(transport=...)``.

Key behavior under test: a grant can be configured to PEND, and ``GET
/grants/status`` flips from ``pending`` to ``approved`` after N polls (the owner
approving in the UI) — or to ``denied`` / ``expired``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlsplit, parse_qs

GATEWAY_HOST = "127.0.0.1:7077"
BASE_URL = f"http://{GATEWAY_HOST}"


@dataclass
class FakeResponse:
    status_code: int
    _body: Any

    def json(self) -> Any:
        return self._body

    @property
    def text(self) -> str:
        return json.dumps(self._body) if self._body is not None else ""


# A small default capability set (generic — not pomodoro-specific) so emission +
# invoke tests exercise read / write / execute / workflow + io schemas.
DEFAULT_CAPABILITIES = [
    {
        "id": "workspace.list",
        "source": "workspace",
        "kind": "capability",
        "label": "List workspace files",
        "describe": "List files under the authorized directory. Use when you need to "
        "see what is present before reading.",
        "grants": ["read"],
        "transport": "local-rest",
        "provenance": "first-party",
        "sensitivity": "low",
        "recommendedTrustWindow": {"kind": "7d"},
        "io": {
            "input": {"type": "object", "properties": {"subdir": {"type": "string"}}},
            "output": {"type": "array", "items": {"type": "string"}},
        },
    },
    {
        "id": "workspace.read",
        "source": "workspace",
        "kind": "capability",
        "label": "Read a workspace file",
        "describe": "Read a UTF-8 file under the authorized directory. Use when you "
        "need the contents of a known file.",
        "grants": ["read"],
        "transport": "local-rest",
        "provenance": "first-party",
        "sensitivity": "low",
        "recommendedTrustWindow": {"kind": "7d"},
        "io": {
            "input": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            "output": {"type": "string"},
        },
    },
    {
        "id": "workspace.write",
        "source": "workspace",
        "kind": "capability",
        "label": "Write a workspace file",
        "describe": "Write/overwrite a UTF-8 file under the authorized directory. "
        "Mutating — pends for the owner.",
        "grants": ["write"],
        "transport": "local-rest",
        "provenance": "first-party",
        "sensitivity": "elevated",
        "recommendedTrustWindow": {"kind": "1d"},
        "io": {
            "input": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            }
        },
    },
    {
        "id": "claudecode.run",
        "source": "claudecode",
        "kind": "capability",
        "label": "Run Claude Code",
        "describe": "Run Claude Code headless inside the authorized directory with a "
        "prompt. Execute — pends for the owner.",
        "grants": ["execute"],
        "transport": "cli",
        "provenance": "first-party",
        "sensitivity": "high",
        "recommendedTrustWindow": {"kind": "1h"},
        "io": {
            "input": {
                "type": "object",
                "properties": {"prompt": {"type": "string"}},
                "required": ["prompt"],
            }
        },
    },
    {
        # A pure usage-skill entry — must be IGNORED by capability emission.
        "id": "workspace.write.how-to-use",
        "source": "workspace",
        "kind": "skill",
        "label": "How to use workspace.write",
        "describe": "Usage guidance.",
        "grants": [],
        "transport": "skill",
        "body": {"format": "markdown", "markdown": "# guidance"},
    },
]


@dataclass
class FakeGateway:
    """Configurable fake. Mutating-verb grants PEND and flip to ``approved`` after
    ``pending_polls`` polls of /grants/status (the owner approving in the UI)."""

    capabilities: list[dict[str, Any]] = field(default_factory=lambda: list(DEFAULT_CAPABILITIES))
    # Per-pendingId resolution config.
    pending_polls: int = 2           # flip to terminal after this many status polls.
    pending_outcome: str = "approved"  # "approved" | "denied" | "expired" | "never".
    # Which grants pend (default: any write/execute verb pends; read auto-approves).
    pend_predicate: Optional[Any] = None

    # Recorded interactions for assertions.
    requests: list[dict[str, Any]] = field(default_factory=list)

    # internal state
    _next_pending: int = field(default=0, init=False)
    _pending: dict[str, dict[str, Any]] = field(default_factory=dict, init=False)
    _next_jti: int = field(default=0, init=False)
    # invoke behavior override (e.g. force one token_expired then succeed).
    invoke_script: Optional[list[dict[str, Any]]] = None
    _invoke_n: int = field(default=0, init=False)

    # ── fetch-shaped entrypoint ───────────────────────────────────────────────

    def request(self, method: str, url: str, *, headers: dict[str, str],
                json: Optional[dict[str, Any]] = None) -> FakeResponse:
        self.requests.append({"method": method, "url": url, "headers": headers, "json": json})
        # Host/origin guard (host_forbidden) — the helper must always send loopback.
        if headers.get("host") != GATEWAY_HOST:
            return FakeResponse(403, {"error": {"code": "host_forbidden",
                                                "message": "wrong host header"}})
        path = urlsplit(url).path
        query = parse_qs(urlsplit(url).query)

        if method == "GET" and path == "/.well-known/plexus":
            return self._well_known()
        if method == "POST" and path == "/link/handshake":
            return self._handshake(json or {})
        if method == "PUT" and path == "/grants":
            return self._put_grants(json or {})
        if method == "GET" and path == "/grants/status":
            return self._grant_status(query)
        if method == "POST" and path == "/grants/refresh":
            return self._refresh(json or {})
        if method == "POST" and path == "/invoke":
            return self._invoke(json or {}, headers)
        return FakeResponse(404, {"error": {"code": "unknown_capability",
                                            "message": f"no route {method} {path}"}})

    # ── endpoint impls ────────────────────────────────────────────────────────

    def _well_known(self) -> FakeResponse:
        summaries = [
            {k: c[k] for k in ("id", "source", "kind", "label", "grants", "transport")
             if k in c}
            for c in self.capabilities
        ]
        for s, c in zip(summaries, self.capabilities):
            s["summary"] = c["describe"]
            for k in ("provenance", "sensitivity", "recommendedTrustWindow"):
                if k in c:
                    s[k] = c[k]
        return FakeResponse(200, {
            "gateway": {"name": "plexus", "version": "0.1.0", "protocol": "0.1",
                        "baseUrl": BASE_URL},
            "capabilities": summaries,
            "auth": {
                "handshakeUrl": BASE_URL + "/link/handshake",
                "grantsUrl": BASE_URL + "/grants",
                "refreshUrl": BASE_URL + "/grants/refresh",
                "revokeUrl": BASE_URL + "/grants/revoke",
                "grantStatusUrl": BASE_URL + "/grants/status",
                "invokeUrl": BASE_URL + "/invoke",
                "manifestUrl": BASE_URL + "/manifest",
                "eventsUrl": BASE_URL + "/events",
                # ADMIN/owner path only (how the OWNER receives the connection-key) — NOT an agent
                # affordance. An agent authenticates with its own PAT (see requestShapes.handshake).
                "connectionKeyDelivery": "user-paste",
                "tokenScheme": "plexus-scoped-jwt",
                # Machine-readable request shapes, mirroring the real floor (well-known.ts). The
                # AGENT handshake is the Bearer-PAT path — NO connectionKey body (that shape is the
                # ADMIN/owner path only). ADR-4/ADR-5, protocol 0.1.3.
                "requestShapes": {
                    "handshake": {
                        "url": BASE_URL + "/link/handshake",
                        "method": "POST",
                        "auth": "bearer(pat)",
                        "headers": {"Authorization": "Bearer <your PAT from enrollment (plx_agent_…)>"},
                        "body": {},
                    },
                    "grantRequest": {
                        "url": BASE_URL + "/grants",
                        "method": "PUT",
                        "auth": "header:X-Plexus-Session",
                        "body": {"grants": {"<capabilityId>": "allow"}},
                    },
                    "invoke": {
                        "url": BASE_URL + "/invoke",
                        "method": "POST",
                        "auth": "bearer(scoped-jwt) + header:X-Plexus-Session",
                        "body": {"id": "<capabilityId>", "input": {}},
                    },
                },
            },
        })

    def _handshake(self, body: dict[str, Any]) -> FakeResponse:
        if not body.get("connectionKey"):
            return FakeResponse(401, {"error": {"code": "session_expired",
                                                "message": "no connection key"}})
        return FakeResponse(200, {
            "sessionId": "sess-1",
            "expiresAt": "2099-01-01T00:00:00.000Z",
            "grantsUrl": BASE_URL + "/grants",
            "manifest": {
                "gateway": {"name": "plexus", "version": "0.1.0", "protocol": "0.1",
                            "baseUrl": BASE_URL},
                "entries": self.capabilities,
                "sessionId": "sess-1",
                "expiresAt": "2099-01-01T00:00:00.000Z",
                "revision": 1,
            },
        })

    def _should_pend(self, cap_id: str, decision: Any) -> bool:
        if self.pend_predicate is not None:
            return bool(self.pend_predicate(cap_id, decision))
        entry = next((c for c in self.capabilities if c["id"] == cap_id), None)
        verbs = (decision.get("verbs") if isinstance(decision, dict) else None) \
            or (entry.get("grants") if entry else [])
        return any(v in ("write", "execute") for v in verbs)

    def _mint_token(self, cap_id: str, verbs: list[str]) -> dict[str, Any]:
        self._next_jti += 1
        return {
            "token": f"jwt-{cap_id}-{self._next_jti}",
            "scopes": [{"id": cap_id, "verbs": verbs}],
            "jti": f"jti-{self._next_jti}",
            "expiresAt": "2099-01-01T00:00:00.000Z",
        }

    def _put_grants(self, body: dict[str, Any]) -> FakeResponse:
        grants = body.get("grants", {})
        cap_id = next(iter(grants), None)
        decision = grants.get(cap_id)
        entry = next((c for c in self.capabilities if c["id"] == cap_id), None)
        verbs = (decision.get("verbs") if isinstance(decision, dict) else None) \
            or (entry.get("grants") if entry else ["read"])

        if self._should_pend(cap_id, decision):
            self._next_pending += 1
            pid = f"pending-{self._next_pending}"
            self._pending[pid] = {"cap_id": cap_id, "verbs": verbs, "polls": 0}
            return FakeResponse(200, {
                "status": "grant_pending_user",
                "pendingId": pid,
                "pending": [cap_id],
                "statusUrl": BASE_URL + "/grants/status",
                "pendingNarration": [{
                    "id": cap_id, "verbs": verbs, "provenance": "first-party",
                    "sensitivity": "elevated",
                    "defaultTrustWindow": {"kind": "1d"},
                    "summary": f"Approving lets the agent {'+'.join(verbs)} {cap_id} "
                    f"— revoke anytime in Plexus → Grants.",
                }],
            })
        # Auto-approve read: PUT /grants returns a ScopedToken directly.
        return FakeResponse(200, self._mint_token(cap_id, verbs))

    def _grant_status(self, query: dict[str, list[str]]) -> FakeResponse:
        pid = (query.get("pendingId") or [""])[0]
        rec = self._pending.get(pid)
        if rec is None:
            return FakeResponse(404, {"error": {"code": "grant_required",
                                                "message": "unknown pendingId"}})
        rec["polls"] += 1
        cap_id, verbs = rec["cap_id"], rec["verbs"]
        if self.pending_outcome == "never" or rec["polls"] < self.pending_polls:
            return FakeResponse(200, {"pendingId": pid, "state": "pending",
                                      "capabilities": [cap_id]})
        if self.pending_outcome == "approved":
            return FakeResponse(200, {"pendingId": pid, "state": "approved",
                                      "capabilities": [cap_id],
                                      "token": self._mint_token(cap_id, verbs)})
        # denied / expired
        return FakeResponse(200, {"pendingId": pid, "state": self.pending_outcome,
                                  "capabilities": [cap_id]})

    def _refresh(self, body: dict[str, Any]) -> FakeResponse:
        self._next_jti += 1
        return FakeResponse(200, {
            "token": f"jwt-refreshed-{self._next_jti}",
            "scopes": [],
            "jti": f"jti-{self._next_jti}",
            "expiresAt": "2099-01-01T00:00:00.000Z",
            "grantExpiresAt": "2099-01-01T00:00:00.000Z",
        })

    def _invoke(self, body: dict[str, Any], headers: dict[str, str]) -> FakeResponse:
        cap_id = body.get("id")
        if not headers.get("authorization"):
            return FakeResponse(401, {"id": cap_id, "ok": False, "auditId": "",
                                      "error": {"code": "grant_required",
                                                "message": "no bearer token"}})
        if self.invoke_script is not None:
            step = self.invoke_script[min(self._invoke_n, len(self.invoke_script) - 1)]
            self._invoke_n += 1
            if step.get("error"):
                return FakeResponse(step.get("status", 401), {
                    "id": cap_id, "ok": False, "auditId": step.get("auditId", "a1"),
                    "error": step["error"]})
            return FakeResponse(200, {"id": cap_id, "ok": True,
                                      "output": step.get("output", {"echo": body.get("input")}),
                                      "auditId": "a1"})
        return FakeResponse(200, {"id": cap_id, "ok": True,
                                  "output": {"echo": body.get("input")}, "auditId": "a1"})
