"""
plexus_deepagents — compile any Plexus capability into a DeepAgents-native skill.

This is the **Plexus → DeepAgents skills-bundle emitter + HTTP helper** (GOAL.md §3 /
§7.3). It is generic over ANY Plexus capability: nothing here is pomodoro-specific.

Three pieces:

1. ``PlexusClient`` — the agent-side HTTP client speaking the Plexus M0 wire
   protocol (v0.1.2): ``discover → handshake → grant → invoke`` with the FULL
   resource-side-approval polling loop. It is the Python sibling of the TS
   ``examples/min-agent/client.ts`` engine and the ``plexus call`` CLI flow.

2. ``emit_skills(out_dir)`` — for EVERY discovered capability, write one
   ``SKILL.md`` (Agent-Skills standard: YAML frontmatter ``name``/``description``
   for progressive disclosure + a body that is the capability's ``describe``, its
   IO schema, the resource-side-approval note, and how to call it via the helper).
   THIS emission is the "compile capability → agent-native skill" step.

3. ``plexus_skills_tools(client)`` / ``make_invoke_tool(client)`` — the DeepAgents
   integration shim. Returns the ``plexus_invoke`` tool the emitted skills tell the
   model to call, ready to hand to ``create_deep_agent(..., tools=[...])``.

See ``README.md`` for the wiring and ``tests/`` for the polling state-machine +
SKILL.md emission unit tests (run against a fake in-process HTTP layer).
"""

from .client import (
    PlexusClient,
    PlexusError,
    GrantDenied,
    GrantExpired,
    GrantTimeout,
    InvokeFailed,
)
from .emit import emit_skills, skill_markdown_for_entry, slug_for_capability
from .integration import (
    make_invoke_tool,
    plexus_skills_tools,
    plexus_invoke_callable,
)

__all__ = [
    "PlexusClient",
    "PlexusError",
    "GrantDenied",
    "GrantExpired",
    "GrantTimeout",
    "InvokeFailed",
    "emit_skills",
    "skill_markdown_for_entry",
    "slug_for_capability",
    "make_invoke_tool",
    "plexus_skills_tools",
    "plexus_invoke_callable",
]

__version__ = "0.1.0"
