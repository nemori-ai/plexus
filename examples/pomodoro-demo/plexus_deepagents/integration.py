"""
integration — the DeepAgents shim.

The emitted ``SKILL.md`` files teach the model WHICH capability to call and tell it
to call the ``plexus_invoke`` tool. This module builds that tool (bound to a live
``PlexusClient``) so it can be handed to ``create_deep_agent(..., tools=[...])``.

Verified against deepagents 0.6.12 (see README "deepagents API notes"):

  * ``create_deep_agent(model, tools, *, system_prompt, skills, backend, ...)``.
  * ``tools`` accepts plain callables / LangChain ``BaseTool`` objects. We return a
    LangChain ``@tool`` when ``langchain_core`` is importable (deepagents depends on
    it, so it always is in a deepagents install); otherwise we fall back to a plain
    annotated callable, which ``create_deep_agent`` also accepts.
  * ``skills`` is a list of source *directory* paths; each immediate subdir holds a
    ``SKILL.md``. Point it at the directory ``emit_skills`` wrote to, paired with a
    ``FilesystemBackend`` rooted so that path is visible. The README shows the exact
    wiring.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

from .client import PlexusClient, PlexusError, PendingNotice


def plexus_invoke_callable(
    client: PlexusClient,
    *,
    on_pending: Optional[Callable[[PendingNotice], None]] = None,
) -> Callable[..., str]:
    """Build the bare ``plexus_invoke`` function bound to ``client``.

    Signature exposed to the model: ``plexus_invoke(capability_id, input=None,
    purpose=None)``. It runs the FULL Plexus flow (grant → poll-if-pending → invoke)
    and returns a JSON string the model can read. On a clean protocol failure
    (denied / expired / schema error) it returns a JSON ``{"ok": false, "error": ...}``
    rather than raising, so the agent loop can read and react instead of crashing.
    """

    def _default_on_pending(notice: PendingNotice) -> None:
        # Surface the gateway-authored narration so the human running the demo sees
        # the same truthful one-liner, then make clear the helper is blocking.
        print(
            f"\n[plexus] grant for '{notice.capability_id}' is awaiting the machine "
            f"owner's approval in the Plexus UI."
        )
        for summary in notice.summaries:
            print(f"         {summary}")
        print("         Blocking and polling until the owner approves…\n")

    pending_cb = on_pending or _default_on_pending

    def plexus_invoke(
        capability_id: str,
        input: Optional[dict[str, Any]] = None,
        purpose: Optional[str] = None,
    ) -> str:
        """Invoke a Plexus capability through the full resource-side-approval flow.

        Args:
            capability_id: the Plexus capability id (see the SKILL.md, e.g.
                "workspace.read", "workspace.write", "claudecode.run").
            input: the call arguments object (validate against the skill's io.input
                schema). Omit for capabilities that take no input.
            purpose: a short, specific one-line "why now" shown to the owner at the
                approval prompt (transparency only; it changes no decision). ALWAYS
                provide it — state your concrete reason for needing THIS capability right
                now; it especially matters for mutating/execute capabilities.

        Returns a JSON string: ``{"ok": true, "output": ...}`` on success, or
        ``{"ok": false, "error": {"code", "message", "capability_id"}}`` on a clean
        failure. Mutating capabilities PEND for the owner; this call BLOCKS and polls
        until they approve — do not retry, just await the result.
        """
        try:
            output = client.invoke(
                capability_id, input or None,
                purpose=purpose, on_pending=pending_cb,
            )
            return json.dumps({"ok": True, "output": output}, ensure_ascii=False, default=str)
        except PlexusError as exc:
            return json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": exc.code,
                        "message": str(exc),
                        "capability_id": exc.capability_id or capability_id,
                    },
                },
                ensure_ascii=False,
            )

    return plexus_invoke


def make_invoke_tool(
    client: PlexusClient,
    *,
    on_pending: Optional[Callable[[PendingNotice], None]] = None,
) -> Any:
    """Return the ``plexus_invoke`` tool ready for ``create_deep_agent(tools=[...])``.

    Prefers a LangChain ``@tool`` (so deepagents gets a proper ``BaseTool`` with a
    schema-typed signature). Falls back to the plain callable if ``langchain_core``
    is unavailable (deepagents accepts both)."""
    fn = plexus_invoke_callable(client, on_pending=on_pending)
    try:
        from langchain_core.tools import tool as _lc_tool
        return _lc_tool(fn)
    except Exception:
        return fn


def plexus_skills_tools(
    client: PlexusClient,
    *,
    on_pending: Optional[Callable[[PendingNotice], None]] = None,
) -> list[Any]:
    """The DeepAgents-facing tool list for a Plexus-connected agent.

    Today this is exactly ``[plexus_invoke]`` — the single helper the emitted
    SKILL.md files all reference. Kept as a list so additional Plexus helper tools
    (e.g. a future ``plexus_refresh_manifest``) can be added without changing the
    call site. Pair this with ``skills=[<emit_dir>]`` on ``create_deep_agent`` (see
    README); the skills provide the per-capability knowledge, these tools provide the
    callable."""
    return [make_invoke_tool(client, on_pending=on_pending)]


def plexus_catalog_callable(client: PlexusClient) -> Callable[..., str]:
    """Build the ``plexus_catalog`` function — the GENERIC path's discovery affordance.

    On the generic (no-bespoke-skill) path there are no per-capability SKILL.md files;
    the model learns WHICH capabilities exist by reading the **Floor** directly. This tool
    returns the catalog (id + label + describe + grants + io) the client discovered from
    ``.well-known`` / the handshake manifest — the self-describing surface standing in for
    a compiled skill."""

    def plexus_catalog() -> str:
        """List the Plexus capabilities available to this agent (discovered from the Floor).

        Returns a JSON array of ``{id, label, describe, grants, io}`` objects. Read this
        FIRST to see what you can call, then invoke one with ``plexus_invoke`` using its
        ``id`` and an ``input`` matching its ``io.input`` schema."""
        from .enroll import floor_catalog

        return json.dumps(floor_catalog(client), ensure_ascii=False, default=str)

    return plexus_catalog


def plexus_generic_tools(
    client: PlexusClient,
    *,
    on_pending: Optional[Callable[[PendingNotice], None]] = None,
) -> list[Any]:
    """The DeepAgents tool list for a GENERIC (Floor-driven) Plexus agent — no SKILL.md.

    Two tools: ``plexus_catalog`` (discover capabilities from the self-describing Floor)
    and ``plexus_invoke`` (call one, running the full PAT→grant→invoke flow). Together they
    let a skill-less agent integrate from ``.well-known`` alone (Inv II), pairing with a
    client authenticated by the agent's OWN per-agent PAT (see ``enroll.connect_generic``)."""
    catalog = plexus_catalog_callable(client)
    invoke = plexus_invoke_callable(client, on_pending=on_pending)
    try:
        from langchain_core.tools import tool as _lc_tool

        return [_lc_tool(catalog), _lc_tool(invoke)]
    except Exception:
        return [catalog, invoke]
