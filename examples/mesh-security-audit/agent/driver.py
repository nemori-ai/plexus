#!/usr/bin/env python3
"""
driver.py — the SHARED, address-agnostic cloud-agent driver for the Plexus 1.0-RC
"mesh security audit" flagship example.

This is the **calling side** (GOAL.md). Like the pomodoro-demo agent it reaches the
machine ONLY through Plexus capabilities — no shell, no direct filesystem, no network
of its own. Unlike pomodoro (an LLM-driven DeepAgent), this driver runs ONE FIXED
FLOW deterministically, so the same story is reproducible with zero model cost:

    (a) SCAN a Linux box   — read its resources snapshot + process list + the tail of
        its security/access log, via the `sysinfo.*` READ capabilities.
    (b) ANALYZE            — hand that log to `codex.run` (cwd = the analysis dir),
        asking for a Linux security access-log analysis. `execute` PENDS every call.
    (c) WRITE THE VERDICT  — write the conclusion as a markdown note into the Obsidian
        vault via the vault WRITE capability (`*.vault.write` / `workspace.write`).
        `write` PENDS.

ADDRESS-AGNOSTIC BY DESIGN. The driver never hard-codes a capability id. It DISCOVERS
what it can call from the handshake manifest, then MATCHES each leg by *id suffix*:

    sysinfo.log.read        matches  "sysinfo.log.read"  AND  "local/linux/sysinfo.log.read"
    codex.run               matches  "codex.run"         AND  "local/mac/codex.run"
    vault write             matches  "workspace.write" | "obsidian-rest.vault.write" | …

So the SAME driver runs whether caps are LOCAL bare ids (local topology: the Mac IS the
primary, codex+workspace are local; only sysinfo is mesh-mounted) or fully mesh-mounted
`local/<workload>/…` (cloud topology: everything dials a Fly/CF parent). It talks ONLY
to the parent it enrolled against — never to a child directly.

AUTH (reused from pomodoro-demo, Inv III): the agent holds ONLY its own per-agent PAT +
a one-time enrollment code. It NEVER sees the admin connection-key. First run redeems
`PLEXUS_ENROLL_CODE` (`plx_enroll_…`) → a durable `plx_agent_…` PAT stored in `.env`;
later runs reuse the stored PAT. The whole protocol engine (enroll → handshake →
grant-pending-poll → invoke, with the resource-side-approval state machine) is reused
verbatim from `plexus_deepagents.PlexusClient` — this driver adds only the flow.

Usage:
    python driver.py --run      # the full scan → analyze → write flow
    python driver.py --probe    # one capability call, to prove revoke fails closed
                                 # (used by scripts/revoke.sh)

Env:
    PLEXUS_BASE_URL             parent gateway base url (default http://127.0.0.1:7077)
    PLEXUS_ENROLL_CODE          one-time enroll code (plx_enroll_…), FIRST run only
    PLEXUS_AUDIT_AGENT_ID       the agentId the runner connected (default mesh-security-audit)
    PLEXUS_SYSINFO_LOG_FILE     log file (relative to the proxy's log root) to analyze
                                (default auth.log)
    PLEXUS_ANALYSIS_CWD         in-jail cwd handed to codex.run (default ".")
    PLEXUS_NOTE_PATH            vault-relative path of the conclusion note
                                (default Security/linux-access-log-analysis.md)
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from typing import Any, Optional

# ── reuse the REAL protocol client from pomodoro-demo (the Python wire engine) ────
# Prefer an installed package; else add the sibling pomodoro-demo dir to the path so
# `plexus_deepagents` (PlexusClient + connect_generic + the pending-poll loop) imports.
HERE = os.path.dirname(os.path.abspath(__file__))
_POMODORO = os.path.normpath(os.path.join(HERE, "..", "..", "pomodoro-demo"))
try:
    import plexus_deepagents  # noqa: F401
except ImportError:
    if _POMODORO not in sys.path:
        sys.path.insert(0, _POMODORO)

from plexus_deepagents import connect_generic, read_env_pat  # noqa: E402
import plexus_deepagents.client as _pc  # noqa: E402
from plexus_deepagents.client import (  # noqa: E402
    PlexusClient,
    PlexusError,
    PendingNotice,
)


# ── compatibility shim: attach X-Plexus-Session on grant-status polls (P6-STATUS-AUTH) ─
# The reused pomodoro-demo PlexusClient predates the gateway's P6-STATUS-AUTH guard: the
# current gateway makes a pending grant's `GET /grants/status` readable ONLY by the
# ORIGINATING session (its `X-Plexus-Session` header) or the management key. The stock
# client polls without that header → `session_expired`. We overlay a version of
# `_await_pending` that attaches the session header — WITHOUT editing the shared client
# (this patch lives in our process only; pomodoro-demo's files are untouched).
def _await_pending_with_session(self, capability_id, pending, *, poll_timeout_ms, poll_interval_ms):  # type: ignore[no-untyped-def]
    from urllib.parse import quote

    timeout_ms = poll_timeout_ms if poll_timeout_ms is not None else self._poll_timeout_ms
    interval_ms = poll_interval_ms if poll_interval_ms is not None else self._poll_interval_ms
    status_url = pending.get("statusUrl")
    pending_id = pending["pendingId"]
    if status_url and "pendingId=" in status_url:
        url = status_url
    else:
        base = status_url or self._endpoint("grantStatusUrl", "/grants/status")
        url = f"{base}?pendingId={quote(pending_id)}"
    deadline = self._now_ms() + timeout_ms
    headers = {
        "host": self._host_authority,
        "content-type": "application/json",
        "x-plexus-session": self._session_id or "",
    }
    while True:
        resp = self._http.request("GET", url, headers=headers, json=None)
        text = getattr(resp, "text", "") or ""
        status = resp.json() if text else {}
        if _pc._is_error_envelope(status):
            err = status["error"]
            raise PlexusError(f"[{err.get('code')}] {err.get('message')}", code=err.get("code", "internal_error"))
        state = status.get("state")
        if state == "approved" and status.get("token"):
            return status["token"]
        if state == "denied":
            raise _pc.GrantDenied(capability_id)
        if state == "expired":
            raise _pc.GrantExpired(capability_id)
        if self._now_ms() > deadline:
            raise _pc.GrantTimeout(capability_id, timeout_ms)
        self._sleep(interval_ms / 1000.0)


PlexusClient._await_pending = _await_pending_with_session  # type: ignore[method-assign]

# ── configuration ────────────────────────────────────────────────────────────────

DEFAULT_BASE_URL = os.environ.get("PLEXUS_BASE_URL", "http://127.0.0.1:7077")
AGENT_ID = os.environ.get("PLEXUS_AUDIT_AGENT_ID", "mesh-security-audit")
ENV_PATH = os.path.join(HERE, ".env")

SYSINFO_LOG_FILE = os.environ.get("PLEXUS_SYSINFO_LOG_FILE", "auth.log")
ANALYSIS_CWD = os.environ.get("PLEXUS_ANALYSIS_CWD", ".")
NOTE_PATH = os.environ.get("PLEXUS_NOTE_PATH", "Security/linux-access-log-analysis.md")

# A tiny bundled access-log excerpt used ONLY when the sysinfo leg is not discoverable
# (no Linux proxy attached yet — the mesh leg is deferred to the full E2E). Keeps the
# analyze+write legs demonstrable standalone. When sysinfo IS present, the REAL tail is
# read over the mesh and this is never used.
_SAMPLE_ACCESS_LOG = """\
Feb 10 03:12:41 web01 sshd[2211]: Failed password for invalid user admin from 203.0.113.7 port 51022 ssh2
Feb 10 03:12:43 web01 sshd[2213]: Failed password for invalid user admin from 203.0.113.7 port 51044 ssh2
Feb 10 03:12:45 web01 sshd[2215]: Failed password for root from 203.0.113.7 port 51070 ssh2
Feb 10 03:12:59 web01 sshd[2231]: Failed password for invalid user oracle from 198.51.100.23 port 41210 ssh2
Feb 10 03:13:20 web01 sshd[2250]: Accepted password for deploy from 10.0.0.5 port 33044 ssh2
Feb 10 03:41:07 web01 sudo:   deploy : TTY=pts/0 ; PWD=/srv ; USER=root ; COMMAND=/usr/bin/apt-get install netcat
"""


# ── narration ──────────────────────────────────────────────────────────────────

def banner(title: str) -> None:
    print("\n" + "=" * 74)
    print(f"  {title}")
    print("=" * 74)


def say(msg: str) -> None:
    print(f"[audit] {msg}")


def on_pending(notice: PendingNotice) -> None:
    """Console narrator for a grant-pending pause (resource-side approval). The agent
    is BLOCKED and polling — it CANNOT self-approve; a human approves in the Plexus UI."""
    print(
        f"\n[audit] ⏳ GRANT PENDING — '{notice.capability_id}' needs the machine "
        f"owner's approval in the Plexus UI."
    )
    for summary in notice.summaries:
        print(f"[audit]    {summary}")
    print(
        "[audit]    The agent is BLOCKED and polling. It cannot self-approve — "
        "waiting for the owner to click Approve…\n"
    )


# ── address-agnostic discovery: match a leg by capability-id SUFFIX ──────────────

def resolve(caps: list[dict[str, Any]], *suffixes: str) -> Optional[str]:
    """Return the FIRST discovered capability id that ends with any of ``suffixes``.

    This is the whole address-agnostic trick: `sysinfo.log.read` matches a LOCAL bare
    id `sysinfo.log.read` AND a mesh-mounted `local/linux/sysinfo.log.read`; a `.vault.write`
    suffix matches `obsidian-rest.vault.write`, `obsidian.vault.write`, and a bare
    `workspace.write` (via its own suffix). Ids are compared on their trailing segment so
    the driver is oblivious to WHERE the capability physically lives.

    PREFERENCE: when both a mesh-mounted (namespaced, contains "/") id AND a bare local id
    end with the same suffix, PREFER the mesh-mounted one — so a capability that also
    happens to load locally on the primary (e.g. macOS loads its own portable `sysinfo`)
    still resolves to the REMOTE proxy's mount, executing + auditing there. Bare-only caps
    (codex/workspace in the local topology) fall back to the bare id unchanged."""
    def _matches(cid: str, suffix: str) -> bool:
        # Match on a SEGMENT boundary ONLY: the exact id, or the suffix preceded by "." (a
        # dotted local id) or "/" (a mesh-mounted address prefix). A boundaryless
        # `endswith(suffix)` would let a spoof cap like `local/x/evilcodex.run` masquerade as
        # `codex.run` and be selected for the analyze/write legs — so it is deliberately gone.
        return cid == suffix or cid.endswith("/" + suffix) or cid.endswith("." + suffix)

    # Pass 1: prefer a mesh-mounted (namespaced) id.
    for suffix in suffixes:
        for cap in caps:
            cid = cap.get("id") or ""
            if "/" in cid and _matches(cid, suffix):
                return cid
    # Pass 2: any match (bare local id, or dotted-suffix id).
    for cap in caps:
        cid = cap.get("id") or ""
        for suffix in suffixes:
            if _matches(cid, suffix):
                return cid
    return None


def summarize_output(out: Any, limit: int = 800) -> str:
    text = json.dumps(out, ensure_ascii=False, indent=2) if not isinstance(out, str) else out
    return text if len(text) <= limit else text[:limit] + f"\n… (+{len(text) - limit} chars truncated)"


# ── the flow ─────────────────────────────────────────────────────────────────────

def leg_scan(client: PlexusClient, caps: list[dict[str, Any]]) -> dict[str, Any]:
    """(a) SCAN — read the Linux box's resources + processes + the security/access log
    tail via the `sysinfo.*` READ capabilities (auto-approve; standing grants OK).

    If the sysinfo caps are NOT discovered (no Linux proxy attached — the mesh leg is
    deferred to the full E2E), degrade to a small bundled sample so the analyze+write
    legs still run, and SAY SO loudly."""
    resources_id = resolve(caps, "sysinfo.resources.read")
    processes_id = resolve(caps, "sysinfo.processes.list")
    log_id = resolve(caps, "sysinfo.log.read")

    if not log_id:
        say(
            "⚠ sysinfo.* NOT discovered — the Linux proxy is not attached (mesh leg "
            "DEFERRED to the full E2E). Using a bundled sample access-log so the "
            "analyze+write legs still run."
        )
        return {
            "host": "(sample — no sysinfo proxy)",
            "resources": None,
            "processes": None,
            "log_file": "(bundled sample)",
            "log_text": _SAMPLE_ACCESS_LOG,
            "real": False,
        }

    say(f"scanning the Linux box through the mesh (sysinfo resolved at: {log_id})…")
    resources = None
    processes = None
    if resources_id:
        resources = client.invoke(resources_id, {}, purpose="read the server's cpu/mem/disk snapshot before analyzing its log", on_pending=on_pending)
        say(f"    • {resources_id} → cpu/mem/disk snapshot read")
    if processes_id:
        processes = client.invoke(processes_id, {"top": 15}, purpose="list the busiest processes on the server", on_pending=on_pending)
        say(f"    • {processes_id} → {(processes or {}).get('count', '?')} processes")

    log = client.invoke(
        log_id,
        {"file": SYSINFO_LOG_FILE, "lines": 400},
        purpose=f"read the tail of {SYSINFO_LOG_FILE} to analyze the server's access/auth activity",
        on_pending=on_pending,
    )
    say(f"    • {log_id} → {(log or {}).get('lines', '?')} lines of {SYSINFO_LOG_FILE}")
    return {
        "host": "(mesh linux proxy)",
        "resources": resources,
        "processes": processes,
        "log_file": (log or {}).get("file", SYSINFO_LOG_FILE),
        "log_text": (log or {}).get("content", ""),
        "real": True,
    }


ANALYSIS_PROMPT_TEMPLATE = """\
You are a Linux security analyst. Below is the tail of a server's security/access log \
({log_file}). Analyze it for a SECURITY ACCESS-LOG review:

