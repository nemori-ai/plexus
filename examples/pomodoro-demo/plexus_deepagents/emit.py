"""
emit — compile a Plexus capability into a DeepAgents-native ``SKILL.md``.

This is the "编译成目标框架的原生 skill 形态" step (GOAL.md §1 / §3): for DeepAgents
the target form is the **Agent-Skills standard** — a directory per skill, each
containing a ``SKILL.md`` with YAML frontmatter (``name`` / ``description`` for
progressive disclosure) followed by the markdown body.

``deepagents``' ``SkillsMiddleware`` loads a *source directory* whose immediate
subdirectories are skills; each subdir must hold a ``SKILL.md``. So the emitted
layout is::

    out_dir/
      workspace-read/SKILL.md
      workspace-write/SKILL.md
      claudecode-run/SKILL.md

and the agent is created with ``skills=[out_dir]`` (+ a FilesystemBackend rooted so
that path is visible).

The body of each SKILL.md is the capability's own ``describe`` (the gateway's
agent-facing "what / when / how"), its IO schema, an explicit resource-side-approval
note for mutating verbs, and how to invoke it via the ``plexus_invoke`` tool. The
``name``/``description`` frontmatter is what the model sees up-front (progressive
disclosure); it opens the full body only when the skill is relevant.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

# Agent-Skills spec constraints (https://agentskills.io/specification), mirrored by
# deepagents' SkillsMiddleware.
_MAX_NAME_LEN = 64
_MAX_DESC_LEN = 1024

# Verbs that MUTATE the owner's machine — these PEND for resource-side approval.
_MUTATING_VERBS = {"write", "execute"}


def slug_for_capability(capability_id: str) -> str:
    """Derive a spec-valid skill ``name`` from a capability id.

    Agent-Skills ``name`` must be ≤64 chars, lowercase, ``[a-z0-9-]`` only. A Plexus
    id like ``workspace.write`` or ``mcp.github.create_issue`` becomes
    ``workspace-write`` / ``mcp-github-create-issue``."""
    slug = capability_id.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    if len(slug) > _MAX_NAME_LEN:
        slug = slug[:_MAX_NAME_LEN].rstrip("-")
    return slug or "capability"


def _first_sentence(text: str, max_len: int = 200) -> str:
    """One-line teaser from a (possibly multi-sentence) describe string."""
    text = (text or "").strip()
    if not text:
        return ""
    # First sentence (split on ". " boundary), else first line.
    first = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    first = re.sub(r"\s+", " ", first).strip()
    if len(first) > max_len:
        first = first[: max_len - 1].rstrip() + "…"
    return first


def _yaml_escape(value: str) -> str:
    """Quote a YAML scalar safely (frontmatter value on one line)."""
    flat = re.sub(r"\s+", " ", value).strip()
    if len(flat) > _MAX_DESC_LEN:
        flat = flat[: _MAX_DESC_LEN - 1].rstrip() + "…"
    # Always double-quote and escape embedded quotes/backslashes → valid YAML.
    escaped = flat.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _schema_block(io: Optional[dict[str, Any]], which: str) -> Optional[str]:
    """Render an entry's ``io.input`` / ``io.output`` JSON Schema as a fenced block."""
    if not io:
        return None
    schema = io.get(which)
    if schema is None:
        return None
    try:
        rendered = json.dumps(schema, indent=2, ensure_ascii=False)
    except (TypeError, ValueError):
        rendered = str(schema)
    return f"```json\n{rendered}\n```"


def _example_input(io: Optional[dict[str, Any]]) -> str:
    """Build a tiny illustrative input object from the input schema's properties."""
    props = ((io or {}).get("input") or {})
    if not isinstance(props, dict):
        return "{ ... }"
    properties = props.get("properties")
    if not isinstance(properties, dict) or not properties:
        return "{}"
    example: dict[str, Any] = {}
    for key, spec in properties.items():
        t = spec.get("type") if isinstance(spec, dict) else None
        if t == "string":
            example[key] = f"<{key}>"
        elif t in ("number", "integer"):
            example[key] = 0
        elif t == "boolean":
            example[key] = False
        elif t == "array":
            example[key] = []
        elif t == "object":
            example[key] = {}
        else:
            example[key] = f"<{key}>"
    return json.dumps(example, ensure_ascii=False)


