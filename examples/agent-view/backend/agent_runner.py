"""
agent_runner.py — drive the deepagent loop and translate it into the AgentEvent stream.

This is the LIVE-mode runner. It reuses the existing pomodoro-demo protocol client
and deepagent construction (``examples/pomodoro-demo``: ``plexus_deepagents`` +
``agent.py``) and translates deepagent / Plexus activity into the SSE event contract
defined in :mod:`events`.

The translation is isolated behind a tiny push API — :class:`EventStream` — so LIVE
and DEMO modes share the exact same "emit layer": both just call ``stream.emit(ev)``
and the server serializes whatever comes out with :func:`events.to_sse`.

What live mode hooks
--------------------
* ``session.start`` / ``session.end`` — around the whole run.
* ``capabilities.discovered`` — built from the manifest entries the client returns
  *after handshake* (``client.capabilities()``), one :class:`events.CapabilityCard`
  each.
* ``agent.state`` — phase transitions (discovering → thinking → invoking →
  awaiting_grant → idle/done) inferred from the deepagent stream + the invoke
  lifecycle.
* ``assistant.delta`` / ``assistant.message`` — streamed from the LangGraph agent
  via ``agent.stream(..., stream_mode=["messages","updates"])``.
* The FULL Plexus invoke lifecycle — ``tool.call.start`` → (``grant_pending`` →
  ``grant_resolved``) → ``tool.call.delta``* → ``tool.call.result`` + ``audit.event``
  — by wrapping the ``plexus_invoke`` tool so it emits around ``client.invoke``:
    - ``tool.call.start`` before the invoke (id + input + provenance/sensitivity/source
      pulled from the manifest entry),
    - ``tool.call.grant_pending`` from the client's ``on_pending`` callback (the
      gateway-authored summary + verbs) and ``agent.state: awaiting_grant``,
    - ``tool.call.grant_resolved: approved`` once the invoke proceeds (or ``denied``
      on a clean ``grant_required`` failure),
    - ``tool.call.delta`` chunks if the structured output carries stdout-like text,
    - ``tool.call.result`` (ok / output / auditId) + a matching ``audit.event``.

Because ``client.invoke`` is BLOCKING (it polls the gateway during the human-approval
window), the whole agent loop runs on a worker thread and pushes events onto a
thread-safe queue; the server-side generator drains that queue in order.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from typing import Any, Callable, Iterator, Optional

from events import (
    AgentEvent,
    AgentState,
    AssistantDelta,
    AssistantMessage,
    AuditEvent,
    CapabilitiesDiscovered,
    CapabilityCard,
    ErrorEvent,
    MemoryItem,
    MemoryUpdate,
    SessionEnd,
    SessionStart,
    ToolCallDelta,
    ToolCallGrantPending,
    ToolCallGrantResolved,
    ToolCallResult,
    ToolCallStart,
    new_id,
    now_iso,
)

# Make the pomodoro-demo package importable (the protocol client + deepagent live
# there; we REUSE them rather than reinventing the protocol).
_POMODORO = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pomodoro-demo")
)
if _POMODORO not in sys.path:
    sys.path.insert(0, _POMODORO)


# ── the shared emit layer ─────────────────────────────────────────────────────


_SENTINEL = object()


class EventStream:
    """A thread-safe push channel of AgentEvents.

    The producer (a deepagent worker thread, or a demo replay loop) calls
    :meth:`emit`; the consumer (the server's SSE generator) iterates the stream.
    Iteration ends when the producer calls :meth:`close`."""

    def __init__(self) -> None:
        self._q: "queue.Queue[Any]" = queue.Queue()

    def emit(self, event: AgentEvent) -> None:
        self._q.put(event)

    def close(self) -> None:
        self._q.put(_SENTINEL)

    def __iter__(self) -> Iterator[AgentEvent]:
        while True:
            item = self._q.get()
            if item is _SENTINEL:
                return
            yield item


# ── manifest entry → CapabilityCard ───────────────────────────────────────────


def _provenance_of(entry: dict[str, Any]) -> str:
    return str(entry.get("provenance") or "extension")


def _sensitivity_of(entry: dict[str, Any]) -> str:
    sens = entry.get("sensitivity")
    if sens:
        return str(sens)
    grants = entry.get("grants") or []
    if "execute" in grants:
        return "elevated"
    if "write" in grants:
        return "standard"
    return "low"


def capability_card(entry: dict[str, Any]) -> CapabilityCard:
    """Project a manifest ``CapabilityEntry`` onto the contract's CapabilityCard."""
    cap_id = str(entry.get("id", ""))
    return CapabilityCard(
        id=cap_id,
        label=str(entry.get("label") or cap_id),
        source=str(entry.get("source") or cap_id.split(".")[0]),
        provenance=_provenance_of(entry),
        sensitivity=_sensitivity_of(entry),
        grants=list(entry.get("grants") or []),
        describe=entry.get("describe"),
    )


# ── live invoke wrapper (the lifecycle hook) ──────────────────────────────────


def _stdout_text(output: Any) -> Optional[str]:
    """Best-effort extraction of stdout-like text from a structured invoke output,
    so we can replay it as ``tool.call.delta`` chunks."""
    if isinstance(output, str):
        return output
    if isinstance(output, dict):
        for key in ("stdout", "output", "log", "text", "result"):
            val = output.get(key)
            if isinstance(val, str) and val.strip():
                return val
    return None


def make_emitting_invoke_tool(client: Any, stream: EventStream) -> Any:
    """Build a ``plexus_invoke`` tool (the single tool the emitted SKILL.md files
    reference) that EMITS the full Plexus invoke lifecycle onto ``stream`` while
    delegating the real work to ``client.invoke``.

    This is the live-mode counterpart of ``plexus_deepagents.integration``'s
    ``plexus_invoke_callable`` — same signature exposed to the model, but wrapped so
    the UI sees start → (pending → resolved) → delta* → result."""
    from plexus_deepagents import PlexusError
    from plexus_deepagents.client import PendingNotice

    def plexus_invoke(
        capability_id: str,
        input: Optional[dict[str, Any]] = None,
        purpose: Optional[str] = None,
    ) -> str:
        """Invoke a Plexus capability through the full resource-side-approval flow.

        Args:
            capability_id: the Plexus capability id (see the SKILL.md).
            input: the call arguments object (validate against io.input). Omit if none.
            purpose: optional free-text "why now" shown to the owner at approval.

        Returns a JSON string ``{"ok": true|false, ...}`` — mutating/execute caps PEND
        for the owner; this BLOCKS and polls until they decide. Do not retry; await it.
        """
        call_id = new_id("call")
        entry = client.entry(capability_id) or {}
        card = capability_card({**entry, "id": capability_id})

        stream.emit(
            ToolCallStart(
                callId=call_id,
                capabilityId=capability_id,
                label=card.label,
                input=input or {},
                provenance=card.provenance,
                sensitivity=card.sensitivity,
                source=card.source,
            )
        )
        stream.emit(AgentState(phase="invoking", note=f"Invoking {capability_id}"))

        pended = {"flag": False}

        def on_pending(notice: PendingNotice) -> None:
            pended["flag"] = True
            pending_id = (notice.pending_ids or [capability_id])[0]
            summary = " ".join(notice.summaries) or (
                f"{capability_id} requires the machine owner's approval in Plexus."
            )
            verbs = list(entry.get("grants") or [])
            stream.emit(
                ToolCallGrantPending(
                    callId=call_id,
                    pendingId=str(pending_id),
                    summary=summary,
                    verbs=verbs,
                )
            )
            stream.emit(
                AgentState(
                    phase="awaiting_grant",
                    note=f"Awaiting owner approval for {capability_id}",
                )
            )

        audit_id = new_id("audit")
        try:
            output = client.invoke(
                capability_id, input or None, purpose=purpose, on_pending=on_pending
            )
            # If we pended, the fact we got here means the owner approved.
            if pended["flag"]:
                stream.emit(ToolCallGrantResolved(callId=call_id, decision="approved"))
                stream.emit(AgentState(phase="invoking", note=f"Approved — running {capability_id}"))

            text = _stdout_text(output)
            if text:
                for chunk in _chunk_text(text):
                    stream.emit(ToolCallDelta(callId=call_id, chunk=chunk))

            stream.emit(
                ToolCallResult(
                    callId=call_id, ok=True, output=output, auditId=audit_id
                )
            )
            stream.emit(
                AuditEvent(
                    id=audit_id,
                    capabilityId=capability_id,
                    outcome="allowed",
                    at=now_iso(),
                )
            )
            return json.dumps({"ok": True, "output": output}, ensure_ascii=False, default=str)
        except PlexusError as exc:
            # A clean protocol failure. If the owner denied, reflect grant_resolved.
            if exc.code in ("grant_required", "token_revoked") and pended["flag"]:
                stream.emit(ToolCallGrantResolved(callId=call_id, decision="denied"))
            stream.emit(
                ToolCallResult(
                    callId=call_id, ok=False, error=str(exc), auditId=audit_id
                )
            )
            stream.emit(
                AuditEvent(
                    id=audit_id,
                    capabilityId=capability_id,
                    outcome="denied",
                    at=now_iso(),
                )
            )
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

    # Wrap as a LangChain tool when available (deepagents wants a BaseTool); else the
    # plain callable, which create_deep_agent also accepts.
    try:
        from langchain_core.tools import tool as _lc_tool

        return _lc_tool(plexus_invoke)
    except Exception:
        return plexus_invoke


def _chunk_text(text: str, size: int = 200) -> list[str]:
    """Split a blob into modest chunks so the UI animates streamed stdout."""
    return [text[i : i + size] for i in range(0, len(text), size)] or [text]


def _resolve_live_model() -> Any:
    """Resolve the agent's brain for live mode.

    Mirrors ``agent.build_agent``'s key-agnostic model resolution: when
    ``OPENROUTER_API_KEY`` is set, construct an explicit ``ChatOpenAI`` model OBJECT
    pointed at OpenRouter (a bare model STRING would route to the Anthropic/OpenAI
    direct provider and need that provider's own key). Otherwise return the model
    STRING, which ``create_deep_agent`` resolves via the default provider path."""
    from agent import PLEXUS_DEMO_MODEL

    if os.environ.get("OPENROUTER_API_KEY"):
        from langchain_openai import ChatOpenAI

        or_model = os.environ.get("PLEXUS_DEMO_MODEL", "anthropic/claude-sonnet-4.6")
        print(f"[agent_runner] using OpenRouter model '{or_model}' (via ChatOpenAI)")
        return ChatOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ["OPENROUTER_API_KEY"],
            model=or_model,
        )
    return os.environ.get("PLEXUS_DEMO_MODEL", PLEXUS_DEMO_MODEL)


