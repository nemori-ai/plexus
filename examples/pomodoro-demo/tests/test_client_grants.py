"""
Unit tests for the grant-pending POLLING STATE MACHINE — AC2 (resource-side
approval) hinges on this. Driven against the FAKE gateway (no running Plexus).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from plexus_deepagents import (  # noqa: E402
    PlexusClient, GrantDenied, GrantExpired, GrantTimeout, InvokeFailed,
)
from plexus_deepagents.client import PendingNotice  # noqa: E402
from tests.fake_gateway import FakeGateway, BASE_URL  # noqa: E402


def _client(gw, **kw):
    # sleep is a no-op + a manual clock so timeout tests are deterministic.
    return PlexusClient(BASE_URL, "conn-key", transport=gw, sleep=lambda s: None, **kw)


def test_discover_handshake_lists_capabilities():
    gw = FakeGateway()
    c = _client(gw)
    wk = c.discover()
    assert wk["gateway"]["name"] == "plexus"
    c.handshake()
    ids = {e["id"] for e in c.capabilities()}
    # capability + workflow entries only; the kind:"skill" entry is excluded.
    assert "workspace.read" in ids and "workspace.write" in ids
    assert "workspace.write.how-to-use" not in ids


def test_read_auto_approves_no_polling():
    gw = FakeGateway()
    c = _client(gw)
    out = c.invoke("workspace.read", {"path": "me.md"})
    assert out == {"echo": {"path": "me.md"}}
    # No /grants/status poll happened for an auto-approved read.
    assert not any("/grants/status" in r["url"] for r in gw.requests)


def test_write_pends_then_approves_after_polling():
    # The owner approves on the 3rd status poll → the call proceeds.
    gw = FakeGateway(pending_polls=3, pending_outcome="approved")
    notices: list[PendingNotice] = []
    c = _client(gw)
    out = c.invoke("workspace.write", {"path": "PRD.html", "content": "<html>"},
                   on_pending=notices.append)
    assert out == {"echo": {"path": "PRD.html", "content": "<html>"}}
    # We polled until approved (>=3 status calls), and relayed the gateway narration.
    polls = [r for r in gw.requests if "/grants/status" in r["url"]]
    assert len(polls) >= 3
    assert len(notices) == 1
    assert notices[0].capability_id == "workspace.write"
    assert any("revoke anytime" in s for s in notices[0].summaries)
    # The invoke carried a Bearer token (the minted scoped-token).
    inv = [r for r in gw.requests if r["url"].endswith("/invoke")][-1]
    assert inv["headers"]["authorization"].startswith("Bearer ")


def test_write_denied_aborts_cleanly():
    gw = FakeGateway(pending_polls=1, pending_outcome="denied")
    c = _client(gw)
    with pytest.raises(GrantDenied) as ei:
        c.invoke("workspace.write", {"path": "x", "content": "y"})
    assert ei.value.capability_id == "workspace.write"
    # No invoke was attempted after a denial.
    assert not any(r["url"].endswith("/invoke") for r in gw.requests)


def test_write_expired_raises():
    gw = FakeGateway(pending_polls=1, pending_outcome="expired")
    c = _client(gw)
    with pytest.raises(GrantExpired):
        c.invoke("claudecode.run", {"prompt": "build it"})


def test_poll_timeout_when_owner_never_decides():
    # Never resolves; a manual clock drives the deadline so the test is instant.
    gw = FakeGateway(pending_outcome="never")
    clock = {"t": 0}

    def now_ms():
        clock["t"] += 400  # each call advances 400ms.
        return clock["t"]

    c = _client(gw, poll_timeout_ms=1000, poll_interval_ms=200, now_ms=now_ms)
    with pytest.raises(GrantTimeout):
        c.invoke("workspace.write", {"path": "x", "content": "y"})


def test_invoke_returns_grant_pending_then_polls_to_approved():
    # An /invoke that itself returns ok:false / grant_pending_user → poll → retry.
    gw = FakeGateway()
    gw.invoke_script = [
        {"error": {"code": "grant_pending_user", "message": "pends",
                   "detail": {"pendingId": "p-inline", "statusUrl": BASE_URL + "/grants/status"}}},
        {"output": {"done": True}},
    ]
    # Pre-seed the inline pending id so /grants/status resolves it to approved.
    gw._pending["p-inline"] = {"cap_id": "workspace.read", "verbs": ["read"], "polls": 0}
    gw.pending_polls = 1
    c = _client(gw)
    out = c.invoke("workspace.read", {"path": "me.md"})
    assert out == {"done": True}
    assert any("/grants/status" in r["url"] for r in gw.requests)


def test_token_expired_refreshes_and_retries():
    gw = FakeGateway()
    gw.invoke_script = [
        {"error": {"code": "token_expired", "message": "expired"}},
        {"output": {"ok": 1}},
    ]
    c = _client(gw)
    out = c.invoke("workspace.read", {"path": "me.md"})
    assert out == {"ok": 1}
    assert any(r["url"].endswith("/grants/refresh") for r in gw.requests)


def test_non_recoverable_invoke_error_raises():
    gw = FakeGateway()
    gw.invoke_script = [
        {"error": {"code": "schema_validation_failed", "message": "bad input"}, "status": 422},
    ]
    c = _client(gw)
    with pytest.raises(InvokeFailed) as ei:
        c.invoke("workspace.read", {"bad": True})
    assert ei.value.code == "schema_validation_failed"


def test_host_guard_is_always_loopback():
    gw = FakeGateway()
    c = _client(gw)
    c.invoke("workspace.read", {"path": "me.md"})
    assert all(r["headers"]["host"] == "127.0.0.1:7077" for r in gw.requests)
    # connection-key is presented ONLY at handshake, never again.
    non_handshake = [r for r in gw.requests if not r["url"].endswith("/link/handshake")]
    assert all((r["json"] or {}).get("connectionKey") is None for r in non_handshake)
