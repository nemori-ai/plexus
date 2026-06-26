"""
PlexusClient — the agent-side Plexus M0 protocol client (Python port).

Implements the AGENT SIDE of the Plexus wire protocol (v0.1.2):

    DISCOVER → handshake (UNDERSTAND) → grant (GRANTED) → invoke (CALL)

This is the Python sibling of ``examples/min-agent/client.ts`` and the request /
response flow of ``packages/cli/src/plexus-cli.ts`` ``cmdCall``. It speaks ONLY the
published wire contract — it imports no gateway internals.

Security contract (mirrors the TS client / PLEXUS-PROTOCOL.md §5):

  * It ALWAYS sends ``Host: <loopback-authority>`` — the gateway's host/origin guard
    rejects anything else with ``host_forbidden``.
  * It reads every endpoint URL from the ``.well-known`` ``auth`` advertisement
    rather than hard-coding paths (ADR-016), falling back to the canonical path.
  * It presents the connection-key ONLY at handshake; thereafter it holds a
    short-lived ScopedToken and presents it as ``Authorization: Bearer <token>`` on
    invoke (NEVER the connection-key again).

The crown jewel is ``invoke()`` → the FULL resource-side-approval flow that AC2
hinges on: ``PUT /grants`` → if ``grant_pending_user`` POLL ``GET /grants/status``
until terminal → on ``approved`` invoke with the minted Bearer token. The agent can
NOT self-approve; the helper BLOCKS and polls until the machine owner approves in
the Plexus UI.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol, runtime_checkable
from urllib.parse import quote, urlsplit

import httpx

# ── default tuning ────────────────────────────────────────────────────────────

DEFAULT_HANDSHAKE_CLIENT = {
    "name": "plexus-deepagents",
    "version": "0.1.0",
    "agentId": "plexus-deepagents",
}

# Token lifetime is 15 min with a 5-min grace (ADR-011). We refresh proactively
# this many seconds BEFORE expiry so a long-running agent never trips token_expired
# mid-call.
_REFRESH_SKEW_SECONDS = 60

# Resource-side approval can take a human a while — the helper blocks and polls.
DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000   # 10 min — a human approving in the UI.
DEFAULT_POLL_INTERVAL_MS = 1000


# ── typed errors the agent (and the invoke tool) branch on ────────────────────


class PlexusError(Exception):
    """Base for every Plexus protocol-level failure. ``code`` is the closed-union
    ``ErrorCode`` when the gateway supplied one, else a local sentinel."""

    def __init__(self, message: str, *, code: str = "internal_error",
                 capability_id: Optional[str] = None, status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.capability_id = capability_id
        self.status = status


class GrantDenied(PlexusError):
    """The machine owner DENIED the grant in the Plexus UI. Abort cleanly (AC2)."""

    def __init__(self, capability_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"grant denied by the machine owner for {capability_id}",
            code="grant_required", capability_id=capability_id,
        )


class GrantExpired(PlexusError):
    """The pending grant request EXPIRED (owner never decided in time)."""

    def __init__(self, capability_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"grant request expired for {capability_id}",
            code="grant_required", capability_id=capability_id,
        )


class GrantTimeout(PlexusError):
    """Local poll deadline elapsed before the owner approved/denied — still pending."""

    def __init__(self, capability_id: str, waited_ms: int):
        super().__init__(
            f"still pending after {waited_ms}ms — the owner has not yet approved "
            f"{capability_id} in the Plexus UI",
            code="grant_pending_user", capability_id=capability_id,
        )


class InvokeFailed(PlexusError):
    """``/invoke`` returned ``ok:false`` for a reason other than a re-resolvable
    grant/token state — surfaced verbatim with the closed ``ErrorCode``."""


# ── a pending-narration line the caller can relay to the human ────────────────


@dataclass
class PendingNotice:
    """Gateway-authored narration relayed once when a grant DEFERS, so the human
    sees the SAME truthful one-liner every agent relays (ADR-018). Passed to the
    optional ``on_pending`` callback before polling begins."""

    capability_id: str
    pending_ids: list[str]
    status_url: Optional[str]
    # The gateway-authored ``PendingNarration.summary`` lines (capability + verbs +
    # real trust-window + "revoke anytime in Plexus → Grants").
    summaries: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class _HttpTransport(Protocol):
    """The minimal fetch surface ``PlexusClient`` needs. The real impl is httpx;
    tests inject a fake to drive the gateway in-process (no network, no real
    Plexus needed)."""

    def request(self, method: str, url: str, *, headers: dict[str, str],
                json: Optional[dict[str, Any]] = None) -> "_HttpResponse": ...


@runtime_checkable
class _HttpResponse(Protocol):
    status_code: int

    def json(self) -> Any: ...
    @property
    def text(self) -> str: ...


# ── the client ────────────────────────────────────────────────────────────────


class PlexusClient:
    """Drive the Plexus loop against a gateway base URL.

    Typical use::

        client = PlexusClient("http://127.0.0.1:7077", connection_key)
        client.handshake()                       # → full manifest
        client.emit_skills("./plexus_skills")    # compile caps → SKILL.md
        out = client.invoke("workspace.read", {"path": "me.md"})  # full approval flow

    ``discover()`` needs no key (pre-session). ``handshake()`` / ``invoke()`` /
    ``emit_skills()`` need the connection-key (passed to the constructor).
    """

    def __init__(
        self,
        base_url: str,
        connection_key: Optional[str] = None,
        *,
        transport: Optional[_HttpTransport] = None,
        handshake_client: Optional[dict[str, Any]] = None,
        # HTTP timeout (seconds). Generous by default: an `execute` capability like
        # claudecode.run runs a real sandboxed Claude Code build that can take several
        # minutes, and POST /invoke blocks for its whole duration. A short timeout makes
        # the agent give up client-side while the build is still succeeding server-side
        # (observed in the live e2e — the app built fine but the agent's invoke had
        # already ReadTimeout'd at 30s). Override per deployment if you prefer.
        timeout: float = 900.0,
        poll_timeout_ms: int = DEFAULT_POLL_TIMEOUT_MS,
        poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
        sleep: Callable[[float], None] = time.sleep,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.connection_key = connection_key
        self._host_authority = urlsplit(self.base_url).netloc
        # Injected transport (tests) or a real httpx client.
        self._http: _HttpTransport = transport or httpx.Client(timeout=timeout)
        self._owns_http = transport is None
        self._handshake_client = handshake_client or DEFAULT_HANDSHAKE_CLIENT
        self._poll_timeout_ms = poll_timeout_ms
        self._poll_interval_ms = poll_interval_ms
        self._sleep = sleep
        self._now_ms = now_ms

        # Populated by the protocol loop.
        self._well_known: Optional[dict[str, Any]] = None
        self._session_id: Optional[str] = None
        self._manifest: Optional[dict[str, Any]] = None
        # capability_id → cached ScopedToken dict.
        self._tokens: dict[str, dict[str, Any]] = {}

    # ── context-manager sugar ────────────────────────────────────────────────

    def __enter__(self) -> "PlexusClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_http and hasattr(self._http, "close"):
            self._http.close()  # type: ignore[attr-defined]

    # ── low-level request helper ─────────────────────────────────────────────

    def _request(
        self,
        method: str,
        url: str,
        *,
        body: Optional[dict[str, Any]] = None,
        bearer: Optional[str] = None,
        tolerate_error: bool = False,
    ) -> Any:
        """Issue one request, ALWAYS attaching the loopback ``Host`` header. Parses
        JSON; on the uniform ``ErrorResponse`` envelope raises a typed ``PlexusError``
        unless ``tolerate_error`` (so ``/invoke``'s in-band ``ok:false`` body can be
        inspected by the caller)."""
        headers = {"host": self._host_authority, "content-type": "application/json"}
        if bearer:
            headers["authorization"] = f"Bearer {bearer}"
        resp = self._http.request(method, url, headers=headers, json=body)
        text = getattr(resp, "text", "") or ""
        try:
            parsed = resp.json() if text else None
        except Exception:
            raise PlexusError(
                f"non-JSON response ({resp.status_code}): {text[:200]}",
                code="internal_error", status=resp.status_code,
            )
        if not tolerate_error and _is_error_envelope(parsed):
            err = parsed["error"]
            raise PlexusError(
                f"[{err.get('code')}] {err.get('message')}",
                code=err.get("code", "internal_error"),
                capability_id=err.get("capabilityId"),
                status=resp.status_code,
            )
        return parsed

    def _endpoint(self, auth_key: str, fallback_path: str) -> str:
        """Prefer the ``.well-known`` ``auth`` advertisement; else derive the path."""
        advertised = (self._well_known or {}).get("auth", {}).get(auth_key)
        if isinstance(advertised, str) and advertised:
            return advertised
        return self.base_url + fallback_path

    # ── 1. DISCOVER ──────────────────────────────────────────────────────────

    def discover(self) -> dict[str, Any]:
        """``GET /.well-known/plexus`` (UNAUTH) → the gateway identity + a SUMMARY
        capability list + the auth/endpoint advertisement. Caches the doc so later
        calls read endpoint URLs from it. Returns the ``WellKnownDocument``."""
        doc = self._request("GET", self.base_url + "/.well-known/plexus")
        self._well_known = doc
        return doc

    def summaries(self) -> list[dict[str, Any]]:
        """The cached ``.well-known`` capability summaries (call ``discover()`` first)."""
        return list((self._well_known or {}).get("capabilities", []))

    # ── 2. UNDERSTAND (handshake → full manifest) ────────────────────────────

    def handshake(self, connection_key: Optional[str] = None) -> dict[str, Any]:
        """``POST /link/handshake`` — exchange the connection-key for a session + the
        FULL manifest (every entry incl. describe / io / grants / attached skill
        bodies). Auto-``discover()``s first if needed so endpoint URLs resolve.
        Returns the ``HandshakeResponse``."""
        key = connection_key or self.connection_key
        if not key:
            raise PlexusError("handshake() needs a connection-key", code="session_expired")
        if self._well_known is None:
            self.discover()
        body = {"connectionKey": key, "client": self._handshake_client}
        res = self._request("POST", self._endpoint("handshakeUrl", "/link/handshake"), body=body)
        self._session_id = res["sessionId"]
        self._manifest = res["manifest"]
        return res

    def entries(self) -> list[dict[str, Any]]:
        """Full entries from the last handshake / manifest refresh."""
        return list((self._manifest or {}).get("entries", []))

    def entry(self, capability_id: str) -> Optional[dict[str, Any]]:
        """Look up a full manifest entry by id."""
        for e in self.entries():
            if e.get("id") == capability_id:
                return e
        return None

    def capabilities(self) -> list[dict[str, Any]]:
        """Just the ``kind:"capability"`` + ``kind:"workflow"`` entries (the callable
        ones) — the entries ``emit_skills`` compiles to SKILL.md. Pure ``kind:"skill"``
        usage entries are read-as-context, not callable, so they are excluded here."""
        return [e for e in self.entries() if e.get("kind") in ("capability", "workflow")]

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    # ── 3. GRANTED (request_grant → ScopedToken, with the polling loop) ──────

    def request_grant(
        self,
        capability_id: str,
        *,
        verbs: Optional[list[str]] = None,
        purpose: Optional[str] = None,
        trust_window: Optional[dict[str, Any]] = None,
        on_pending: Optional[Callable[[PendingNotice], None]] = None,
        poll_timeout_ms: Optional[int] = None,
        poll_interval_ms: Optional[int] = None,
    ) -> dict[str, Any]:
        """``PUT /grants`` for ``capability_id`` → a minted ScopedToken.

        THE RESOURCE-SIDE-APPROVAL STATE MACHINE (AC2). If the gateway's authorizer
        DEFERS (response ``status == "grant_pending_user"``), relay the gateway-
        authored narration via ``on_pending`` then POLL ``GET /grants/status`` until
        ``state != "pending"``:
          * ``approved`` → return the minted ``token`` (a ScopedToken dict).
          * ``denied``   → raise ``GrantDenied`` (abort cleanly).
          * ``expired``  → raise ``GrantExpired``.
          * still pending past the local deadline → raise ``GrantTimeout``.

        The agent CANNOT self-approve. It blocks here until the owner acts.
        """
        if not self._session_id:
            raise PlexusError("request_grant() before handshake()", code="session_expired")

        decision: dict[str, Any] = {"decision": "allow"}
        if verbs:
            decision["verbs"] = verbs
        if purpose:
            decision["purpose"] = purpose
        if trust_window:
            decision["trustWindow"] = trust_window
        # A bare "allow" is the read-only default; carry the dict form whenever we
        # have verbs/purpose/window to declare.
        grant_value: Any = decision if (verbs or purpose or trust_window) else "allow"

        body = {"sessionId": self._session_id, "grants": {capability_id: grant_value}}
        res = self._request("PUT", self._endpoint("grantsUrl", "/grants"), body=body)

        if _is_grant_pending(res):
            notice = _pending_notice(capability_id, res)
            if on_pending:
                on_pending(notice)
            token = self._await_pending(
                capability_id, res,
                poll_timeout_ms=poll_timeout_ms, poll_interval_ms=poll_interval_ms,
            )
        else:
            # PUT /grants returned a ScopedToken directly (auto-approve path).
            token = res
        self._tokens[capability_id] = token
        return token

    def _await_pending(
        self,
        capability_id: str,
        pending: dict[str, Any],
        *,
        poll_timeout_ms: Optional[int],
        poll_interval_ms: Optional[int],
    ) -> dict[str, Any]:
        """POLL ``GET /grants/status?pendingId=<id>`` until terminal. The owner
        approving/denying in the Plexus UI is what flips ``state``."""
        timeout_ms = poll_timeout_ms if poll_timeout_ms is not None else self._poll_timeout_ms
        interval_ms = poll_interval_ms if poll_interval_ms is not None else self._poll_interval_ms
        status_base = pending.get("statusUrl") or self._endpoint("grantStatusUrl", "/grants/status")
        pending_id = pending["pendingId"]
        deadline = self._now_ms() + timeout_ms

        while True:
            url = f"{status_base}?pendingId={quote(pending_id)}"
            status = self._request("GET", url)
            state = status.get("state")
            if state == "approved" and status.get("token"):
                return status["token"]
            if state == "denied":
                raise GrantDenied(capability_id)
            if state == "expired":
                raise GrantExpired(capability_id)
            # state == "pending" (or an unexpected non-terminal value): keep polling.
            if self._now_ms() > deadline:
                raise GrantTimeout(capability_id, timeout_ms)
            self._sleep(interval_ms / 1000.0)

    # ── 4. CALL (invoke — the full flow) ─────────────────────────────────────

    def invoke(
        self,
        capability_id: str,
        input: Optional[dict[str, Any]] = None,
        *,
        verbs: Optional[list[str]] = None,
        purpose: Optional[str] = None,
        trust_window: Optional[dict[str, Any]] = None,
        on_pending: Optional[Callable[[PendingNotice], None]] = None,
        poll_timeout_ms: Optional[int] = None,
        poll_interval_ms: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """Call a capability, performing the FULL resource-side-approval flow and
        returning the structured ``output``.

        Steps (mirrors ``plexus call`` / GOAL.md §3):
          1. Ensure a handshake + a covering grant for this id (``request_grant``,
             which BLOCKS + polls on ``grant_pending_user``).
          2. ``POST /invoke`` with ``Authorization: Bearer <token>``.
          3. On ``ok:false`` map the closed ``ErrorCode`` to recovery:
               * ``grant_pending_user`` (an invoke that itself defers) → poll for the
                 SAME pending decision, then retry the invoke.
               * ``token_expired``      → ``POST /grants/refresh`` (15-min tokens,
                 5-min grace) and retry once.
               * ``grant_required`` / ``token_revoked`` → re-request the grant once
                 (re-pends for the owner) and retry once.
               * anything else → raise ``InvokeFailed`` with the verbatim error.

        Returns ``InvokeResponse.output`` on success.
        """
        if not self._session_id:
            self.handshake()

        token = self._ensure_token(
            capability_id, verbs=verbs, purpose=purpose, trust_window=trust_window,
            on_pending=on_pending, poll_timeout_ms=poll_timeout_ms,
            poll_interval_ms=poll_interval_ms,
        )

        res = self._do_invoke(capability_id, input, token, idempotency_key)

        if res.get("ok"):
            return res.get("output")

        # ── ok:false → branch on the closed ErrorCode ──────────────────────────
        err = res.get("error") or {}
        code = err.get("code", "internal_error")

        if code == "grant_pending_user":
            # An invoke that DEFERS rather than PUT /grants doing so. Poll the SAME
            # pending decision (statusUrl/pendingId ride in error.detail), then retry.
            detail = err.get("detail") or {}
            pending = {
                "pendingId": detail.get("pendingId") or err.get("pendingId"),
                "statusUrl": detail.get("statusUrl"),
            }
            if not pending["pendingId"]:
                raise InvokeFailed(
                    f"[grant_pending_user] {err.get('message', '')} (no pendingId to poll)",
                    code=code, capability_id=capability_id,
                )
            if on_pending:
                on_pending(_pending_notice(capability_id, {**pending, "pending": [capability_id]}))
            token = self._await_pending(
                capability_id, pending,
                poll_timeout_ms=poll_timeout_ms, poll_interval_ms=poll_interval_ms,
            )
            self._tokens[capability_id] = token
            res = self._do_invoke(capability_id, input, token, idempotency_key)

        elif code == "token_expired":
            token = self._refresh(token)
            self._tokens[capability_id] = token
            res = self._do_invoke(capability_id, input, token, idempotency_key)

        elif code in ("grant_required", "token_revoked"):
            # Lost the scope (revoked, or never covered) — re-request once. This
            # re-PENDS for the owner; the agent still cannot self-grant.
            self._tokens.pop(capability_id, None)
            token = self._ensure_token(
                capability_id, verbs=verbs, purpose=purpose, trust_window=trust_window,
                on_pending=on_pending, poll_timeout_ms=poll_timeout_ms,
                poll_interval_ms=poll_interval_ms,
            )
            res = self._do_invoke(capability_id, input, token, idempotency_key)

        if res.get("ok"):
            return res.get("output")
        err = res.get("error") or {}
        raise InvokeFailed(
            f"[{err.get('code', 'internal_error')}] {err.get('message', 'invoke failed')}",
            code=err.get("code", "internal_error"), capability_id=capability_id,
        )

    def _do_invoke(
        self, capability_id: str, input: Optional[dict[str, Any]],
        token: dict[str, Any], idempotency_key: Optional[str],
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"id": capability_id}
        if input:
            body["input"] = input
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        # tolerate_error: /invoke's denial body is InvokeResponse-shaped (ok:false +
        # error), NOT the uniform ErrorResponse envelope — we inspect ok/error here.
        return self._request(
            "POST", self._endpoint("invokeUrl", "/invoke"),
            body=body, bearer=token.get("token"), tolerate_error=True,
        )

    def _ensure_token(self, capability_id: str, **grant_kwargs: Any) -> dict[str, Any]:
        """Return a still-valid cached token for ``capability_id``, else request one
        (which BLOCKS + polls on a pending grant)."""
        cached = self._tokens.get(capability_id)
        if cached and not self._token_near_expiry(cached):
            return cached
        if cached and self._token_near_expiry(cached):
            # Try a cheap refresh before a full (re-pending) re-grant.
            try:
                refreshed = self._refresh(cached)
                self._tokens[capability_id] = refreshed
                return refreshed
            except PlexusError:
                pass  # fall through to a fresh grant.
        return self.request_grant(capability_id, **grant_kwargs)

    def _refresh(self, token: dict[str, Any]) -> dict[str, Any]:
        """``POST /grants/refresh`` — re-mint a fresh 15-min token from the persisted
        grant (no connection-key, no re-prompt). Honors the 5-min grace window."""
        if not self._session_id:
            raise PlexusError("refresh before handshake", code="session_expired")
        body = {"sessionId": self._session_id, "jti": token.get("jti")}
        res = self._request(
            "POST", self._endpoint("refreshUrl", "/grants/refresh"),
            body=body, bearer=token.get("token"),
        )
        return {
            "token": res["token"],
            "scopes": res.get("scopes", token.get("scopes", [])),
            "jti": res["jti"],
            "expiresAt": res["expiresAt"],
            "grantExpiresAt": res.get("grantExpiresAt"),
        }

    def _token_near_expiry(self, token: dict[str, Any]) -> bool:
        exp = token.get("expiresAt")
        if not isinstance(exp, str):
            return False
        exp_ms = _iso_to_ms(exp)
        if exp_ms is None:
            return False
        return self._now_ms() >= exp_ms - _REFRESH_SKEW_SECONDS * 1000

    # ── 5. EMIT SKILLS (the "compile" step) ──────────────────────────────────

    def emit_skills(self, out_dir: str) -> list[str]:
        """For EACH discovered capability write one ``SKILL.md`` under ``out_dir``.
        Handshakes first if needed. Delegates to :func:`emit.emit_skills`. Returns the
        list of written SKILL.md paths."""
        from .emit import emit_skills as _emit
        if self._manifest is None:
            self.handshake()
        return _emit(self.capabilities(), out_dir, base_url=self.base_url)


# ── module-level wire helpers ─────────────────────────────────────────────────


def _is_error_envelope(x: Any) -> bool:
    return (
        isinstance(x, dict)
        and "error" in x
        and isinstance(x["error"], dict)
        and isinstance(x["error"].get("code"), str)
    )


def _is_grant_pending(r: Any) -> bool:
    return isinstance(r, dict) and r.get("status") == "grant_pending_user"


def _pending_notice(capability_id: str, res: dict[str, Any]) -> PendingNotice:
    narration = res.get("pendingNarration") or []
    mine = [n for n in narration if n.get("id") == capability_id]
    items = mine or narration
    return PendingNotice(
        capability_id=capability_id,
        pending_ids=res.get("pending", [capability_id]),
        status_url=res.get("statusUrl"),
        summaries=[n.get("summary", "") for n in items if n.get("summary")],
        raw=res,
    )


def _iso_to_ms(iso: str) -> Optional[int]:
    """Parse an ISO-8601 UTC timestamp to epoch ms. Returns None if unparseable."""
    try:
        from datetime import datetime, timezone
        s = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None
