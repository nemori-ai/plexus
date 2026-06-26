#!/usr/bin/env python3
"""
run_demo.py — the two-act runner for the Plexus × DeepAgents pomodoro demo.

Three commands:

    python run_demo.py --setup     # seed the authorized dir from seed/
    python run_demo.py --act1      # organize refs → PRD.html  (write PENDS)
    python run_demo.py --act2      # plan → build via Claude Code (execute PENDS)

The agent drives both acts using ONLY the Plexus skills (workspace.* +
claudecode.run). It NEVER touches the filesystem or a shell directly — every
mutating move pends for the machine owner in the Plexus UI, and the helper blocks
and polls until the owner approves.

`--setup` is the one place the runner (not the agent) copies the seed into the
authorized dir, simulating "the owner put their notes in the folder they chose to
expose". Everything after that goes through Plexus.

Env:
    PLEXUS_CONNECTION_KEY  the connection-key (the ONLY auth the agent holds)
    PLEXUS_BASE_URL        gateway base url (default http://127.0.0.1:7077)
    PLEXUS_WORKSPACE_DIR   the authorized dir (default ~/PlexusDemo/pomodoro)
    PLEXUS_DEMO_MODEL      the LLM model string (default claude-sonnet-4-5)
    ANTHROPIC_API_KEY      (or your provider's key) — only needed to actually RUN
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_DIR = os.path.join(HERE, "seed")

DEFAULT_WORKSPACE_DIR = os.path.expanduser("~/PlexusDemo/pomodoro")


def workspace_dir() -> str:
    return os.path.abspath(os.environ.get("PLEXUS_WORKSPACE_DIR", DEFAULT_WORKSPACE_DIR))


# ── narration helpers ─────────────────────────────────────────────────────────


def banner(title: str) -> None:
    print("\n" + "=" * 72)
    print(f"  {title}")
    print("=" * 72)


def say(msg: str) -> None:
    print(f"[demo] {msg}")


# ── setup ─────────────────────────────────────────────────────────────────────


def do_setup() -> int:
    """Seed the authorized directory by copying seed/ into it. This is the ONLY
    direct filesystem touch in the whole demo, and it is the OWNER's side — it
    simulates the owner dropping their notes into the folder they chose to expose.
    The agent never does this."""
    dst = workspace_dir()
    banner("SETUP — seed the authorized directory (owner side, not the agent)")
    say(f"seed source:      {SEED_DIR}")
    say(f"authorized dir:   {dst}")
    if not os.path.isdir(SEED_DIR):
        print(f"[demo] ERROR: seed dir not found at {SEED_DIR}", file=sys.stderr)
        return 1
    os.makedirs(dst, exist_ok=True)
    # Copy refs/ and me.md (and anything else under seed/).
    for name in sorted(os.listdir(SEED_DIR)):
        src = os.path.join(SEED_DIR, name)
        target = os.path.join(dst, name)
        if os.path.isdir(src):
            shutil.copytree(src, target, dirs_exist_ok=True)
        else:
            shutil.copy2(src, target)
        say(f"copied  {name}")
    say("done. The authorized dir now holds refs/ + me.md.")
    say(
        "Make sure Plexus is running with PLEXUS_WORKSPACE_DIR pointing HERE so its "
        "workspace.* capabilities are pinned to this directory."
    )
    return 0


# ── the agent acts ────────────────────────────────────────────────────────────

ACT1_PROMPT = """\
It's time to design the user's personal pomodoro timer. Do this:

1. Use the `workspace.list` Plexus skill to see everything in the authorized \
directory (including the `refs/` subdir).
2. Use `workspace.read` to read `me.md` and EVERY file under `refs/`. me.md is the \
user's own taste and rules; the refs are their notes on existing pomodoro apps \
(what each does, what they like, what they dislike).
3. Synthesize a Product Requirements Document. It MUST capture BOTH:
   - the STANDARD pomodoro features (work/break timers, cycles, sound, a today-only \
     task input), AND
   - the user's NON-STANDARD rules from me.md, faithfully and specifically — the \
     pixel-art 番茄喵 mascot + lo-fi cozy palette; the 4th-pomodoro forced-walk rule \
     where the UI goes grayscale until "我回来了" is clicked; the cat that fattens one \
     level per completed cycle; breaks that show only ONE line the user wrote \
     themselves (no canned motivational copy); true mute; no account / localStorage only.
4. Render the PRD as a single self-contained `PRD.html` (inline CSS, readable, \
   styled in the cozy lo-fi spirit) and WRITE it to the authorized dir via the \
   `workspace.write` Plexus skill, path `PRD.html`. That write PENDS for the owner — \
   call it once and wait for approval.

