"""
events.py — the server-side mirror of the Agent View EVENT CONTRACT.

This is the Python sibling of ``web/src/contract.ts``. Every ``AgentEvent`` the
backend streams over SSE is one of the dataclasses below. The field names MUST
match the TS contract **exactly** (camelCase: ``sessionId``, ``callId``,
``capabilityId``, ``auditId`` …) — a sibling agent's frontend is built against
these shapes, so this file is a CONTRACT, not an implementation detail.

The wire framing is Server-Sent Events: each event is serialized by
:func:`to_sse` as a single ``data: <json>\\n\\n`` frame, where ``<json>`` is one
AgentEvent object discriminated on its ``type`` field.

``to_sse`` accepts EITHER a dataclass instance (live mode builds these) OR a
plain ``dict`` (demo mode replays recorded dicts). In both cases keys whose value
is ``None`` are dropped, so an unset optional (``note?``, ``output?``, ``error?``,
``describe?``, ``kind?``, ``reason?``) serializes as *absent* — matching the TS
``?:`` optional semantics — rather than as an explicit ``null``.
"""

from __future__ import annotations

import dataclasses
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Optional, Union


# ── small helpers (deterministic ids/timestamps overridable for replay) ───────


def now_iso() -> str:
    """An ISO-8601 UTC timestamp with a trailing ``Z`` (matches the TS contract)."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def new_id(prefix: str = "id") -> str:
    """A short unique id, e.g. ``call_3f9a1c`` for a ``callId``."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


# ── nested record shapes (mirror the TS interfaces) ───────────────────────────


@dataclass
class CapabilityCard:
    """One discovered capability, grouped in the UI by ``source`` / ``provenance``.

    Mirrors ``interface CapabilityCard`` — built from a manifest ``CapabilityEntry``
    after handshake (id/label/source/provenance/sensitivity/grants/describe)."""

    id: str
    label: str
    source: str
    provenance: str
    sensitivity: str
    grants: list[str]
    describe: Optional[str] = None


@dataclass
class MemoryItem:
    """An agent memory/state item rendered in the AgentState panel.

    Mirrors ``interface MemoryItem`` — ``key`` / ``value`` plus an optional ``kind``."""

    key: str
    value: str
    kind: Optional[str] = None


# ── the AgentEvent union (discriminated on ``type``) ──────────────────────────
#
# One dataclass per arm of the TS ``type AgentEvent = …`` union. Each carries the
# literal ``type`` discriminator as its first field so ``to_sse`` emits it verbatim.


@dataclass
class SessionStart:
    sessionId: str
    agentName: str
    model: str
    ts: str
    type: Literal["session.start"] = "session.start"


@dataclass
class AgentState:
    # phase ∈ discovering | thinking | awaiting_grant | invoking | idle | done
    phase: Literal[
        "discovering", "thinking", "awaiting_grant", "invoking", "idle", "done"
    ]
    note: Optional[str] = None
    type: Literal["agent.state"] = "agent.state"


@dataclass
class AssistantDelta:
    """A streaming assistant token chunk."""

    text: str
    type: Literal["assistant.delta"] = "assistant.delta"


@dataclass
class AssistantMessage:
    """A completed assistant turn (markdown)."""

    id: str
    text: str
    type: Literal["assistant.message"] = "assistant.message"


@dataclass
class CapabilitiesDiscovered:
    capabilities: list[CapabilityCard]
    type: Literal["capabilities.discovered"] = "capabilities.discovered"


@dataclass
class ToolCallStart:
    """A Plexus invoke begins — the ToolCallCard's first frame."""

    callId: str
    capabilityId: str
    label: str
    input: Any
    provenance: str
    sensitivity: str
    source: str
    type: Literal["tool.call.start"] = "tool.call.start"


@dataclass
class ToolCallGrantPending:
    """The grant DEFERRED — the human must approve in Plexus; the card WAITS."""

    callId: str
    pendingId: str
    summary: str
    verbs: list[str]
    type: Literal["tool.call.grant_pending"] = "tool.call.grant_pending"


@dataclass
class ToolCallGrantResolved:
    callId: str
    decision: Literal["approved", "denied"]
    type: Literal["tool.call.grant_resolved"] = "tool.call.grant_resolved"


@dataclass
class ToolCallDelta:
    """Streamed invoke output (e.g. CC / Codex stdout)."""

    callId: str
    chunk: str
    type: Literal["tool.call.delta"] = "tool.call.delta"


@dataclass
class ToolCallResult:
    callId: str
    ok: bool
    auditId: str
    output: Any = None
    error: Optional[str] = None
    type: Literal["tool.call.result"] = "tool.call.result"


@dataclass
class OrchestrationBoard:
    """A cc-master/v1 board JSON snapshot — drives the DAG view."""

    board: Any
    type: Literal["orchestration.board"] = "orchestration.board"


@dataclass
class MemoryUpdate:
    items: list[MemoryItem]
    type: Literal["memory.update"] = "memory.update"


@dataclass
class AuditEvent:
    id: str
    capabilityId: str
    outcome: str
    at: str
    type: Literal["audit.event"] = "audit.event"


@dataclass
class SessionEnd:
    reason: Optional[str] = None
    type: Literal["session.end"] = "session.end"


@dataclass
class ErrorEvent:
    message: str
    type: Literal["error"] = "error"


AgentEvent = Union[
    SessionStart,
    AgentState,
    AssistantDelta,
    AssistantMessage,
    CapabilitiesDiscovered,
    ToolCallStart,
    ToolCallGrantPending,
    ToolCallGrantResolved,
    ToolCallDelta,
    ToolCallResult,
    OrchestrationBoard,
    MemoryUpdate,
    AuditEvent,
    SessionEnd,
    ErrorEvent,
]


# ── serialization ─────────────────────────────────────────────────────────────


def _drop_none(obj: Any) -> Any:
    """Recursively drop ``None``-valued keys so unset optionals serialize as absent
    (matching the TS ``?:`` optional fields) rather than as explicit ``null``."""
    if isinstance(obj, dict):
        return {k: _drop_none(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [_drop_none(v) for v in obj]
    return obj


def to_dict(event: Any) -> dict[str, Any]:
    """Normalize an AgentEvent (dataclass instance OR plain dict) to a wire dict."""
    if dataclasses.is_dataclass(event) and not isinstance(event, type):
        raw = dataclasses.asdict(event)
    elif isinstance(event, dict):
        raw = event
    else:
        raise TypeError(f"not an AgentEvent: {type(event)!r}")
    return _drop_none(raw)


def to_sse(event: Any) -> str:
    """Serialize one AgentEvent to an SSE frame: ``data: <json>\\n\\n``."""
    payload = json.dumps(to_dict(event), ensure_ascii=False, separators=(",", ":"))
    return f"data: {payload}\n\n"
