"""
demo_mode.py — deterministic replay of a recorded AgentEvent[] scenario.

Powers the demo and the e2e: it replays ``recordings/<scenario>.json`` (an array of
AgentEvent objects authored to the contract) with small, realistic, FIXED delays.
It requires **no LLM key and no real gateway** — the recording IS the run, so the
whole front-to-back demo works offline and the e2e is reproducible.

The replayed events are plain dicts (already contract-shaped); the server serializes
each with :func:`events.to_sse`, exactly as it serializes the live dataclasses — so
demo and live share one wire path.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Iterator, Optional

RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
DEFAULT_SCENARIO = "demo-cc-codex"

# Per-event-type pacing (seconds). Deterministic — no jitter — so the e2e is stable.
# The grant pause is deliberately long: it is the human-approval beat the UI exists to
# show ("the card visibly WAITS").
_DELAY_BY_TYPE: dict[str, float] = {
    "session.start": 0.15,
    "agent.state": 0.20,
    "assistant.delta": 0.05,
    "assistant.message": 0.35,
    "capabilities.discovered": 0.45,
    "tool.call.start": 0.30,
    "tool.call.grant_pending": 0.40,
    "tool.call.grant_resolved": 1.60,
    "tool.call.delta": 0.18,
    "tool.call.result": 0.35,
    "orchestration.board": 0.30,
    "memory.update": 0.25,
    "audit.event": 0.12,
    "session.end": 0.20,
    "error": 0.10,
}
_DEFAULT_DELAY = 0.20


def scenario_path(scenario: Optional[str]) -> str:
    """Resolve a scenario name (or filename) to a recordings/*.json path."""
    name = scenario or DEFAULT_SCENARIO
    if name.endswith(".json"):
        name = name[: -len(".json")]
    # Guard against path traversal — scenarios live flat under recordings/.
    name = os.path.basename(name)
    return os.path.join(RECORDINGS_DIR, f"{name}.json")


def load_recording(scenario: Optional[str] = None) -> list[dict[str, Any]]:
    """Load and validate a recorded AgentEvent[] for ``scenario``."""
    path = scenario_path(scenario)
    if not os.path.exists(path):
        raise FileNotFoundError(f"no recording for scenario {scenario!r} at {path}")
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError(f"recording {path} is not a JSON array of AgentEvents")
    return data


def iter_demo_events(
    message: Optional[str] = None,
    scenario: Optional[str] = None,
    *,
    speed: float = 1.0,
    sleep: Any = time.sleep,
) -> Iterator[dict[str, Any]]:
    """Yield the recorded AgentEvents with realistic, deterministic delays.

    ``message`` is accepted for API symmetry with live mode but intentionally
    IGNORED: the canonical recording is the demo, so replay stays reproducible (the
    e2e asserts a fixed sequence). ``speed`` scales every delay (``speed=0`` → no
    delays, used by fast tests)."""
    events = load_recording(scenario)
    for event in events:
        etype = event.get("type", "") if isinstance(event, dict) else ""
        delay = _DELAY_BY_TYPE.get(etype, _DEFAULT_DELAY)
        if speed > 0 and delay > 0:
            sleep(delay * speed)
        yield event
