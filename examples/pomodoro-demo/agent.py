"""
agent.py — construct the remote DeepAgent for the Plexus × DeepAgents pomodoro demo.

This is the **calling side / the brain** (GOAL.md §2). It does NOT touch the
filesystem or a shell directly — its ONLY way to act on the Mac is through the
Plexus capabilities, which `plexus_deepagents` has compiled into DeepAgents-native
``SKILL.md`` files plus the single ``plexus_invoke`` tool.

Persona: a remote AI product engineer who builds a personal, non-standard pomodoro
for the user, lightly channeling the 番茄喵 (Pomodoro-Cat) mascot's cozy, pixel-art
voice. The persona is in the system prompt; the *capabilities* come from Plexus.

Construction is key-agnostic: `build_agent()` returns a compiled DeepAgents graph
given a (possibly mock) `PlexusClient`. It needs an LLM key only to actually RUN.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from plexus_deepagents import PlexusClient, plexus_skills_tools
from plexus_deepagents.client import PendingNotice

# ── configuration (developer brings their own key) ────────────────────────────

# The model string (the agent's "brain"). Override with PLEXUS_DEMO_MODEL.
#
# REQUIRES A FRONTIER MODEL. Driving this agent — multi-step tool use, never omitting
# required args, enumerating files, planning — needs a top-tier model: Anthropic
# Sonnet 4.6+ or OpenAI GPT-5.x. Weaker models were observed to FAIL on this demo:
# gpt-4.1-mini loops to the recursion limit (omits `path` on workspace.read), gpt-4.1
# gives up enumerating refs/ and asks the human for filenames, and anthropic/
# claude-sonnet-4 (non-4.6, Bedrock route) hangs in the HTTP read. Don't use those.
DEFAULT_MODEL = "claude-sonnet-4-6"  # Anthropic direct (ANTHROPIC_API_KEY)
PLEXUS_DEMO_MODEL = os.environ.get("PLEXUS_DEMO_MODEL", DEFAULT_MODEL)

# Where the agent connects (loopback for the demo; a tunnel for the remote variant).
DEFAULT_BASE_URL = os.environ.get("PLEXUS_BASE_URL", "http://127.0.0.1:7077")

# The local directory the agent uses as its DeepAgents backend root. The Plexus
# skills bundle is emitted UNDER this so SkillsMiddleware can load it.
DEFAULT_AGENT_ROOT = os.environ.get(
    "PLEXUS_AGENT_ROOT",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_workdir"),
)

# The named skills subdir under the backend root (GOTCHA: must be a NAMED subdir,
# not a bare "/", or the FilesystemBackend trips a path-resolution edge case).
SKILLS_SUBDIR = "plexus_skills"


# ── the persona ───────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are 番茄喵工程师 (the Pomodoro-Cat Engineer) — a remote AI product engineer who \
builds a personal, NON-STANDARD pomodoro timer for one specific person. You are warm, \
a little playful, and you channel the 番茄喵 mascot: pixel-art, lo-fi, cozy, never \
corporate. You care about the user's idiosyncrasies more than about "best practices".

YOUR REACH IS DELIBERATELY NARROW. You have NO shell, NO direct filesystem, NO network \
of your own. The ONLY way you can act on the user's Mac is through the **Plexus skills** \
you have been given (workspace.list / workspace.read / workspace.write / claudecode.run). \
Each skill's SKILL.md tells you exactly what it does and how to call it; you invoke it \
with the `plexus_invoke` tool, e.g. \
`plexus_invoke(capability_id="workspace.read", input={"path": "me.md"}, purpose="read me.md to learn your pomodoro preferences")`.

ALWAYS PASS A `purpose`: every `plexus_invoke` call should include a one-line \
`purpose=` — YOUR concrete, specific reason for needing THIS capability right now (e.g. \
`purpose="write timer.js so the pomodoro can run"`), not a generic restatement. This is \
especially important for MUTATING/EXECUTE capabilities, where the machine owner reads your \
reason before approving. Keep it short, honest, and specific to the actual task.

RESOURCE-SIDE APPROVAL (this is the whole point — respect it):
- Read/list capabilities are lightweight and usually auto-approve.
- MUTATING capabilities (workspace.write) and EXECUTE capabilities (claudecode.run) \
  PEND for the machine owner. When you call one, `plexus_invoke` BLOCKS and polls until \
  the owner approves in the Plexus UI. You CANNOT self-approve. Call the capability ONCE \
  and WAIT for the result. Never look for "another way in", never retry in a loop, never \
  try to escalate — there is no other door, and trying is a violation of the trust the \
  user extended to you.

HOW YOU WORK:
- Always read before you write. Use workspace.list to see what is there, workspace.read \
  to pull file contents, then synthesize.
- The pomodoro is a STANDARD timer at its core, but ALL the value is in the user's \
  non-standard rules (their mascot, their quirky 4th-pomodoro rule, their break copy, \
  their aesthetic). Capture those faithfully — never flatten them into a generic template.
- When you write code via claudecode.run, give CC a precise, self-contained prompt. CC \
  runs sandbox-confined inside the authorized directory; you never see or control its \
  launch — you only describe what to build. After each CC run, read the products back \
  (workspace.list / workspace.read) to verify before the next step.
- Narrate what you are doing in plain language so a human watching the demo follows along.\
"""