When done, tell me the exact path PRD.html landed at and a 3-line summary of the \
non-standard items you captured."""

ACT2_PROMPT = """\
The user reviewed PRD.html and said "build it." Now construct the actual app:

1. Read `PRD.html` back via `workspace.read` so you are building from the approved \
spec (not your memory).
2. Decompose the build into a short, concrete plan and scaffold the project: use \
`workspace.write` to create any small files you want CC to start from if helpful \
(e.g. a NOTES.md plan). Mutating writes PEND for the owner — call once and wait.
3. Call the `claudecode.run` Plexus skill (capability_id "claudecode.run") with a \
precise, self-contained `prompt` instructing Claude Code to build a SINGLE-PAGE web \
pomodoro app in the authorized directory implementing the PRD, especially the quirky \
rules (the pixel-art 番茄喵, the 4th-pomodoro grayscale forced-walk with the "我回来了" \
button, the fattening cat, the user-written break line, true mute, localStorage). \
Produce a single `index.html` (inline or co-located CSS/JS is fine). claudecode.run \
is EXECUTE — it PENDS for the owner; call it and wait. CC runs sandbox-confined inside \
the authorized dir; you only describe the work.
4. After CC finishes, use `workspace.list` + `workspace.read` to VERIFY the product \
(does index.html exist? does it reference the grayscale rule and the cat?). If \
something essential is missing, call `claudecode.run` AGAIN with a focused follow-up \
prompt to fix it, then re-verify.

When done, tell me what files exist in the dir and confirm the quirky 4th-pomodoro \
rule is implemented."""


def _run_agent(prompt: str, recursion_limit: int = 80) -> int:
    """Build the agent against a live Plexus + LLM and run one act."""
    if not os.environ.get("PLEXUS_CONNECTION_KEY"):
        print(
            "[demo] ERROR: set PLEXUS_CONNECTION_KEY (the connection-key the agent "
            "uses to reach Plexus).",
            file=sys.stderr,
        )
        return 2

    from agent import build_default_agent

    say("constructing the remote DeepAgent (connection-key only; no shell, no fs)…")
    agent, client = build_default_agent()
    say(f"handshook with Plexus; session={client.session_id}")
    say("discovered + compiled capabilities as skills:")
    for cap in client.capabilities():
        say(f"    • {cap.get('id')}  ({'+'.join(cap.get('grants', [])) or 'read'})")

    say("handing the task to the agent. Watch for grant-pending pauses below.\n")
    result = agent.invoke(
        {"messages": [{"role": "user", "content": prompt}]},
        {"recursion_limit": recursion_limit},
    )

    # Print the agent's final message.
    msgs = result.get("messages", []) if isinstance(result, dict) else []
    if msgs:
        final = msgs[-1]
        content = getattr(final, "content", None)
        if content is None and isinstance(final, dict):
            content = final.get("content")
        banner("AGENT — final report")
        print(content if isinstance(content, str) else str(content))
    return 0


def do_act1() -> int:
    banner("ACT 1 — organize the user's notes → write PRD.html (write PENDS)")
    say(f"authorized dir: {workspace_dir()}")
    rc = _run_agent(ACT1_PROMPT)
    if rc == 0:
        prd = os.path.join(workspace_dir(), "PRD.html")
        banner("ACT 1 — result")
        say(f"PRD should now be at: {prd}")
        if os.path.exists(prd):
            say(f"✓ PRD.html exists ({os.path.getsize(prd)} bytes). Open it in a browser.")
        else:
            say("PRD.html not found yet — check the agent report / approval above.")
    return rc


def do_act2() -> int:
    banner("ACT 2 — plan → build the pomodoro app via Claude Code (execute PENDS)")
    say(f"authorized dir: {workspace_dir()}")
    rc = _run_agent(ACT2_PROMPT)
    if rc == 0:
        index = os.path.join(workspace_dir(), "index.html")
        banner("ACT 2 — result")
        say(f"App entry should be at: {index}")
        if os.path.exists(index):
            say(f"✓ index.html exists ({os.path.getsize(index)} bytes). Open it in a browser.")
        else:
            say("index.html not found yet — check the agent report / CC runs above.")
    return rc


# ── cli ───────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Two-act runner for the Plexus × DeepAgents pomodoro demo.",
    )
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--setup", action="store_true", help="seed the authorized dir from seed/")
    g.add_argument("--act1", action="store_true", help="organize refs → write PRD.html (PENDS)")
    g.add_argument("--act2", action="store_true", help="plan → build via Claude Code (PENDS)")
    args = parser.parse_args(argv)

    if args.setup:
        return do_setup()
    if args.act1:
        return do_act1()
    if args.act2:
        return do_act2()
    return 1


if __name__ == "__main__":
    sys.exit(main())
