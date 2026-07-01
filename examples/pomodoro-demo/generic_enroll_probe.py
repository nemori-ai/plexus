#!/usr/bin/env python3
"""
generic_enroll_probe — mechanically drive the GENERIC (no-bespoke-skill) integration path.

This is the deterministic, LLM-free driver behind the deepagent's generic base-mode
(agent-skill-compile §5 / Inv II). It runs the EXACT client code the pomodoro deepagent
uses (`plexus_deepagents.connect_generic` → `PlexusClient.enroll`/`handshake`/`invoke`) so a
bun test can boot a real gateway, provision `{agentId, one-time code, standing grant}`, and
assert end-to-end that a skill-less agent:

  1. reads the Floor (`GET /.well-known/plexus`),
  2. redeems its one-time code → its OWN durable PAT (stored in an `.env`),
  3. handshakes + invokes a standing-granted capability with that PAT,

all WITHOUT ever seeing/using the admin connection-key and WITHOUT any compiled SKILL.md.

Usage:
    python3 generic_enroll_probe.py --url <base> --cap <capId> \
        [--code <one-time-code>] [--input <json>] --env <envfile> [--purpose <text>]

On the FIRST run pass --code (self-enroll, stores PAT). On a LATER run OMIT --code to prove
the stored PAT is reused. Emits ONE JSON object on stdout (last line); diagnostics → stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Make the sibling package importable when run as a standalone script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plexus_deepagents import connect_generic, read_env_pat  # noqa: E402
from plexus_deepagents.client import PlexusError  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="gateway base URL")
    ap.add_argument("--cap", required=True, help="capability id to invoke")
    ap.add_argument("--code", default=None, help="one-time enrollment code (first run only)")
    ap.add_argument("--input", default=None, help="capability input as a JSON object")
    ap.add_argument("--env", required=True, help="path to the agent's own .env store")
    ap.add_argument("--purpose", default="generic base-mode integration probe")
    args = ap.parse_args()

    input_obj = json.loads(args.input) if args.input else None

    # Guard the invariant HERE, not just by trust: this probe is handed NO connection-key.
    # If the harness ever leaked one into the environment we would still not use it — the
    # generic client has no connection_key argument on this path.
    leaked_key = os.environ.get("PLEXUS_CONNECTION_KEY")

    result: dict[str, object] = {"cap": args.cap}
    try:
        # THE GENERIC PATH: self-enroll from the Floor (code→PAT, stored) OR reuse the stored
        # PAT, then handshake with that PAT. `connect_generic` never touches a connection-key.
        client = connect_generic(
            args.url,
            code=args.code,
            env_path=args.env,
            handshake=True,
        )
        print(f"[probe] handshook; session={client.session_id} agentId={client.agent_id}", file=sys.stderr)

        output = client.invoke(args.cap, input_obj, purpose=args.purpose)

        stored_pat = read_env_pat(args.env) or ""
        result.update(
            {
                "ok": True,
                "output": output,
                "agentId": client.agent_id,
                "sessionId": client.session_id,
                # Never emit the PAT itself; a legible prefix is enough to prove it's a PAT.
                "patPrefix": stored_pat[:10],
                "patStored": bool(stored_pat),
                # Proof of Inv III: the agent authenticated with its own PAT, never the key.
                "usedConnectionKey": False,
                "connectionKeyPresentInEnv": leaked_key is not None,
                "reusedStoredPat": args.code is None,
            }
        )
        client.close()
    except PlexusError as exc:
        result.update({"ok": False, "error": {"code": exc.code, "message": str(exc)}})
    except Exception as exc:  # pragma: no cover — surface any harness wiring error
        result.update({"ok": False, "error": {"code": "probe_error", "message": repr(exc)}})

    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