# ── live runner ────────────────────────────────────────────────────────────────


def run_live(message: str, stream: EventStream, *, recursion_limit: int = 80) -> None:
    """Run ONE live agent turn for ``message``, emitting AgentEvents onto ``stream``.

    Blocking; intended to run on a worker thread (the client.invoke calls block during
    the human-approval window). Always ``close()``s the stream when done."""
    try:
        # Reuse the pomodoro-demo construction (client + deepagent), but swap in our
        # emitting invoke tool so the UI sees the full lifecycle.
        from agent import SYSTEM_PROMPT, build_client, PLEXUS_DEMO_MODEL, DEFAULT_AGENT_ROOT, SKILLS_SUBDIR

        client = build_client()

        stream.emit(AgentState(phase="discovering", note="Connecting to Plexus…"))
        client.handshake()

        stream.emit(
            SessionStart(
                sessionId=client.session_id or new_id("sess"),
                agentName="Plexus Agent",
                model=os.environ.get("PLEXUS_DEMO_MODEL", PLEXUS_DEMO_MODEL),
                ts=now_iso(),
            )
        )

        entries = client.capabilities()
        stream.emit(
            CapabilitiesDiscovered(
                capabilities=[capability_card(e) for e in entries]
            )
        )

        # Compile capabilities → SKILL.md and build the agent (mirrors agent.build_agent,
        # but injecting the emitting invoke tool).
        from deepagents import create_deep_agent
        from deepagents.backends import FilesystemBackend

        root = os.path.abspath(DEFAULT_AGENT_ROOT)
        os.makedirs(root, exist_ok=True)
        skills_dir = os.path.join(root, SKILLS_SUBDIR)
        client.emit_skills(skills_dir)

        invoke_tool = make_emitting_invoke_tool(client, stream)
        # Inject the real current date/time + timezone — the LLM has no clock and will
        # otherwise GUESS "today" (it hallucinated 2026-07-14). Mirrors agent.build_agent.
        import datetime as _dt

        _now = _dt.datetime.now().astimezone()
        _now_ctx = (
            f"CURRENT DATE & TIME: {_now.strftime('%Y-%m-%d %H:%M')} "
            f"{_now.strftime('%Z')} (UTC{_now.strftime('%z')}), {_now.strftime('%A')}.\n"
            'When the user says "today", "tomorrow", "this week", etc., compute the date '
            "window from THIS instant, in the user's LOCAL timezone above. Calendar results "
            "come back in UTC (ISO 'Z') — convert them to the local timezone when you "
            "present times.\n\n"
        )
        agent = create_deep_agent(
            model=_resolve_live_model(),
            tools=[invoke_tool],
            system_prompt=_now_ctx + SYSTEM_PROMPT,
            skills=[f"/{SKILLS_SUBDIR}"],
            backend=FilesystemBackend(root_dir=root, virtual_mode=True),
        )

        stream.emit(AgentState(phase="thinking", note="Planning…"))
        _stream_agent(agent, message, stream, recursion_limit=recursion_limit)

        stream.emit(AgentState(phase="idle"))
        stream.emit(SessionEnd(reason="completed"))
    except Exception as exc:  # noqa: BLE001 — surface any failure as an error event.
        traceback.print_exc()
        stream.emit(ErrorEvent(message=f"{type(exc).__name__}: {exc}"))
        stream.emit(SessionEnd(reason="error"))
    finally:
        stream.close()


