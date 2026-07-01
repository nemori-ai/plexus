"""
enroll — the GENERIC (no-bespoke-skill) Plexus integration path.

This is the executable proof of **Inv II** (agent-skill-compile-domain-model.md §5):
*any* agent can self-integrate from the **Floor** alone — no per-agent compiled skill.
Where the bespoke path ships a hand-compiled SKILL.md bundle, the generic path reads the
self-describing ``.well-known/plexus`` surface and does everything from there:

    GET /.well-known/plexus        →  auth.enrollment (redeem shape) + requestShapes
    POST auth.enrollment.url {code}→  { pat, agentId }   (the agent's OWN durable PAT)
    store pat in the agent's .env  →  its own paradigm; the one-time code dies on redeem
    POST handshakeUrl (Bearer pat) →  session bound to the PAT's real agentId
    PUT grantsUrl / POST invokeUrl →  calls constructed from the Floor's requestShapes

The security boundary (Inv III): the agent holds ONLY its per-agent PAT + the out-of-band
one-time code. It NEVER sees or uses the admin ``connection-key``. A leaked PAT's blast
radius is exactly this one agent's pre-granted caps, independently revocable.

``connect_generic()`` is the one call the deepagent (or any Python agent) makes: given a
gateway URL and either a fresh one-time code or a previously-stored ``.env``, it returns a
handshaken :class:`PlexusClient` authenticated with the agent's own PAT — ready to
``invoke()`` any standing-granted capability. No SKILL.md, no connection-key.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from .client import PlexusClient, PlexusError, read_env_pat, read_env_agent_id


DEFAULT_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")


def connect_generic(
    base_url: str,
    *,
    code: Optional[str] = None,
    env_path: Optional[str] = None,
    transport: Any = None,
    handshake: bool = True,
    handshake_client: Optional[dict[str, Any]] = None,
) -> PlexusClient:
    """Self-integrate a generic agent and return a PAT-authenticated :class:`PlexusClient`.

    Credential resolution — the agent manages its OWN durable PAT:

      1. If ``env_path`` already holds a ``PLEXUS_AGENT_PAT`` → REUSE it (the one-time code
         is already spent; a durable PAT authenticates every subsequent session).
      2. Else if a one-time ``code`` is supplied → self-enroll from the Floor
         (``client.enroll(code)`` reads ``auth.enrollment`` from ``.well-known``), minting
         and self-storing the PAT to ``env_path``.
      3. Else → error: nothing to authenticate with (no stored PAT, no code).

    Never touches the admin connection-key (Inv III). With ``handshake=True`` (default) it
    also opens the session (Bearer PAT), so the returned client can ``invoke()`` immediately.
    """
    env = os.path.abspath(env_path or DEFAULT_ENV_PATH)
    stored = read_env_pat(env)

    client = PlexusClient(
        base_url,
        transport=transport,
        pat=stored,
        handshake_client=handshake_client,
    )

    if stored is None:
        if not code:
            raise PlexusError(
                f"no stored PAT at {env} and no one-time code supplied — a generic agent "
                "needs either a previously-enrolled PAT (its own paradigm) or a fresh "
                "enrollment code to redeem from the Floor",
                code="session_expired",
            )
        client.enroll(code, persist_path=env)
    else:
        # REUSE path: recover the agentId the stored PAT resolves to (for the caller's own
        # bookkeeping; the session's server-bound agentId remains authoritative).
        client.agent_id = read_env_agent_id(env)

    if handshake:
        client.handshake()
    return client


def floor_catalog(client: PlexusClient) -> list[dict[str, Any]]:
    """The capability catalog the agent discovers from the Floor — NOT a bespoke skill.

    Post-handshake this is the full manifest's callable entries (id + label + describe +
    grants + io); pre-handshake it degrades to the unauth ``.well-known`` summaries. This is
    what replaces per-capability SKILL.md files on the generic path: the model reads the
    self-describing surface directly to know WHICH capability to invoke."""
    entries = client.capabilities()
    if entries:
        return [
            {
                "id": e.get("id"),
                "label": e.get("label"),
                "describe": e.get("describe"),
                "grants": e.get("grants", []),
                "io": e.get("io"),
            }
            for e in entries
        ]
    return [
        {
            "id": s.get("id"),
            "label": s.get("label"),
            "describe": s.get("describe"),
            "grants": s.get("grants", []),
        }
        for s in client.summaries()
    ]