1. Identify authentication anomalies — brute-force / credential-stuffing patterns, \
invalid-user probes, repeated failures from a single source IP, and any successful \
login that followed a burst of failures.
2. Call out privilege-escalation or suspicious post-login activity (sudo to root, \
package installs of dual-use tools, etc.).
3. List the source IPs of concern and the accounts they targeted.
4. Give a short RISK verdict (low / medium / high) with 2–4 concrete remediation steps \
(e.g. fail2ban, disable password auth, restrict the account).

Write the analysis as clean Markdown with a "## Findings" and a "## Verdict" section. \
Do not invent log lines that are not present.

--- BEGIN LOG ({log_file}) ---
{log_text}
--- END LOG ---
"""


def leg_analyze(client: PlexusClient, caps: list[dict[str, Any]], scan: dict[str, Any]) -> dict[str, Any]:
    """(b) ANALYZE — hand the log to `codex.run` (cwd = the analysis dir). `execute`
    PENDS every call → the human approves in the UI; the driver blocks and polls."""
    codex_id = resolve(caps, "codex.run")
    if not codex_id:
        raise SystemExit(
            "[audit] FATAL: no codex.run capability discovered — the analysis engine is "
            "required. Grant `codex.run` (execute) to this agent and re-run."
        )
    prompt = ANALYSIS_PROMPT_TEMPLATE.format(
        log_file=scan["log_file"], log_text=scan["log_text"].strip()
    )
    say(f"handing the log to {codex_id} for a Linux security access-log analysis (execute → PENDS)…")
    out = client.invoke(
        codex_id,
        {"prompt": prompt, "cwd": ANALYSIS_CWD},
        purpose="run a Linux security access-log analysis on the scanned server's auth log",
        trust_window={"kind": "once"},  # execute already pends-each-call; make it explicit + config-robust
        on_pending=on_pending,
    )
    launched = bool((out or {}).get("launched"))
    if launched:
        say("    • codex.run executed a REAL sandboxed analysis (Tier L).")
    else:
        say(
            "    • codex.run returned in RECORD-MODE (Tier H, no spawn) — predicted "
            "sandbox-exec argv + confinement (set PLEXUS_CODEX_HEADLESS_LAUNCH=1 for a real run)."
        )
    return out or {}


def build_note(scan: dict[str, Any], codex_out: dict[str, Any]) -> str:
    """Assemble the conclusion markdown note. On a REAL codex run this embeds Codex's
    analysis (`output`); in record-mode it embeds the recorded invocation + the raw log,
    so the note is always a materialized artifact."""
    now = _dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    launched = bool(codex_out.get("launched"))
    analysis = codex_out.get("output") if launched else None

    lines = [
        "# Linux security access-log analysis",
        "",
        f"- Generated: {now}",
        f"- Source host: {scan['host']}",
        f"- Log analyzed: `{scan['log_file']}`",
        f"- Analysis engine: `codex.run` ({'live spawn' if launched else 'record-mode / Tier H'})",
        "",
    ]
    if scan.get("resources"):
        cpu = (scan["resources"] or {}).get("cpu", {})
        mem = (scan["resources"] or {}).get("memory", {})
        lines += [
            "## Server snapshot",
            "",
            f"- CPU load-per-core: {cpu.get('loadPerCore', 'n/a')} (cores: {cpu.get('cores', 'n/a')})",
            f"- Memory used: {mem.get('usedPct', 'n/a')}%",
            "",
        ]
    if analysis:
        lines += ["## Analysis (Codex)", "", str(analysis), ""]
    else:
        lines += [
            "## Analysis",
            "",
            "> Record-mode run (Tier H): Codex was invoked under the macOS seatbelt jail but "
            "not spawned (no model cost). The invocation record below proves the execute path "
            "(dir-jail + pends-each-call + local audit). For a real analysis, run the Mac child "
            "with `PLEXUS_CODEX_HEADLESS_LAUNCH=1` and a logged-in `codex`.",
            "",
            "```json",
            summarize_output({k: codex_out.get(k) for k in ("ok", "launched", "sandboxed", "jail", "reason")}),
            "```",
            "",
            "## Log analyzed (raw tail)",
            "",
            "```",
            scan["log_text"].strip(),
            "```",
            "",
        ]
    lines += ["---", "", "_Written by the Plexus mesh-security-audit agent via the vault write capability._"]
    return "\n".join(lines)


def leg_write(client: PlexusClient, caps: list[dict[str, Any]], note: str) -> str:
    """(c) WRITE — write the conclusion note into the Obsidian vault via the WRITE
    capability. Prefers a real Obsidian REST write (`*.vault.write`) if present, else
    the hermetic `workspace.write`. `write` PENDS → human approves."""
    write_id = resolve(caps, "obsidian-rest.vault.write", "vault.write", "workspace.write")
    if not write_id:
        raise SystemExit(
            "[audit] FATAL: no vault WRITE capability discovered "
            "(obsidian-rest.vault.write | workspace.write). Grant one and re-run."
        )
    say(f"writing the conclusion note via {write_id} → {NOTE_PATH} (write → PENDS)…")
    # trust_window=once is LOAD-BEARING: a first-party WRITE otherwise defaults to a 1d
    # STANDING window, so only the FIRST write would pend and later writes within the day
    # would ride the standing grant — silently breaking the story's "a mutating write PENDS
    # on EVERY call" invariant. Requesting `once` makes each write a genuine per-use decision.
    out = client.invoke(
        write_id,
        {"path": NOTE_PATH, "content": note},
        purpose=f"write the security access-log analysis conclusion to {NOTE_PATH} in the vault",
        trust_window={"kind": "once"},
        on_pending=on_pending,
    )
    say(f"    • {write_id} → note written")
    return write_id


# ── entrypoints ──────────────────────────────────────────────────────────────────

def _connect() -> PlexusClient:
    """Enroll (reuse stored PAT, else redeem PLEXUS_ENROLL_CODE) + handshake with the
    agent's OWN PAT. Never touches the admin connection-key."""
    has_code = bool(os.environ.get("PLEXUS_ENROLL_CODE"))
    has_pat = read_env_pat(ENV_PATH) is not None
    if not has_code and not has_pat:
        raise SystemExit(
            "[audit] ERROR: no credential. Set PLEXUS_ENROLL_CODE to the one-time code "
            "printed by scripts/grant-setup.sh (first run), or reuse the PAT stored in "
            f"{ENV_PATH} (later runs)."
        )
    client = connect_generic(
        DEFAULT_BASE_URL,
        code=os.environ.get("PLEXUS_ENROLL_CODE"),
        env_path=ENV_PATH,
        handshake=True,
    )
    say(f"handshook with Plexus (Bearer PAT, agentId={client.agent_id}); session={client.session_id}")
    return client