def _stream_agent(
    agent: Any, message: str, stream: EventStream, *, recursion_limit: int
) -> None:
    """Drive ``agent.stream`` and translate LangGraph chunks → assistant events.

    Uses combined ``stream_mode`` so we get token deltas (``messages``) AND completed
    node updates (``updates``). The Plexus invoke lifecycle is emitted separately by
    the wrapped tool (which runs inline on this same thread)."""
    seen_message_ids: set[str] = set()
    inputs = {"messages": [{"role": "user", "content": message}]}
    config = {"recursion_limit": recursion_limit}

    try:
        iterator = agent.stream(
            inputs, config, stream_mode=["messages", "updates"]
        )
    except TypeError:
        # Older signature: no list stream_mode — fall back to updates only.
        iterator = agent.stream(inputs, config, stream_mode="updates")

    for chunk in iterator:
        mode, payload = _split_chunk(chunk)
        if mode == "messages":
            _emit_token_delta(payload, stream)
        elif mode == "updates":
            _emit_completed_messages(payload, stream, seen_message_ids)


def _split_chunk(chunk: Any) -> tuple[str, Any]:
    """LangGraph yields ``(mode, payload)`` for multi-mode streams, or a bare payload
    for single-mode. Normalize to ``(mode, payload)``."""
    if isinstance(chunk, tuple) and len(chunk) == 2 and isinstance(chunk[0], str):
        return chunk[0], chunk[1]
    return "updates", chunk


