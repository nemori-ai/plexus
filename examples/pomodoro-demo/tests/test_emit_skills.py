"""
Unit tests for the SKILL.md emission (the "compile capability → agent-native skill"
step). Verifies the Agent-Skills layout + frontmatter + the resource-side-approval
note, against the FAKE gateway's capability set.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
import yaml  # noqa: E402

from plexus_deepagents import (  # noqa: E402
    PlexusClient, emit_skills, skill_markdown_for_entry, slug_for_capability,
)
from tests.fake_gateway import FakeGateway, BASE_URL, DEFAULT_CAPABILITIES  # noqa: E402


def test_slug_is_spec_valid():
    assert slug_for_capability("workspace.write") == "workspace-write"
    assert slug_for_capability("mcp.github.create_issue") == "mcp-github-create-issue"
    s = slug_for_capability("X" * 100)
    assert len(s) <= 64 and re.fullmatch(r"[a-z0-9-]+", s)


def test_emit_writes_one_skill_md_per_capability(tmp_path):
    gw = FakeGateway()
    c = PlexusClient(BASE_URL, "k", transport=gw)
    written = c.emit_skills(str(tmp_path))
    # 4 callable capabilities; the kind:"skill" entry is skipped.
    assert len(written) == 4
    for p in written:
        assert os.path.basename(p) == "SKILL.md"
        assert os.path.isfile(p)
    # Layout: out_dir/<name>/SKILL.md
    names = {os.path.basename(os.path.dirname(p)) for p in written}
    assert "workspace-write" in names and "claudecode-run" in names
    assert "workspace-write-how-to-use" not in names


def test_frontmatter_parses_and_has_name_description():
    entry = next(c for c in DEFAULT_CAPABILITIES if c["id"] == "workspace.read")
    md = skill_markdown_for_entry(entry)
    assert md.startswith("---\n")
    fm_text = md.split("---\n", 2)[1]
    fm = yaml.safe_load(fm_text)
    assert fm["name"] == "workspace-read"
    assert isinstance(fm["description"], str) and len(fm["description"]) <= 1024
    assert "plexus_invoke" in fm["description"]
    assert fm["metadata"]["plexus_capability_id"] == "workspace.read"


def test_mutating_capability_has_pending_note_in_frontmatter_and_body():
    entry = next(c for c in DEFAULT_CAPABILITIES if c["id"] == "workspace.write")
    md = skill_markdown_for_entry(entry)
    fm = yaml.safe_load(md.split("---\n", 2)[1])
    # The progressive-disclosure description warns it's mutating + pends.
    assert "MUTATING" in fm["description"] and "PEND" in fm["description"].upper()
    # The body has the loud resource-side-approval section telling the agent to wait.
    assert "Resource-side approval" in md
    assert "BLOCKS and polls" in md
    assert "cannot" in md.lower() and "self-approve" in md.lower()


def test_read_capability_note_is_present_but_not_mutating():
    entry = next(c for c in DEFAULT_CAPABILITIES if c["id"] == "workspace.read")
    md = skill_markdown_for_entry(entry)
    fm = yaml.safe_load(md.split("---\n", 2)[1])
    assert "MUTATING" not in fm["description"]
    assert "Resource-side approval" in md  # still present, just non-loud.


def test_body_includes_io_schema_and_call_example():
    entry = next(c for c in DEFAULT_CAPABILITIES if c["id"] == "workspace.write")
    md = skill_markdown_for_entry(entry)
    assert "io.input" in md
    assert '"path"' in md and '"content"' in md
    # A concrete plexus_invoke call example with the capability id.
    assert 'plexus_invoke(capability_id="workspace.write"' in md


def test_execute_capability_marked_mutating():
    entry = next(c for c in DEFAULT_CAPABILITIES if c["id"] == "claudecode.run")
    md = skill_markdown_for_entry(entry)
    fm = yaml.safe_load(md.split("---\n", 2)[1])
    assert "MUTATING" in fm["description"]
    assert "execute" in md
