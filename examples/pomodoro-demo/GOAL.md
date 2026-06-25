# Goal: Plexus × DeepAgents Demo — "一个只属于你的番茄钟"

This is the build spec for a first-class `examples/` demo. It is the acceptance
contract for the orchestration that builds it.

## 1. Why this exists
Make Plexus instantly understandable to a C-end developer, and坐实 three strategy points:
- **资源侧代表** — the Mac owner's side does authorization/audit, in one place.
- **powerful 但被严控** — a remote agent does real work yet is locked to one directory.
- **编译成目标框架的原生 skill 形态** — for DeepAgents that is `SKILL.md`.

One-sentence aha: *"A remote agent built real software on my Mac — and it never had a
shell, never left one folder, and I approved every powerful move."*

Two distinct agent layers (do not conflate):
- **Remote DeepAgent** = the client / brain (plans, drives). Integrates with Plexus via skills.
- **Claude Code** = the capability Plexus exposes, used to actually write the code.

## 2. Roles & system boundary
- **Remote DeepAgent (calling side)**: a developer's own agent, with a persona
  ("a remote AI product engineer + the user's preferred mascot/aesthetic"), connected
  to Plexus through skills.
- **Plexus (resource-side gateway)** on the Mac: exposes exactly two things — read/list/write
  to ONE authorized directory, and the ability to run Claude Code inside that directory.
- **Network**: local is fine for the demo. The "internet agent" variant is the developer's
  OWN tunnel (cloudflared/tailscale) — NOT Plexus opening to the internet. Channel security
  is out of scope; the connection-key remains the only auth boundary.

## 3. Integration form (the calling side)
- **`create_deep_agent` (`deepagents`) + Plexus capabilities provided AS SKILLS.**
- Plexus emits a **skills bundle**: one `SKILL.md` per capability (short summary for
  progressive disclosure + usage + "mutating actions PEND for the owner's approval, so wait"),
  plus a shared helper script/CLI that performs `discover → handshake → grant → invoke`
  over HTTP with the bearer token. This emission IS the "compile" step.
- **Approval happens on the RESOURCE side**: when the agent calls a mutating skill, Plexus
  returns "pending — approve in Plexus", and the helper **polls** until the owner approves/
  rejects in the Plexus UI, then proceeds. The agent CANNOT self-approve; it waits.

## 4. Capability surface & grant tiers
| Capability | Class | Authorization |
|---|---|---|
| `workspace.list` / `workspace.read` | read, path-confined | lightweight / quick approve |
| `workspace.write` | write, path-confined | mutating → PENDS for owner |
| `claudecode.run({ prompt })` | execute, sensitive | PENDS; Act 2 uses a **Mode-2 task bundle** ("for 1h may run CC repeatedly in project X") |

- All three are pinned to the authorized directory.
- **CC confinement (the value linchpin)**: the launch command / working dir / config live
  ON THE PLEXUS SIDE — the agent never sees them, never gets a raw bash. Plexus launches CC
  under a **macOS OS sandbox (`sandbox-exec`)** that kernel-confines CC's read/write to the
  authorized dir; CC's own config (headless, `--plugin-dir` embedded plugin, never touching
  `~/.claude/`) is the second door.

## 5. Task script (the demo content)
**Setup** — authorized dir `~/PlexusDemo/pomodoro/` seeded from `examples/pomodoro-demo/seed/`:
`refs/` (notes on real pomodoro apps: what they do / what I like-dislike) + `me.md` (my taste
& mascot). Placeholder sample (swappable): pixel-art "番茄喵" mascot, lo-fi palette; a quirky
rule — the 4th pomodoro forces a walk, the UI goes grayscale until you click "我回来了"; breaks
show only one line I wrote myself. **The pomodoro is standard; all the value is in the non-standard bits.**

**Act 1**: agent reads `refs/` + `me.md` → organizes → writes `PRD.html` (write PENDS → owner
approves) → user reviews it in a browser.

**Act 2**: user says "build it" → agent decomposes into steps + scaffolds → **multiple
`claudecode.run` calls**, verifying products between calls → produces a working single-page web
pomodoro app in the dir, with the 番茄喵 and the quirky rule.

## 6. Acceptance criteria (endpoint-verifiable)
- **AC1 Connect**: with only the connection-key, the DeepAgent discovers Plexus capabilities as
  skills and can invoke a read capability with no extra manual wiring.
- **AC2 Resource-side approval**: `workspace.write` does NOT execute until the owner approves in
  the Plexus UI; the agent blocks/waits; approval proceeds, rejection aborts cleanly.
- **AC3 Non-standard captured**: `PRD.html` is valid and reflects BOTH standard pomodoro features
  AND the non-standard items from `me.md` (not a generic template).
- **AC4 Real artifact**: the Act-2 single-page pomodoro opens & runs in a browser and implements
  the PRD's quirky rule.
- **AC5 CC confined**: `claudecode.run` runs CC locked to the authorized dir; a probe proves CC
  read/write OUTSIDE the dir FAILS; the agent never obtains a generic shell.
- **AC6 Path confinement (negative)**: no exposed capability can read/write outside the authorized
  dir; path-traversal attempts are rejected.
- **AC7 No self-escalation (negative)**: the agent cannot self-grant a mutating capability; no
  management/connection-key is reachable via any HTTP API the agent can see — and it cannot even
  perceive that such a management key exists.
- **AC8 Auditable**: `GET /grants` + the audit trail show every grant (who/why/when/approved-by)
  and every invoke, all scoped to the dir; the owner can fully reconstruct what happened.
- **AC9 Remote posture**: the whole chain works with the agent treated as remote (loopback at
  minimum, ideally via a tunnel); the agent holds only the connection-key.
- **AC10 Reproducible**: one documented runner brings up Plexus with the seeded dir + the example
  DeepAgent, and drives both acts.

## 7. Deliverables
1. `workspace` first-party source (path-confined read/list/write; write PENDS).
2. `claudecode.run` sandboxed capability (OS sandbox + dir-confined + via-capability only).
3. **Plexus → DeepAgents skills-bundle emitter** + helper (compile capabilities to `SKILL.md`).
4. Example DeepAgent (persona + runner) under `examples/pomodoro-demo/`.
5. Seed materials (`refs/` + `me.md`).
6. A demo runbook (+ optional tunnel note).
7. E2E test driving both acts + verifying the acceptance criteria (incl. the confinement negatives).

## 8. Explicitly NOT doing
Tunnel/channel security; a non-skill (`@tool`) second variant; cross-platform (macOS only);
Hermes/OpenClaw-class autonomous-agent targets; hardening beyond the demo's confinement story
(but the directory confinement MUST be real, not faked).

## 9. Risks / verify-first
- **CC headless + OS sandbox is the linchpin** — verify `sandbox-exec` truly confines CC while CC
  still works, BEFORE building the capability around it.
- **DeepAgents skill-loading API** — confirm the exact `create_deep_agent` skills-loading + skill-
  script-execution mechanics against the real library when building.
- **CC headless reliability** for the pomodoro build — keep the task small & deterministic.