def _emit_token_delta(payload: Any, stream: EventStream) -> None:
    """``messages`` mode yields ``(message_chunk, metadata)``; emit assistant.delta
    for assistant token chunks (skip tool messages)."""
    msg = payload[0] if isinstance(payload, tuple) else payload
    text = _message_text(msg)
    if not text:
        return
    if _message_role(msg) in ("ai", "assistant"):
        stream.emit(AssistantDelta(text=text))


def _emit_completed_messages(
    payload: Any, stream: EventStream, seen: set[str]
) -> None:
    """``updates`` mode yields ``{node: {messages: [...]}}``; emit assistant.message
    for each newly-completed assistant turn that carries real text."""
    if not isinstance(payload, dict):
        return
    for node_update in payload.values():
        if not isinstance(node_update, dict):
            continue
        for msg in node_update.get("messages", []) or []:
            if _message_role(msg) not in ("ai", "assistant"):
                continue
            mid = _message_id(msg)
            if mid in seen:
                continue
            seen.add(mid)
            text = _message_text(msg)
            if text and text.strip():
                stream.emit(AssistantMessage(id=mid or new_id("msg"), text=text))


# ── tiny message-shape adapters (work for LangChain objects OR plain dicts) ───


def _message_role(msg: Any) -> str:
    t = getattr(msg, "type", None)
    if t:
        return str(t)
    if isinstance(msg, dict):
        return str(msg.get("type") or msg.get("role") or "")
    return ""


def _message_id(msg: Any) -> str:
    mid = getattr(msg, "id", None)
    if mid:
        return str(mid)
    if isinstance(msg, dict):
        return str(msg.get("id") or "")
    return ""


def _message_text(msg: Any) -> str:
    content = getattr(msg, "content", None)
    if content is None and isinstance(msg, dict):
        content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Anthropic-style content blocks: join text parts.
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def iter_live_events(message: str, *, recursion_limit: int = 80) -> Iterator[AgentEvent]:
    """Public entrypoint for the server: yield the live AgentEvent stream for one turn.

    Runs the (blocking) agent loop on a worker thread and drains the event queue in
    order, so the SSE response streams as the agent acts."""
    stream = EventStream()
    worker = threading.Thread(
        target=run_live, args=(message, stream), kwargs={"recursion_limit": recursion_limit}, daemon=True
    )
    worker.start()
    yield from stream
    worker.join(timeout=1.0)