def do_run() -> int:
    banner("MESH SECURITY AUDIT — scan Linux → Codex analyze → write vault note")
    say(f"parent gateway: {DEFAULT_BASE_URL}")
    client = _connect()

    caps = client.capabilities()
    say("discovered capabilities from the parent (address-agnostic — matched by suffix):")
    for cap in caps:
        say(f"    • {cap.get('id')}  ({'+'.join(cap.get('grants', [])) or 'read'})")

    scan = leg_scan(client, caps)
    codex_out = leg_analyze(client, caps, scan)
    note = build_note(scan, codex_out)
    write_id = leg_write(client, caps, note)

    banner("DONE")
    say(f"conclusion note written via {write_id} at vault path: {NOTE_PATH}")
    say("per-host audit now carries: sysinfo reads on the Linux proxy; codex.run + the "
        "vault write on the primary. Run scripts/show-audit.sh to see the split.")
    return 0


def do_probe() -> int:
    """One capability call, to PROVE revoke fails closed. After the agent is revoked its
    PAT is tombstoned → handshake / the next invoke fails closed (`token_revoked` /
    handshake fail). Used by scripts/revoke.sh AFTER the revoke."""
    banner("REVOKE PROBE — attempt one capability call; expect it to FAIL CLOSED")
    # A revoke proof REQUIRES a previously-valid stored PAT: revoke tombstones it SERVER-side
    # but leaves the local .env, so the genuine proof is "the stored PAT is now REJECTED." With
    # NO stored PAT there is nothing to disprove — treating that as "fail-closed" is a FALSE
    # PASS (it only proves the agent never enrolled). Fail loudly (inconclusive) instead.
    if read_env_pat(ENV_PATH) is None:
        print(
            f"[audit] ⚠ INCONCLUSIVE: no stored PAT at {ENV_PATH} — nothing to test. A revoke "
            "proof needs a PAT that was valid BEFORE the revoke. Run `--run` (enroll) → "
            "revoke → `--probe`."
        )
        return 2
    try:
        client = _connect()
    except PlexusError as e:
        # The handshake itself rejected the (now-tombstoned) PAT — the strongest proof.
        print(f"[audit] ✓ FAIL-CLOSED at handshake: {e}")
        return 0
    try:
        caps = client.capabilities()
        # Try any read cap (sysinfo if present, else workspace read/list).
        probe_id = resolve(caps, "sysinfo.resources.read", "sysinfo.log.read", "workspace.list", "workspace.read")
        if not probe_id:
            say("no read capability discovered to probe — handshake itself succeeded (NOT revoked).")
            return 1
        say(f"probing {probe_id} …")
        out = client.invoke(probe_id, {} if probe_id.endswith("resources.read") else {"path": ""}, on_pending=on_pending, poll_timeout_ms=3000)
        print(f"[audit] ✗ call SUCCEEDED — the agent is NOT revoked (got: {summarize_output(out, 200)})")
        return 1
    except PlexusError as e:
        print(f"[audit] ✓ FAIL-CLOSED: [{e.code}] {e}")
        return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Plexus mesh-security-audit cloud-agent driver.")
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--run", action="store_true", help="run the full scan → analyze → write flow")
    g.add_argument("--probe", action="store_true", help="one call to prove revoke fails closed")
    args = parser.parse_args(argv)
    if args.run:
        return do_run()
    if args.probe:
        return do_probe()
    return 1


if __name__ == "__main__":
    sys.exit(main())