def skill_markdown_for_entry(entry: dict[str, Any], *, base_url: Optional[str] = None) -> str:
    """Render the full ``SKILL.md`` text (frontmatter + body) for one capability entry.

    Generic over any capability: it reads only the public manifest fields
    (``id`` / ``label`` / ``describe`` / ``grants`` / ``io`` / ``kind`` / trust posture).
    """
    cap_id = entry.get("id", "")
    name = slug_for_capability(cap_id)
    label = entry.get("label") or cap_id
    describe = entry.get("describe") or label
    grants: list[str] = list(entry.get("grants") or [])
    kind = entry.get("kind", "capability")
    io = entry.get("io")
    sensitivity = entry.get("sensitivity")
    provenance = entry.get("provenance")
    trust_window = (entry.get("recommendedTrustWindow") or {}).get("kind")

    is_mutating = bool(_MUTATING_VERBS.intersection(grants))

    # ── frontmatter description (progressive disclosure) ──────────────────────
    # Front-loads WHAT it does + WHEN to use it + the grant cost, so the model can
    # decide whether to open the full body. The mutating-verb hint rides here too.
    teaser = _first_sentence(describe, max_len=320)
    verb_str = "+".join(grants) if grants else "none"
    desc = (
        f"{teaser} Invoke via the plexus_invoke tool with capability_id "
        f'"{cap_id}". Requires grant verb(s): {verb_str}.'
    )
    if is_mutating:
        desc += (
            " This is a MUTATING action — it PENDS for the machine owner's approval "
            "in Plexus; the helper blocks and polls until approved, so just wait."
        )

    frontmatter = (
        "---\n"
        f"name: {name}\n"
        f"description: {_yaml_escape(desc)}\n"
        f"license: MIT\n"
        "metadata:\n"
        f"  plexus_capability_id: {json.dumps(cap_id)}\n"
        f"  plexus_kind: {json.dumps(kind)}\n"
        f"  plexus_grants: {json.dumps(grants)}\n"
        "---\n"
    )

    # ── body ──────────────────────────────────────────────────────────────────
    lines: list[str] = []
    lines.append(f"# {label}")
    lines.append("")
    lines.append(
        f"This skill exposes the Plexus capability `{cap_id}` "
        f"(kind: `{kind}`) to you, the agent."
    )
    lines.append("")

    lines.append("## What it does / when to use it")
    lines.append("")
    lines.append(describe.strip())
    lines.append("")

    # Trust posture line, when the gateway stamped one.
    posture_bits = []
    if provenance:
        posture_bits.append(f"source-class: `{provenance}`")
    if sensitivity:
        posture_bits.append(f"sensitivity: `{sensitivity}`")
    if trust_window:
        posture_bits.append(f"default trust-window: `{trust_window}`")
    if posture_bits:
        lines.append("## Trust posture")
        lines.append("")
        lines.append(" · ".join(posture_bits))
        lines.append("")

    # The resource-side-approval note — ALWAYS present, but loud for mutating verbs.
    lines.append("## ⚠️ Resource-side approval")
    lines.append("")
    if is_mutating:
        lines.append(
            f"`{cap_id}` requires the verb(s) **{verb_str}**, which **mutate** the "
            "machine owner's environment. When you call it, Plexus does NOT execute "
            "immediately — the grant **PENDS for the machine owner's approval in the "
            "Plexus UI**. The `plexus_invoke` helper **BLOCKS and polls** until the "
            "owner approves (or denies/expires). You **cannot** self-approve. Just "
            "**call it once and wait** — do not retry, do not give up, do not look for "
            "another way in. On approval the call proceeds automatically; on denial the "
            "tool returns a clean error and you should stop and report it."
        )
    else:
        lines.append(
            f"`{cap_id}` requires the verb(s) **{verb_str}** (read-only / non-mutating). "
            "It is typically approved quickly or auto-granted, but if the owner's policy "
            "PENDS it, the `plexus_invoke` helper still BLOCKS and polls until the owner "
            "approves in the Plexus UI — you cannot self-approve; just wait."
        )
    lines.append("")

    # IO schemas.
    in_block = _schema_block(io, "input")
    out_block = _schema_block(io, "output")
    if in_block or out_block:
        lines.append("## Input / output schema")
        lines.append("")
        if in_block:
            lines.append("Input (`io.input` JSON Schema):")
            lines.append("")
            lines.append(in_block)
            lines.append("")
        if out_block:
            lines.append("Output (`io.output` JSON Schema):")
            lines.append("")
            lines.append(out_block)
            lines.append("")

    # How to call it via the helper.
    example = _example_input(io)
    lines.append("## How to call it")
    lines.append("")
    lines.append(
        "Use the `plexus_invoke` tool. It performs the full Plexus flow for you "
        "(handshake → grant → poll-if-pending → invoke) and returns the structured "
        "result:"
    )
    lines.append("")
    lines.append("```")
    lines.append(f'plexus_invoke(capability_id="{cap_id}", input={example})')
    lines.append("```")
    lines.append("")
    lines.append(
        "Validate your `input` against the schema above before calling. Prefer the "
        "narrowest call that answers the task; do not over-fetch."
    )
    lines.append("")
    lines.append("## What you CANNOT do")
    lines.append("")
    lines.append(
        f"- This capability is granted for the verb(s) **{verb_str}** ONLY; it "
        "cannot exceed them."
    )
    lines.append(
        "- You cannot self-grant or bypass the machine owner's approval. Mutating "
        "actions always go through them."
    )
    lines.append(
        "- It is confined to its declared transport on the owner's machine — it "
        "cannot reach other apps, other directories, or the network beyond what "
        "Plexus exposes."
    )
    lines.append("")

    return frontmatter + "\n" + "\n".join(lines)


def emit_skills(
    entries: list[dict[str, Any]],
    out_dir: str,
    *,
    base_url: Optional[str] = None,
) -> list[str]:
    """Write one ``SKILL.md`` per capability entry under ``out_dir``.

    Layout (what ``deepagents`` ``SkillsMiddleware`` expects from a *source* dir):
    ``out_dir/<skill-name>/SKILL.md``. Returns the list of written SKILL.md paths.

    ``entries`` should be the callable entries (``kind:"capability"|"workflow"``);
    pure ``kind:"skill"`` usage entries are read-as-context and skipped if present.
    """
    os.makedirs(out_dir, exist_ok=True)
    written: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        if entry.get("kind") == "skill":
            continue  # usage-context entries are not callable capabilities.
        cap_id = entry.get("id")
        if not cap_id:
            continue
        name = slug_for_capability(cap_id)
        # De-dupe colliding slugs (rare) by appending a counter.
        unique = name
        n = 2
        while unique in seen:
            unique = f"{name}-{n}"
            n += 1
        seen.add(unique)

        skill_dir = os.path.join(out_dir, unique)
        os.makedirs(skill_dir, exist_ok=True)
        path = os.path.join(skill_dir, "SKILL.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(skill_markdown_for_entry(entry, base_url=base_url))
        written.append(path)
    return written
