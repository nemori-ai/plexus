"""
Build-time tests for the example DeepAgent + the two-act runner.

These verify — WITHOUT a live Plexus and WITHOUT an LLM key — that:
  * the agent CONSTRUCTS: emit_skills + plexus_skills_tools + create_deep_agent
    return a compiled graph carrying the Plexus skills and the plexus_invoke tool
    (mirrors plexus_deepagents' own verification, driven through the FAKE gateway).
  * the two-act runner wires the RIGHT capability calls — Act 1's prompt drives
    workspace.read/list + workspace.write(PRD.html); Act 2's drives workspace.read +
    claudecode.run — checked by having the agent's tool fall through to a fake
    PlexusClient and asserting which capability ids get invoked.

Run:  cd examples/pomodoro-demo && python -m pytest tests/test_agent_build.py -q
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from plexus_deepagents import PlexusClient  # noqa: E402
from plexus_deepagents.integration import plexus_invoke_callable  # noqa: E402
from tests.fake_gateway import FakeGateway, BASE_URL  # noqa: E402

deepagents = pytest.importorskip("deepagents")  # skip cleanly if not installed

import agent as agent_mod  # noqa: E402
import run_demo  # noqa: E402


def _client(gw, **kw):
    # no-op sleep keeps any (unexpected) polling instant.
    return PlexusClient(BASE_URL, "conn-key", transport=gw, sleep=lambda s: None, **kw)


# ── construction (mirror plexus_deepagents' verification) ─────────────────────


def test_agent_builds_with_mock_client(tmp_path):
    """build_agent against a FAKE gateway returns a compiled graph — no LLM key,
    no running Plexus."""
    gw = FakeGateway()
    client = _client(gw)
    a = agent_mod.build_agent(client, model="claude-sonnet-4-5", agent_root=str(tmp_path))

    # A deepagents agent is a CompiledStateGraph.
    from langgraph.graph.state import CompiledStateGraph

    assert isinstance(a, CompiledStateGraph)


def test_emit_skills_land_under_named_subdir(tmp_path):
    """The compile step writes one SKILL.md per callable capability under the
    NAMED plexus_skills/ subdir (the verified gotcha)."""
    gw = FakeGateway()
    client = _client(gw)
    agent_mod.build_agent(client, agent_root=str(tmp_path))

    skills_dir = tmp_path / agent_mod.SKILLS_SUBDIR
    assert skills_dir.is_dir()
    slugs = {p.name for p in skills_dir.iterdir() if p.is_dir()}
    # capability + workflow entries get a SKILL.md; the kind:"skill" entry does not.
    for cap in ("workspace-list", "workspace-read", "workspace-write", "claudecode-run"):
        assert (skills_dir / cap / "SKILL.md").is_file(), f"missing SKILL.md for {cap}"
    assert "workspace-write-how-to-use" not in slugs


def test_plexus_invoke_tool_present_and_named():
    """plexus_skills_tools exposes exactly the one plexus_invoke tool the emitted
    SKILL.md files reference."""
    gw = FakeGateway()
    client = _client(gw)
    from plexus_deepagents import plexus_skills_tools

    tools = plexus_skills_tools(client)
    assert len(tools) == 1
    name = getattr(tools[0], "name", getattr(tools[0], "__name__", ""))
    assert "plexus_invoke" in name


def test_build_does_not_require_an_llm_key(tmp_path, monkeypatch):
    """Construction must not read a provider key. Clear ANTHROPIC_API_KEY and still
    build (the key is needed only to .invoke(), which we never call here)."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    gw = FakeGateway()
    client = _client(gw)
    a = agent_mod.build_agent(client, agent_root=str(tmp_path))
    assert a is not None


# ── runner wiring: the right capability calls ─────────────────────────────────


class _RecordingClient:
    """A minimal stand-in that records which capability ids get invoked, so we can
    assert the runner/persona drive the intended Plexus calls without an LLM. It
    satisfies what plexus_invoke_callable needs: an .invoke(cap_id, input, ...)."""

    def __init__(self):
        self.calls = []

    def invoke(self, capability_id, input=None, *, purpose=None, on_pending=None):
        self.calls.append((capability_id, input))
        if capability_id == "workspace.list":
            return ["me.md", "refs"]
        if capability_id == "workspace.read":
            return "stub file contents"
        # write / claudecode.run succeed silently.
        return {"ok": True}


def test_invoke_tool_routes_capability_ids():
    """The plexus_invoke tool the agent calls routes capability_id straight to the
    client — so whatever capability the agent picks is the one Plexus sees. This is
    the contract the two acts rely on."""
    rec = _RecordingClient()
    invoke = plexus_invoke_callable(rec, on_pending=lambda n: None)

    invoke("workspace.list", {"subdir": "."})
    invoke("workspace.read", {"path": "me.md"})
    invoke("workspace.write", {"path": "PRD.html", "content": "<html/>"})
    invoke("claudecode.run", {"prompt": "build it"})

    ids = [c[0] for c in rec.calls]
    assert ids == ["workspace.list", "workspace.read", "workspace.write", "claudecode.run"]
    # the PRD write targets PRD.html; the build runs claudecode.run.
    assert rec.calls[2][1]["path"] == "PRD.html"
    assert "prompt" in rec.calls[3][1]


def test_act_prompts_name_the_right_capabilities():
    """Guardrail on the persona/runner: Act 1 must drive read/list + a PRD.html
    write; Act 2 must drive a read-back + claudecode.run. These steer the LLM, so we
    assert the capability names + key artifacts are actually in the prompts."""
    a1 = run_demo.ACT1_PROMPT
    assert "workspace.list" in a1 and "workspace.read" in a1
    assert "workspace.write" in a1 and "PRD.html" in a1
    # the non-standard items must be named so the PRD isn't a generic template (AC3).
    for needle in ("番茄喵", "grayscale", "我回来了", "localStorage"):
        assert needle in a1

    a2 = run_demo.ACT2_PROMPT
    assert "workspace.read" in a2          # read the approved PRD back
    assert "claudecode.run" in a2          # build via CC
    assert "workspace.list" in a2          # verify products between calls
    assert "index.html" in a2


def test_setup_copies_seed_into_workspace(tmp_path, monkeypatch):
    """--setup seeds the authorized dir from seed/ (refs/ + me.md). This is the only
    direct fs touch and it is the owner's side, not the agent's."""
    ws = tmp_path / "authorized"
    monkeypatch.setenv("PLEXUS_WORKSPACE_DIR", str(ws))
    rc = run_demo.do_setup()
    assert rc == 0
    assert (ws / "me.md").is_file()
    assert (ws / "refs").is_dir()
    assert any((ws / "refs").iterdir())


def test_act_runners_require_connection_key(monkeypatch):
    """The agent holds ONLY the connection-key; without it the acts refuse to run
    (they never fall back to some other auth)."""
    monkeypatch.delenv("PLEXUS_CONNECTION_KEY", raising=False)
    assert run_demo.do_act1() == 2
    assert run_demo.do_act2() == 2