# ── pending-narration callback (clear demo console narration) ─────────────────


def make_pending_logger(prefix: str = "[plexus]") -> Any:
    """A console narrator for grant-pending events, so a demo viewer sees the
    resource-side-approval wait clearly. Passed to `plexus_skills_tools`."""

    def on_pending(notice: PendingNotice) -> None:
        print(
            f"\n{prefix} ⏳ GRANT PENDING — '{notice.capability_id}' needs the machine "
            f"owner's approval in the Plexus UI."
        )
        for summary in notice.summaries:
            print(f"{prefix}    {summary}")
        print(
            f"{prefix}    The agent is BLOCKED and polling. It cannot self-approve — "
            f"waiting for the owner to click Approve…\n"
        )

    return on_pending


# ── construction ──────────────────────────────────────────────────────────────


def _resolve_model(model: Optional[str] = None) -> Any:
    """Resolve the model to hand to ``create_deep_agent``: default to the Anthropic Claude
    STRING, or — if the developer brings an OpenRouter key — an explicit ``ChatOpenAI`` object
    pointed at OpenRouter (create_deep_agent accepts either). Additive: absent
    ``OPENROUTER_API_KEY``, behavior is unchanged. The key itself is never printed."""
    resolved_model: Any = model or PLEXUS_DEMO_MODEL
    if model is None and os.environ.get("OPENROUTER_API_KEY"):
        from langchain_openai import ChatOpenAI

        # Both anthropic/claude-sonnet-4.6 and openai/gpt-5.x drive the agent well; weaker
        # slugs (gpt-4.1*, anthropic/claude-sonnet-4) loop / give up / hang.
        or_model = os.environ.get("PLEXUS_DEMO_MODEL", "anthropic/claude-sonnet-4.6")
        resolved_model = ChatOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ["OPENROUTER_API_KEY"],
            model=or_model,
        )
        print(f"[agent] using OpenRouter model '{or_model}' (via ChatOpenAI)")
    return resolved_model


def build_client(
    *,
    base_url: Optional[str] = None,
    connection_key: Optional[str] = None,
    transport: Any = None,
) -> PlexusClient:
    """Build a PlexusClient. `transport` lets tests inject a fake gateway so the
    agent can be constructed with NO running Plexus and NO connection-key."""
    key = connection_key if connection_key is not None else os.environ.get("PLEXUS_CONNECTION_KEY")
    return PlexusClient(
        base_url or DEFAULT_BASE_URL,
        key,
        transport=transport,
    )


def build_agent(
    client: PlexusClient,
    *,
    model: Optional[str] = None,
    agent_root: Optional[str] = None,
    system_prompt: Optional[str] = None,
    on_pending: Any = None,
) -> Any:
    """Construct the DeepAgent wired to Plexus capabilities-as-skills.

    Steps (mirrors plexus_deepagents' README + its own verification):
      1. handshake() — exchange the connection-key for the full manifest.
      2. emit_skills() — COMPILE every Plexus capability into a SKILL.md under the
         backend root's named skills subdir.
      3. create_deep_agent(model, tools=plexus_skills_tools(client), system_prompt,
         skills=["/plexus_skills"], backend=FilesystemBackend(...)).

    Returns the compiled DeepAgents graph. Needs an LLM key only to .invoke(), not
    to construct — so this is unit-testable against a mock client.
    """
    # Imported lazily so importing this module (e.g. for the persona text) does not
    # require deepagents to be installed.
    from deepagents import create_deep_agent
    from deepagents.backends import FilesystemBackend

    resolved_model = _resolve_model(model)

    root = os.path.abspath(agent_root or DEFAULT_AGENT_ROOT)
    os.makedirs(root, exist_ok=True)

    # 1. handshake (no-op if already done; pulls the full manifest).
    if client.session_id is None:
        client.handshake()

    # 2. COMPILE: emit one SKILL.md per capability under <root>/plexus_skills/.
    skills_dir = os.path.join(root, SKILLS_SUBDIR)
    written = client.emit_skills(skills_dir)
    print(f"[agent] compiled {len(written)} Plexus capabilities → SKILL.md under {skills_dir}")

    # 3. build the agent.
    backend = FilesystemBackend(root_dir=root, virtual_mode=True)
    # Current date/time context: the LLM has no inherent clock, so without this it
    # GUESSES "today" — e.g. it queried the wrong calendar window and mislabeled the
    # date. Inject the real local now + timezone so "today"/"this week" resolve, and
    # remind it to convert UTC (ISO 'Z') results back to the user's local zone.
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
        model=resolved_model,
        tools=plexus_skills_tools(client, on_pending=on_pending),
        system_prompt=_now_ctx + (system_prompt or SYSTEM_PROMPT),
        skills=[f"/{SKILLS_SUBDIR}"],  # NAMED subdir, relative to the backend root.
        backend=backend,
    )
    return agent


