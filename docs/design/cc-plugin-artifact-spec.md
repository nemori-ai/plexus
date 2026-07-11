# Claude Code Plugin Artifact Spec — the compiled-skill target format

> **The target format the shipped CC-plugin renderer emits** (agent-skill-compilation,
> merged PRs #7/#8): precisely how a Claude Code plugin is structured, delivered, installed,
> and reloaded. It grounds the deterministic renderer (`packages/runtime/src/integration/`),
> the `GET /integration/:agentId` install endpoint, and the cold-CC blind acceptance path.
>
> SSOT: [`agent-skill-compile-domain-model.md`](./agent-skill-compile-domain-model.md)
> (§4 artifact, §5 bespoke flow, ADR-6/8, §6 acceptance).
>
> **Every structural claim below is verified against either a real working artifact in
> this workspace or official Anthropic docs.** Citations are inline.

## Sources of truth used

| # | Source | What it grounds |
|---|--------|-----------------|
| R1 | `integrations/claude-code/` (this repo) — the **already-shipping Plexus CC plugin** (`plugin.json` + `skills/use-plexus/SKILL.md` + `bin/plexus` shim). Driven E2E by `tests/integrations-cc-e2e.test.ts`. | Real minimal plugin; three-tier disclosure; `bin/` on PATH |
| R2 | A reference **ship-anywhere CC plugin** (external workspace) with a working `curl \| bash` one-command installer (`install.sh`) using the `claude plugin` CLI, plus `hooks/hooks.json`, `commands/`, `.claude-plugin/marketplace.json`. | One-command install; marketplace+install CLI; hooks schema |
| R3 | `packages/runtime/src/core/agent-enrollment.ts` (A1, already built) | PAT/code contract: `plx_enroll_…` → `POST /agents/enroll` → `plx_agent_…` |
| R4 | `packages/runtime/src/core/well-known.ts` (Floor, ADR-9) | `enrollmentUrl` + self-described redeem step |
| D1 | Official docs — [Plugins reference](https://code.claude.com/docs/en/plugins-reference) | Manifest schema, dir layout, `${CLAUDE_PLUGIN_ROOT}`, CLI, scopes |
| D2 | Official docs — [Create plugins](https://code.claude.com/docs/en/plugins) | `--plugin-dir`, `/reload-plugins`, `bin/` PATH, `official` marketplace non-interactive add |
| D3 | Official docs — [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) | `marketplace.json` schema, local-path source |

---

## 1. CC plugin package structure

### 1.1 The manifest — `.claude-plugin/plugin.json`

**Path is load-bearing and exact:** the manifest lives at `<plugin-root>/.claude-plugin/plugin.json`.
Only `plugin.json` goes inside `.claude-plugin/`; **every other component directory must be
at the plugin root, not inside `.claude-plugin/`** (D1, repeated as the #1 "common mistake").
The manifest is technically *optional* (components auto-discover in default locations, name
derives from the dir), but we always ship one for identity/version.

**Field set** (D1 "Complete schema"):

| Field | Req? | Notes |
|-------|------|-------|
| `name` | **the only required field** (if a manifest exists) | kebab-case, no spaces. This is the **skill namespace**: skills appear as `/<name>:<skill>`. |
| `version` | optional but **we set it** | Semantic version. **Setting it pins the cache key** — users only get updates when you bump it. If omitted, the git commit SHA is the version. (D1 "Version management") — decisive for our regenerate-on-change model (ADR-10). |
| `description` | optional | shown in the `/plugin` picker. |
| `author` | optional | `{ name, email?, url? }`. |
| `displayName`, `homepage`, `repository`, `license`, `keywords` | optional | metadata. |
| `defaultEnabled` | optional (v2.1.154+) | `false` ⇒ installs disabled. We want **`true`** (default) so a cold agent's install is active on next session. |
| `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles` | optional | custom component paths; **all must be relative and start with `./`**. We rely on default-location auto-discovery instead. |
| `userConfig` | optional | prompts the user at enable-time; sensitive values go to keychain. See §3 secret-hygiene note. |

Real, verified minimal manifest (R1, `integrations/claude-code/.claude-plugin/plugin.json`):

```json
{
  "name": "plexus",
  "version": "0.2.1",
  "description": "Use the user's local Plexus capability gateway …",
  "author": { "name": "Plexus" }
}
```

### 1.2 Component directories (all at plugin root, D1 "File locations reference")

| Dir/file | Purpose | Auto-discovered? |
|----------|---------|------------------|
| `skills/<name>/SKILL.md` | **Skills** — progressively-disclosed guidance. `<name>` = skill name (namespaced `/<plugin>:<name>`). May carry `reference.md`, `scripts/`, templates alongside. | **Yes**, by convention |
| `commands/<name>.md` | Skills as *flat* markdown files (legacy of `skills/`). Docs: "Use `skills/` for new plugins." | Yes |
| `agents/<name>.md` | Subagent definitions (frontmatter `name/description/model/…`). | Yes |
| `hooks/hooks.json` | Event handlers. | Yes |
| `bin/<exe>` | **Executables added to the Bash tool's `PATH` while the plugin is enabled.** Invokable as a bare command from any Bash tool call. (D1 File-locations table; D2.) **This is our call-script transport.** | Yes |
| `.mcp.json` / `.lsp.json` | MCP / LSP server configs. Plexus is **not** MCP (R1 README) → we ship neither. | Yes |
| `settings.json` | Plugin default settings (only `agent`/`subagentStatusLine` honored). Not needed. | Yes |
| `scripts/` | Convention dir for hook/utility scripts (referenced via `${CLAUDE_PLUGIN_ROOT}`). | referenced, not scanned |

> **`CLAUDE.md` at plugin root is NOT loaded as context** (D1). Plugins contribute context
> only through skills/agents/hooks. ⇒ all our guidance must live in a **SKILL**, never a README/CLAUDE.md.

### 1.3 Minimal concrete tree (verified against R1)

```
plexus@<agentId>/                    # plugin root (dir name carries identity)
├── .claude-plugin/
│   └── plugin.json                  # manifest — name, version (=compile stamp), description
├── skills/
│   └── use-plexus/
│       └── SKILL.md                 # the guidance layer (tier-2), frontmatter tier-1
└── bin/
    ├── plexus-<agentId>             # the per-agent launcher → joins Bash PATH (tier-3, the command)
    └── plexus                       # the plugin's OWN bundled, version-pinned engine (exec'd by the launcher)
```

`integrations/claude-code/` (R1) is the seed template — a bare `bin/plexus` shim driven by a real
E2E test, proof the three-file shape is sufficient. The **shipped renderer** emits the tree above:
the on-PATH command is the collision-proof **`plexus-<agentId>`**, which `exec`s the sibling
bundled engine (`bin/plexus`) by a path relative to itself. Two agents (or two versions) on one
host never collide, and the launcher never depends on a global `plexus` being present or correct.

### 1.4 SKILL.md frontmatter (verified R1 + D1)

`SKILL.md` = YAML frontmatter + markdown body. **All frontmatter fields are optional.** The
ones we use plus the full superset (D1 `/en/skills` §"Frontmatter reference", cross-checked
against R1's working plugin):

- `name` — skill invocation name (falls back to dir basename; **set it explicitly** so it
  is stable regardless of install dir — D1 §"Path behavior rules").
- `description` — **always-in-context** trigger text (tier-1). Claude reads only this until
  the skill fires. Write it as *"Use when …"*. (Verified in R1 and every R2 SKILL.)
- `allowed-tools` — pre-approves tools while the skill is active. R1 sets `allowed-tools: Bash`
  (the skill only needs to run the `plexus` binary). Verified spelling (kebab-case) in R1.
- Other available fields (D1 skills ref, not needed by v1 but noted for G1): `when_to_use`,
  `argument-hint`, `arguments`, `disable-model-invocation` (user-only), `user-invocable`,
  `disallowed-tools`, `model`, `effort`, `context: fork` + `agent`, `hooks`, `paths` (glob-gate
  activation), `shell`.

---

## 2. Install + reload mechanics

Four ways to get a plugin active. Only one satisfies ADR-8's **copy-able, one-command,
unattended** requirement for a cold agent.

| Mechanism | Command | Persists across sessions? | Unattended one-liner? |
|-----------|---------|:--:|:--:|
| **A. `--plugin-dir` (local dev)** | `claude --plugin-dir ./plexus` | No (that session only) | No — must relaunch `claude` with the flag |
| **B. `--plugin-url` (session)** | `claude --plugin-url https://…/plexus.zip` | No (that session only) | No |
| **C. skills-dir plugin** | drop dir w/ `.claude-plugin/plugin.json` into `~/.claude/skills/<name>/`; loads as `<name>@skills-dir` next session | Yes | Partial — just a copy, but see caveat below |
| **D. marketplace + install (CLI)** | `claude plugin marketplace add <dir> --scope local` → `claude plugin install <name>@<mkt> --scope local` | **Yes** | **Yes ✅** |

### 2.1 The chosen mechanism: local-marketplace + `claude plugin install` (D)

This is exactly what the R2 reference plugin's `install.sh` does today (verified working) and it is the
**only** path that is both durable and fully scriptable/non-interactive. The two commands:

```bash
# run both from the PROJECT DIRECTORY you use claude in — the registration is project-scoped
# 1. register a marketplace from a LOCAL DIRECTORY that contains .claude-plugin/marketplace.json
claude plugin marketplace add /abs/path/to/plexus-cc-plugin --scope local   # needs an ABSOLUTE path (R2 line 203)

# 2. install the plugin by <plugin>@<marketplace>, non-interactive
claude plugin install plexus@plexus --scope local
```

- A **local directory can serve as a marketplace** iff it has `.claude-plugin/marketplace.json`
  (D3). So the compiled artifact is *itself* a one-plugin marketplace (self-hosting — mirrors
  the R2 reference plugin, whose zip's top level is the plugin root carrying both `plugin.json` and
  `marketplace.json`; R2 line 201 asserts `marketplace.json` presence as the validity check).
- `--scope` ∈ `user` | `project` | `local` (D1 "plugin install"). **Plexus registers at `local`
  scope** — `<project>/.claude/settings.local.json`, project-located but personal (conventionally
  git-ignored); `PLEXUS_CC_SCOPE=project` opts into committing the registration
  (`.claude/settings.json`). The scope decision, its rationale, and the env knob are recorded in
  [`agent-integration-project-scope.md`](./agent-integration-project-scope.md) §2–§3 — the scope SSOT.
- **Idempotent** re-run: if already added/installed, use `claude plugin marketplace update <mkt>`
  + `claude plugin update <plugin>@<mkt>` (R2 lines 207-222 show the exact idempotent guard).
- **Requires the `claude` CLI on PATH** (R2 requires ≥ v2.1.195 for these subcommands). If absent,
  fail loudly — E2E-CC must ensure the cold instance has it.

### 2.2 Reload / activation semantics (D1/D2 — the E2E-critical facts)

- After `claude plugin install`, the plugin is written to `enabledPlugins` and **becomes active
  on the next session start.** A running session must **reload**.
- In-session reload: **`/reload-plugins`** reloads plugins, skills, agents, hooks, plugin MCP/LSP
  servers *without restarting* (D2, verified). A full `claude` restart also works.
- **`bin/` on PATH**: while the plugin is enabled, `bin/` is prepended to the **Bash tool's PATH**
  automatically (D1 File-locations; D2). No wiring — the skill just calls `plexus …` (R1 proves this).
- `${CLAUDE_PLUGIN_ROOT}` = absolute path to the plugin's install dir; use it inside hook/MCP
  commands to reference bundled scripts. **It changes on update** — do not persist state there
  (use `${CLAUDE_PLUGIN_DATA}` for that). (D1 "Environment variables".)

> **Acceptance mapping (§6 / E2E-CC):** "install → reload → works" = run the two §2.1 commands →
> `/reload-plugins` (or the cold instance's first session start) → the `use-plexus` skill is in
> context and `plexus <cap>` runs over Bash. This is the exact sequence R1's E2E test already
> drives against a live gateway (minus enrollment, which §3 adds).

---

## 3. How the one-time enrollment code rides along

The install command must carry the one-time code (ADR-8) so the skill can, on first run, redeem
it (`POST /agents/enroll` → PAT — R3) and self-store the PAT — **without baking any long-lived
secret into the distributed artifact** (Inv III/VI). The code IS short-lived and single-use, so
it is *not* a long-lived secret; the durable PAT must never be in the artifact.

### 3.1 The A1 contract (verified R3 + R4)

```
mint (admin)            plx_enroll_<256b>   one-time, 15-min TTL, single-use     (agent-enrollment.ts)
redeem (first run)      POST /agents/enroll  { "code": "plx_enroll_…" }          (body field name `code` is load-bearing — R4 line 94)
        → success       { "pat": "plx_agent_<256b>", "agentId": "<id>" }         returned EXACTLY ONCE (R3 line 24)
call (every session)    present PAT at handshake  → binds session to real agentId
```

The Floor **self-describes** all of this at `.well-known/plexus` → `auth.enrollment`
(R4 lines 95-104: `url`, `method`, `auth: "body.code"`, `success.pat`, `errorCodes`, and a
`patStorage` instruction: *"Store the returned PAT yourself … e.g. an .env file … returned only
ONCE"*). This means the skill's redeem logic can be a thin, deterministic, Floor-verifiable call
(Inv VI) and a skill-less agent can do the same from the Floor alone (ADR-9 fallback).

### 3.2 How the code is passed to the skill — recommended: **install-arg → scratch file the skill reads once then deletes**

The delivered one-liner is copy-able and self-contained. The cleanest, secret-hygienic shape:

```bash
# ── the copy-able ONE-COMMAND install (D1-ENDPOINT serves this string) ──
curl -fsSL https://127.0.0.1:7077/integration/claude-code/install.sh \
  | PLEXUS_ENROLL_CODE="plx_enroll_ab12…" bash
```

The installer script (the artifact's `install.sh`, modeled on R2) does §2.1's marketplace-add +
install, and **additionally** drops the code into a **scratch enrollment file** the skill will
read exactly once:

```
$PLEXUS_HOME/enroll-code            # e.g. ~/.plexus/agents/<agentId>.enroll  (mode 0600)
  contents: plx_enroll_ab12…        # ONLY the short-lived code, never a PAT
```

Then on first skill invocation, the templated redeem step (Inv VI) does:

1. If a PAT already exists (see §3.3) → skip enrollment, use it.
2. Else read the scratch code file → `POST /agents/enroll {code}` → receive `plx_agent_…`.
3. **Write the PAT** to its store (§3.3), then **`rm` the scratch code file** (one-shot; the code
   is already consumed server-side and now useless — deleting removes the on-disk copy too).

**Why this shape (trade-offs):**

- **install-arg / env var (`PLEXUS_ENROLL_CODE=…`)** — simplest to template into the one-liner.
  Trap: an env var passed on a piped `bash` invocation is visible in that process' environment
  and *may* land in shell history if the user pastes it literally. It is a 15-min single-use
  code, so exposure risk is bounded, but prefer **not** echoing it and **not** persisting it in
  a shell rc.
- **scratch file (chosen for the code→skill handoff)** — decouples "install ran (admin/shell
  context)" from "skill redeems (agent/session context)". The skill can't read the installer's
  env, so a **file the installer writes and the skill consumes-then-deletes** is the reliable
  cross-process channel. Keep it `0600`, under `~/.plexus/`, and **delete on redeem**.
- **Do NOT** put the code (or ever the PAT) inside the plugin artifact/manifest — the artifact is
  distributable and cacheable (`~/.claude/plugins/cache`); anything in it is not a secret (Inv III/VI).

### 3.3 Where the redeemed PAT should live

Per the Floor's own `patStorage` guidance (R4) and ADR-4 ("matches the operator's `.env` mental
model"): the agent self-stores the PAT **in its own paradigm**. Recommended default, consistent
with the existing gateway convention of a `~/.plexus/` home (R3 ledger at
`~/.plexus/agent-enrollments.json`; connection-key at `~/.plexus/connection-key`):

- **Primary:** `~/.plexus/agents/<agentId>.pat` (mode `0600`), or a project-local `.env`
  (`PLEXUS_PAT=plx_agent_…`) when the agent's paradigm is project-scoped. The `plx_agent_` prefix
  is deliberately greppable/operator-legible (R3 line 64).
- The skill's guidance (tier-2 prose) tells Claude *where it put the PAT and how to reuse it*,
  but the **read/redeem mechanics are templated** (Inv VI), not improvised.

### 3.4 Secret-hygiene traps to flag for G1-TEMPLATE / E2E-CC

1. **Never** template the PAT into any artifact file — only the transient code is ever handed over,
   and only via the scratch-file/env channel, never inside the plugin dir.
2. **Delete the scratch code file on redeem** (and it's harmless afterward — single-use server-side).
3. `~/.claude/plugins/cache` copies marketplace plugins verbatim; treat the whole plugin dir as
   **world-readable distributable** — zero secrets in it.
4. **`userConfig` with `sensitive:true`** (D1) is an *alternative* PAT/code store: masks input and
   writes to the OS keychain (`~/.claude/.credentials.json` fallback, ~2 KB limit). Tempting, but
   it (a) prompts the user interactively at enable-time → **breaks unattended install**, and (b)
   couples the secret to CC's config rather than "the agent's own paradigm." **Recommend against it
   for v1**; note it as a possible v2 hardening. ⚠ The keychain-storage detail is from D1; not
   independently tested here.
5. `${CLAUDE_PLUGIN_ROOT}` changes on update and its old copy lingers ~7 days — never write the
   PAT there; use `~/.plexus/` (or `${CLAUDE_PLUGIN_DATA}` if a plugin-scoped store is ever wanted).

---

## 4. Three-tier progressive disclosure in CC terms (SSOT §4)

| Tier | SSOT description | Concrete CC mechanism | Enters agent context? | Verified by |
|------|------------------|-----------------------|:--:|---|
| **1 — one-liner always in context** | always-present pointer | `SKILL.md` **frontmatter `description`** (+ the `/<plugin>:<skill>` listing) | **Always** (cheap, always loaded) | R1 frontmatter; D1 "always-on" token model |
| **2 — skill body on drill-in** | guidance incl. agent-native key-mgmt advice | `SKILL.md` **markdown body** (+ optional `reference.md`, templates alongside) | **Only when the skill fires** | R1 body; D2 progressive disclosure |
| **3 — launcher whose internals never enter context** | thin encapsulated `redeem→PAT→handshake→token→invoke` | **`bin/plexus-<agentId>` on the Bash PATH** — the agent runs `plexus-<agentId> <cap>`; the auth/invoke plumbing lives inside the bundled engine and is never read into the model | **Never** (only stdout/stderr of a call surfaces) | shipped renderer (`plexus-<agentId>` launcher → bundled engine); D1 `bin/` PATH |

This is the "eat the ugliness" mapping (ADR-6): tier-3 is a **per-agent launcher on PATH**, so the
agent sees a native command and the entire auth chain stays out of context — and it is exactly
where the deterministic, Floor-verifiable auth core (Inv VI) is rendered. The launcher's verbs are
**`enroll`** (first-run code→PAT), **`list`** (callable-now vs needs-approval discovery), and
**`<capabilityId>`** (invoke). The SKILL teaches this as the agent's **only** interface — never
hand-roll HTTP against the gateway, never guess an auth header, never mint or read a token.

---

## 5. Recommended concrete artifact skeleton (for G1-TEMPLATE)

Directory tree the renderer emits per agent-integration. Marked **[T]** = deterministically
templated from the Floor + cap-set (Inv VI, machine-verifiable against `.well-known`); **[P]** =
hand-authored per-agent-type prose (the pedagogical shell, ADR-6/7 — same for every integration,
not per-user); **[S]** = static, copied verbatim.

```
plexus@<agentId>/                         # compiled artifact = a self-hosting one-plugin marketplace
├── .claude-plugin/
│   ├── plugin.json              [T]      # name "plexus", version = compile stamp (pins cache → ADR-10)
│   └── marketplace.json         [T]      # one-plugin marketplace; { name, owner, plugins:[{name:"plexus", source:"./"}] }
├── skills/
│   └── use-plexus/
│       ├── SKILL.md             [P]+[T]  # body = per-type prose [P]; frontmatter description + the
│       │                                 #   granted-cap quick-list + enrollment note = templated [T]
│       └── reference/           [T]      # (optional) per-cap io/requestShapes cheat-sheets from Floor
├── bin/
│   ├── plexus-<agentId>         [T]+[S]  # the per-agent launcher (the ONE command the SKILL teaches);
│   │                                     #   execs the sibling bundled engine relative to itself; verbs: enroll|list|<cap>
│   └── plexus                   [S]      # the plugin's OWN bundled, version-pinned engine (auth/invoke CORE);
│                                         #   encapsulates redeem→PAT→handshake→token→invoke, byte-verified vs the sanctioned engine
├── install.sh                   [T]      # the one-command installer (§2.1 + §3.2); code injected via env→scratch file
└── README.md                    [S]      # human doc (NOT loaded as context — D1); optional
```

**What each file is for:**

- `plugin.json` **[T]** — identity + **`version` set to the compile stamp** so a regenerated skill
  is seen as a new version (ADR-10 regenerate-on-change; D1 version-as-cache-key).
- `marketplace.json` **[T]** — makes the dir installable via `claude plugin marketplace add <dir>`
  (D3). Minimal: `{ "name": "plexus", "owner": {"name":"Plexus"}, "plugins":[{ "name":"plexus",
  "source":"./", "description":"…" }] }` (schema verified R2 + D3; `source:"./"` = plugin root = the dir itself).
- `skills/use-plexus/SKILL.md` **[P]+[T]** — tiers 1+2. Prose is per-type best-practice **[P]**;
  the granted-cap list, ids, input-shapes, and the enrollment/key-storage pointer are filled from
  the Floor + cap-set **[T]**. **Verifier gate (build-time, Floor as oracle):** asserts the skill
  references only granted caps and cites the sanctioned redeem→PAT flow, never a baked secret.
- `bin/plexus-<agentId>` + `bin/plexus` **[T]+[S]** — tier-3. The launcher (`plexus-<agentId>`) is
  the ONE command the SKILL teaches; it `exec`s the sibling **bundled engine** (`bin/plexus`) by a
  path relative to itself and injects the baked `PLEXUS_AGENT_ID`. The engine is the **auth/invoke
  core** (`redeem → PAT → handshake → scoped-token → invoke`), byte-verified against the sanctioned
  engine and never LLM-authored (Inv VI). **The engine is bundled inside the plugin dir** — the
  artifact never reaches outside itself, so it works verbatim from `~/.claude/plugins/cache` (D1
  "Path traversal limitations") and does not assume a sibling repo path or a global `plexus`. (This
  is the resolution of what was the biggest cold-install unknown — see §6.)
- `install.sh` **[T]** — the copy-able one-liner's target (§2.1 marketplace-add+install, idempotent
  like R2), plus writing the enrollment code to the `0600` scratch file (§3.2).

**Hand-authored template library** (per SSOT §1 "Template library"): the `[P]` prose of
`SKILL.md` and the `[S]` skeleton of `bin/plexus` are the CC-type template; G1-TEMPLATE fills the
`[T]` holes deterministically. R1 (`skills/use-plexus/SKILL.md` + `bin/plexus`) is the concrete
seed template to start from.

---

## 6. Cold-install facts (how the shipped path behaves)

The blind cold-CC acceptance passes, so the items that were once open risks are settled. They are
kept here as the operational facts a maintainer still needs to hold.

1. **`claude` CLI presence + version.** The install path needs the `claude` CLI on PATH at
   **≥ v2.1.195** for `plugin marketplace add`/`install` (R2). The installer preflight-checks
   `claude --version` and fails loudly rather than silently no-op'ing; the fallbacks are
   `--plugin-dir` (session-only) or a skills-dir drop (C).
2. **Engine dependency — RESOLVED (bundled per-agent launcher).** The artifact ships its own
   version-pinned engine at `bin/plexus`, `exec`'d by the on-PATH launcher `plexus-<agentId>` via a
   path relative to itself. Nothing reaches outside the plugin dir, so it runs verbatim from
   `~/.claude/plugins/cache` (D1 path-traversal) and assumes neither a sibling repo path nor a
   global `plexus`. This retired what had been the highest-risk cold-install unknown.
3. **Reload timing in a headless/`-p` run.** `install` writes `enabledPlugins`, active next session
   start; `/reload-plugins` is interactive. The cold path is modeled as *install → NEW `claude`
   session → work*, not *install → reload mid-session*.
4. **Scratch-code handoff.** The installer writes the `0600` scratch code file *before* printing
   success, and the launcher's `enroll` step surfaces a clear
   `unknown_code`/`code_expired`/missing-file error (Floor `errorCodes`, R4) if it is absent.
5. **15-minute code TTL.** `plx_enroll_` expires in 15 min (R3); the cold path redeems promptly and
   the admin can re-mint on expiry (ADR-4 lost-PAT re-issue).
6. **Namespaced skill invocation.** Plugin skills are `/<plugin>:<skill>`; auto-firing depends on
   the `description` trigger, which the blind test verifies actually fires on a relevant prompt (not
   just that the plugin is installed).
7. **`--scope` correctness.** The installer registers into the project it is run from —
   `--scope local` by default, `PLEXUS_CC_SCOPE=project` to commit the registration instead
   (scope SSOT: [`agent-integration-project-scope.md`](./agent-integration-project-scope.md)).
   The installer asserts `claude plugin list` shows the plugin after install (R2).

---

## Appendix — copy-paste command reference (all verified)

```bash
# Local dev / fast iteration (session-only, NOT persistent) — D2
claude --plugin-dir ./plexus@<agentId>

# Persistent unattended install (the ADR-8 path) — R2 + D1/D3.
# Run from the project dir; scope SSOT: agent-integration-project-scope.md (local = .claude/settings.local.json)
claude plugin marketplace add /abs/path/to/plexus@<agentId> --scope local   # dir must hold .claude-plugin/marketplace.json
claude plugin install plexus@plexus --scope local              # <plugin>@<marketplace>
# idempotent refresh:
claude plugin marketplace update plexus
claude plugin update plexus@plexus
# verify + debug:
claude plugin list --json | grep 'plexus@plexus'
claude plugin validate ./plexus@<agentId> --strict
claude --debug            # shows plugin load + skill/hook registration

# In-session reload after edits (interactive) — D2
/reload-plugins

# Enrollment redeem (what the templated tier-3 core does) — R3/R4
curl -fsX POST http://127.0.0.1:7077/agents/enroll \
  -H 'content-type: application/json' -d '{"code":"plx_enroll_…"}'
# → { "pat":"plx_agent_…", "agentId":"…" }   (store PAT 0600; delete the scratch code)
```