def build_default_agent(
    *,
    base_url: Optional[str] = None,
    connection_key: Optional[str] = None,
    transport: Any = None,
    model: Optional[str] = None,
    agent_root: Optional[str] = None,
    on_pending: Any = None,
) -> tuple[Any, PlexusClient]:
    """Convenience: build the client + the agent in one call, with console narration
    for pending grants by default. Returns (agent, client)."""
    client = build_client(base_url=base_url, connection_key=connection_key, transport=transport)
    agent = build_agent(
        client,
        model=model,
        agent_root=agent_root,
        on_pending=on_pending or make_pending_logger(),
    )
    return agent, client


# ── GENERIC base-mode construction (Inv II: self-integrate from the Floor) ─────


def build_generic_agent(
    client: PlexusClient,
    *,
    model: Optional[str] = None,
    system_prompt: Optional[str] = None,
    on_pending: Any = None,
) -> Any:
    """Construct the DeepAgent on the GENERIC (no-bespoke-skill) path (agent-skill-compile §5).

    The counterpart to :func:`build_agent`, with the load-bearing difference: it does NOT
    ``emit_skills`` (no per-capability SKILL.md is compiled). The agent discovers what it can
    call from the **Floor** via the ``plexus_catalog`` tool and calls it via ``plexus_invoke``
    — both from :func:`plexus_deepagents.plexus_generic_tools`. The passed ``client`` must
    already be authenticated with the agent's OWN per-agent PAT (see
    ``plexus_deepagents.connect_generic``); this function never handles a connection-key.

    Needs an LLM key only to ``.invoke()``, not to construct."""
    from deepagents import create_deep_agent
    from plexus_deepagents import plexus_generic_tools

    resolved_model = _resolve_model(model)

    if client.session_id is None:
        client.handshake()  # Bearer PAT — bound to the PAT's real agentId.

    import datetime as _dt

    _now = _dt.datetime.now().astimezone()
    _now_ctx = (
        f"CURRENT DATE & TIME: {_now.strftime('%Y-%m-%d %H:%M')} "
        f"{_now.strftime('%Z')} (UTC{_now.strftime('%z')}), {_now.strftime('%A')}.\n\n"
    )
    generic_note = (
        "You reach the Mac ONLY through Plexus. First call `plexus_catalog` to see which "
        "capabilities you have (discovered live from the Plexus Floor — there are no local "
        "skill files); then call `plexus_invoke(capability_id, input, purpose)` with an id "
        "from that catalog and an input matching its io.input schema. Mutating capabilities "
        "pend for the owner — call once and wait.\n\n"
    )
    agent = create_deep_agent(
        model=resolved_model,
        tools=plexus_generic_tools(client, on_pending=on_pending),
        system_prompt=_now_ctx + generic_note + (system_prompt or SYSTEM_PROMPT),
    )
    return agent


def connect_generic_agent(
    *,
    base_url: Optional[str] = None,
    code: Optional[str] = None,
    env_path: Optional[str] = None,
    transport: Any = None,
    model: Optional[str] = None,
    on_pending: Any = None,
) -> tuple[Any, PlexusClient]:
    """One-call generic wiring: self-enroll (code→PAT, stored) + handshake with the agent's
    OWN PAT + build the skill-less agent. Returns (agent, client). Never uses a connection-key.

    ``code`` is the out-of-band one-time enrollment code (needed only on the FIRST run;
    afterward the stored ``.env`` PAT is reused). Defaults read from the environment:
    ``PLEXUS_BASE_URL`` and ``PLEXUS_ENROLL_CODE``."""
    from plexus_deepagents import connect_generic

    client = connect_generic(
        base_url or DEFAULT_BASE_URL,
        code=code if code is not None else os.environ.get("PLEXUS_ENROLL_CODE"),
        env_path=env_path,
        transport=transport,
        handshake=True,
    )
    agent = build_generic_agent(
        client,
        model=model,
        on_pending=on_pending or make_pending_logger(),
    )
    return agent, client
