# Agent Integration Project Scoping — no user-global writes

> **Decision record + operational spec.** Every per-agent injection (CC plugin
> registration, generic/codex launcher, AGENTS.md instruction block) lands in the
> **project the user runs their agent from** — never in a user-global location.
> `~/.plexus/**` (Plexus's own state home) is the only sanctioned home-dir write.
> The decision is **fixed** (owner-decided); this document records it and
> operationalizes it across the renderers, the repo-mode setup scripts, the
> verifiers/tests, and the docs.
>
> SSOT for the current mechanisms: [`cc-plugin-artifact-spec.md`](./cc-plugin-artifact-spec.md)
> (§2 install mechanics, §5 artifact skeleton), `packages/runtime/src/integration/render-plugin.ts`
> (renderInstallSh, renderLauncher "Bug B" rationale), `render-generic.ts` (renderSetupSh,
> renderGenericInstruction), and the empirical recon in the R1 fact sheet (cited below as
> **[recon]** — Claude Code 2.1.207 + codex-cli 0.144.1, isolated-lab verified; empirical
> wins over docs on conflicts).

## Sources of truth used

| # | Source | What it grounds |
|---|--------|-----------------|
| R1 | **[recon]** fact sheet (scratchpad `r1-recon-facts.md`, 2026-07-11) | CC scope semantics (`--scope local/project` write targets, machine registry is unconditional), `--plugin-dir` zero-persistence, `/reload-plugins`, codex AGENTS.md discovery + per-call `workdir` behavior, `-c developer_instructions` |
| R2 | `claude plugin … --help` output (2.1.207, read-only, captured 2026-07-11) | Exact CLI forms: `marketplace add --scope`, `install -s/--scope` (default `user`), `uninstall\|remove <plugin> --scope` (default `user`), `marketplace remove\|rm <name> --scope` (omit = every scope), `list --json` |
| R3 | `packages/runtime/src/integration/render-plugin.ts` / `render-generic.ts` / `verify-plugin.ts` | Current renderer behavior, the Bug B launcher rationale, Inv III/VI enforcement points |
| R4 | `integrations/{codex,generic}/setup.sh`, `integrations/codex/setup.md`, `integrations/README.md`, both `AGENTS.plexus.md` | Repo-mode defaults, instruction SSOTs, the `{{PLEXUS_CONSOLE_URL}}` substitution machinery |

---

## 1. Problem — three defaults inject Plexus user-globally

Each integration path today writes per-agent state into a **user-global** location by
default, so connecting one agent for one project mutates every project (and every
future agent session) on the machine. The three offending defaults, verbatim:

1. **CC plugin installed user-globally** — `render-plugin.ts` `renderInstallSh()`
   (step 4 of the emitted `install.sh`):

   ```bash
   if ! claude plugin marketplace add "$DIR" 2>/dev/null; then
   …
   if ! claude plugin install "$PLUGIN_NAME@$MARKETPLACE" --scope user 2>/dev/null; then
   ```

   `marketplace add` without `--scope` declares the marketplace at **user** scope
   (R2: user is the default), and the install is explicitly `--scope user` — the
   plugin (bound to ONE agent identity) becomes active in **every** project. The
   same `--scope user` form is repeated in the no-`claude` fallback echo and in the
   rendered `README.md` manual-install section.

2. **Global agent-bound `plexus` on PATH** — `render-generic.ts` `renderSetupSh()`:

   ```bash
   BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
   …
   cat > "$BIN_DIR/plexus" <<'PLEXUS_EOF_LAUNCHER'
   ```

   The launcher exports `PLEXUS_AGENT_ID=<agentId>` — a **global command named
   `plexus`, permanently bound to one agent's identity**. Repo-mode
   `integrations/codex/setup.sh` and `integrations/generic/setup.sh` do the same via
   `ln -sf "$shim" "$BIN_DIR/plexus"` with the same `~/.local/bin` default.

   This is a live self-contradiction: `render-plugin.ts`'s own launcher rationale
   (**Bug B**) exists precisely because *"a bare `plexus` on the Bash PATH is
   resolved by PATH order, so a global `plexus` … can shadow the plugin's own engine
   and authenticate as the WRONG agent"* — and `tests/d3-launcher-shadow-e2e.test.ts`
   simulates the attacker as *"exactly like the user's `~/.local/bin/plexus`
   shadowing the plugin."* **The generic path installs exactly the global,
   agent-bound `plexus` the CC path was engineered to defend against.**

3. **Global Codex instructions** — `integrations/codex/setup.sh`:

   ```bash
   AGENTS_FILE="${AGENTS_FILE:-$HOME/.codex/AGENTS.md}"
   ```

   The Plexus block lands in the user's **global** Codex instruction file by
   default, teaching *every* Codex session on the machine about one agent's
   integration. (The rendered generic `setup.sh` defaults to
   `$PLEXUS_HOME/AGENTS.plexus.md` — inside the sanctioned home, but a dead drop no
   agent discovers by itself; it too moves to the project default in §4.)

Confirmed blast radius on the reference machine [recon]: a user-scope
`plexus@plexus` install present since Jul 1; a `~/.local/bin/plexus` symlink since
Jun 23.

## 2. Decision & principle

**Status: Accepted (owner-decided, fixed). This document does not relitigate it.**

> **Principle.** Every per-agent injection lands in the **PROJECT** the user runs
> their agent from. **No user-global writes.** `~/.plexus/**` (Plexus's own state
> home) is the **only** sanctioned home-directory write. CC-managed machine state
> (`~/.claude/plugins/cache/`, `plugins/installed_plugins.json`,
> `plugins/known_marketplaces.json`) is Claude Code's own bookkeeping — it is
> written unconditionally regardless of scope [recon], acknowledged, documented,
> and out of our control. V1 e2e adds one more entry to that CC-managed
> inventory: on a `--scope local` install, Claude Code 2.1.207 itself writes
> `~/.config/git/ignore` (adding `**/.claude/settings.local.json`) — the served
> install.sh contains no such write.

Consequences, per path:

| Surface | Old default (global) | New default (project) |
|---|---|---|
| CC plugin registration | marketplace @ user scope + `install --scope user` | `--scope local` in `$PWD`, run from the project dir (`PLEXUS_CC_SCOPE` overridable to `project`) |
| CC ad-hoc | (undocumented) | `claude --plugin-dir ~/.plexus/plugins/plexus@<agentId>` — session-only, zero persistence [recon] |
| Generic/codex launcher | `~/.local/bin/plexus` (global PATH, identity-baked) | `~/.plexus/agents/<agentId>/bin/plexus` — inside the state home, NOT on PATH, no global name |
| Instruction block target | `~/.codex/AGENTS.md` (codex repo mode) / `$PLEXUS_HOME/AGENTS.plexus.md` (rendered) | `$PWD/AGENTS.md` (the project root where the setup command is pasted); `AGENTS_FILE=` override kept; `~/.codex/AGENTS.md` becomes explicit opt-in, never a default |
| Command the block teaches | bare `plexus` (assumes PATH) | the ABSOLUTE launcher path, via a new `{{PLEXUS_CMD}}` token |
| Plexus state home | `~/.plexus/**` | unchanged — engine, gateway pin, PATs, plugin artifacts, launchers all live here |

Why the paste-in-the-project-dir model works: the user copies ONE command from the
console and pastes it into a terminal **in the project they will run the agent
from**. `$PWD` at paste time *is* the project context — the same directory
`claude` and `codex` will treat as the project. No new questions are asked; the
one-command UX claim is preserved.

## 3. New Claude Code install flow (`render-plugin.ts` → `install.sh`)

Steps 1–3 of the emitted installer are **unchanged** (artifact materialization at
`${PLEXUS_HOME:-$HOME/.plexus}/plugins/plexus@<agentId>` from inline heredocs;
gateway pin; env→0600-scratch enrollment). The artifact stays an absolute-path
directory marketplace source. Step 4 (registration) is replaced.

### 3.1 New step 4 — project-context registration, executed from `$PWD`

```bash
# 4. Register + install into THIS project (the directory you pasted this command in).
PLEXUS_CC_SCOPE="${PLEXUS_CC_SCOPE:-local}"          # local | project (validated; anything else → fail loudly)
if [ "$PWD" = "$HOME" ]; then
  # loud warning (see §3.4) — proceed anyway, not fatal
fi
if command -v claude >/dev/null 2>&1; then
  if ! claude plugin marketplace add "$DIR" --scope "$PLEXUS_CC_SCOPE" 2>/dev/null; then
    claude plugin marketplace update "$MARKETPLACE" 2>/dev/null || true      # idempotent re-run
  fi
  if ! claude plugin install "$PLUGIN_NAME@$MARKETPLACE" --scope "$PLEXUS_CC_SCOPE" 2>/dev/null; then
    claude plugin update "$PLUGIN_NAME@$MARKETPLACE" 2>/dev/null || true     # idempotent re-run
  fi
  # migration hint (see §3.5) — detect a pre-existing USER-scope plexus@plexus, print a one-liner; never auto-remove
else
  # fallback echo (see §3.6) — project-scope form
fi
```

CLI forms verified against `--help` (R2): `marketplace add … --scope <scope>` with
scope ∈ user (default) | project | local; `install -s|--scope <scope>` same set,
default `user` — so **the scope flag must now always be passed explicitly**;
`--scope local` writes `<project>/.claude/settings.local.json`
(`extraKnownMarketplaces` + `enabledPlugins`), `--scope project` the same shape in
`<project>/.claude/settings.json` [recon]. Regardless of scope CC also copies the
plugin into `$CLAUDE_CONFIG_DIR/plugins/cache/…` and records it in
`plugins/installed_plugins.json` (v2 schema with `scope` + `projectPath`) — the
acknowledged CC-managed machine state [recon].

### 3.2 Why scope default = `local` (not `project`)

`local` (`.claude/settings.local.json`, conventionally git-ignored) is
**project-located but personal** — the correct posture, because committing the
registration (`project` scope, `.claude/settings.json`) would break teammates:

- the marketplace source embeds a **machine-absolute path**
  (`$HOME/.plexus/plugins/plexus@<agentId>`) that exists only on this machine;
- the enrollment is a **personal identity** — the plugin is compiled for one
  agent whose PAT lives in this user's `~/.plexus/agents/`.

`PLEXUS_CC_SCOPE=project` stays available for the user who owns that trade-off
(e.g. a solo repo where committing the settings is fine). `user` is **not** an
accepted value — the env knob cannot reintroduce the global default.

### 3.3 Env knobs (complete list)

| Knob | Default | Meaning |
|---|---|---|
| `PLEXUS_CC_SCOPE` | `local` | `local` \| `project` — which project settings file the registration lands in. Validated; `user` (or anything else) fails loudly. |
| `PLEXUS_HOME` | `$HOME/.plexus` | state home (unchanged; chmod 700 best-effort unchanged) |
| `PLEXUS_GATEWAY` | baked default | gateway pin override (unchanged) |
| `PLEXUS_ENROLL_CODE` | — | the one-time code riding the install command (unchanged) |

### 3.4 Output messages (the printed contract)

The installer prints, prominently:

1. **Where it landed**: `installed into project <abs $PWD> (scope: local — .claude/settings.local.json, personal, not committed)`.
2. **Activation**: `already inside a claude session in this project? run /reload-plugins to activate NOW (no restart)` — [recon] verifies `/reload-plugins` activates a newly project/local-installed plugin without restart, preserving the paste-one-command UX claim; otherwise the next `claude` session started in this project has it.
3. **Ad-hoc alternative**: `for a one-off session anywhere: claude --plugin-dir "$DIR"` — session-only, ZERO persistence [recon].
4. **`$HOME` guard** (before registration): when `$PWD` = `$HOME` exactly, print a loud warning that this will scope the plugin to your **home directory as a "project"**, and suggest `cd`-ing into the project first — then proceed (not fatal).

### 3.5 Migration hint (detect, suggest, never auto-remove)

If a pre-existing **user-scope** `plexus@plexus` is detected — probe
`claude plugin list --json` for `plexus@plexus`, and/or grep the recon-verified
scope source `$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json` (v2 entries carry
`scope`) [recon] — print exactly one line:

```
plexus install: a machine-global (user-scope) plexus@plexus from an older installer exists; consider removing it: claude plugin uninstall plexus@plexus --scope user
```

Uninstall form verified (R2): `claude plugin uninstall|remove [options] <plugin>`
with `-s, --scope <scope>` (default `user`) — so
`claude plugin uninstall plexus@plexus --scope user` is the correct explicit form.
The installer **never** removes it itself. (Whether `plugin list --json` includes
the scope field is unverified — the registry file is the verified source; settle at
implementation time.)

### 3.6 No-`claude` fallback echo + README

Both the fallback echo and the rendered `README.md` manual-install section switch
to the project-scope forms:

```bash
cd <your project>   # the project you run claude in
claude plugin marketplace add "$DIR" --scope local
claude plugin install plexus@plexus --scope local
```

plus the ad-hoc line: `claude --plugin-dir "$DIR"` (session-only). No emitted file
retains `--scope user` (structural guard, §5.2).

### 3.7 Same agent, second project

Re-paste the same install command in the other project dir (or run the two §3.6
commands there). The artifact dir, gateway pin, and PAT are shared state-home
facts; only the two settings keys are written per project. Idempotent by
construction (marketplace/install fall back to update).

**Verification point (V1 e2e must settle):** in the second project, `marketplace
add` may report the name as already registered (the machine registry
`known_marketplaces.json` is scope-independent [recon]) and fall through to
`marketplace update` — which refreshes content but may NOT write the second
project's own `extraKnownMarketplaces` declaration. The install still resolves
(the machine registry has the source), so the acceptance bar is: **project 2 ends
with a working `enabledPlugins` entry and a loadable plugin**; whether its
settings file also carries the marketplace declaration is a nice-to-have to be
recorded from the e2e, not assumed.

## 4. New generic / codex flow (`render-generic.ts` + repo-mode `setup.sh`)

### 4.1 Launcher relocation — kill the global `plexus` everywhere

The engine stays at `$PLEXUS_HOME/bin/plexus` (state home, shared across agents).
The launcher moves:

- **Old:** `${BIN_DIR:-$HOME/.local/bin}/plexus` — global PATH name, identity-baked.
- **New:** `$PLEXUS_HOME/agents/<agentId>/bin/plexus` — inside the state home,
  **NOT on PATH**, no global name to shadow. Launcher content is mechanically
  unchanged (exports `PLEXUS_AGENT_ID`, execs `$PLEXUS_HOME/bin/plexus` under
  node|bun).

This is the structural close of the Bug B contradiction (§1.2): per-agent identity
is carried by the **path** (`agents/<agentId>/bin/`) exactly as the CC plugin
carries it by the **name** (`plexus-<agentId>`). Two agents on one machine get two
launchers that cannot collide, and no PATH entry exists for a stale global
`plexus` to shadow or be shadowed by. `BIN_DIR` disappears from the rendered
setup.sh's vocabulary (repo mode keeps it as an explicit opt-in, §4.4).

### 4.2 `{{PLEXUS_CMD}}` — the instruction teaches the ABSOLUTE launcher path

Rationale [recon]: codex's harness encourages the model to set a per-call
`workdir` to subdirectories, so a project-relative command (`./.plexus/bin/…`)
is fragile; with PATH installation eliminated, **the absolute launcher path is the
robust command form**.

Mechanism — extend the existing `{{PLEXUS_CONSOLE_URL}}` substitution machinery
with a second token:

- `integrations/generic/AGENTS.plexus.md` (and the codex variant): every runnable
  `plexus <verb>` example becomes `{{PLEXUS_CMD}} <verb>`; prose that names "the
  `plexus` command on your PATH" is rewritten to teach the absolute command
  (positive framing — the block never mentions the retired PATH form).
- `renderGenericInstruction` fills `{{PLEXUS_CMD}}` with the absolute launcher
  path for that agent: `<plexusHome>/agents/<agentId>/bin/plexus`. This changes
  its signature — today it takes only `(gatewayBaseUrl, agentsMdPath?)` and is
  agent-agnostic; it gains the agent/launcher-path input, and its caller
  (`core/integration-endpoint.ts`) passes it. The **SSOT block file stays
  agent-agnostic**; the *filled* instruction becomes per-agent (it is already
  served per-agent under `/integration/:agentId`).
- **Home resolution**: the rendered `setup.sh` fills the token at **run time**
  from its own `$PLEXUS_HOME` (respecting an install-time override) via the same
  `sed` pattern repo-mode generic setup.sh already uses for the console URL. The
  copy-able instruction TEXT (mgmt JSON) is filled **server-side** from the
  gateway's resolved home — sound because gateway and agent share the machine
  (loopback). Determinism is preserved by making the home an explicit renderer
  input (tests inject a fixed one), exactly like `compileStamp`.

### 4.3 `AGENTS_FILE` default → `$PWD/AGENTS.md`

The rendered `setup.sh` (and both repo-mode scripts) land the block at
**`$PWD/AGENTS.md`** — the project root where the setup command is pasted. The
marker-guarded append/refresh mechanism (`<!-- BEGIN PLEXUS -->` … awk replace) is
unchanged; the `AGENTS_FILE=` override is kept. `~/.codex/AGENTS.md` is never a
default — it remains reachable only as an explicit
`AGENTS_FILE=~/.codex/AGENTS.md` opt-in, documented as "every codex session on
this machine" with the global-injection caveat.

Recon-verified sufficiency: project-root `./AGENTS.md` ALONE is enough — codex
discovery walks git-root→cwd and needs no global file [recon]. The setup output
message names the exact file written and that codex picks it up by itself. The
same `$PWD = $HOME` guard as §3.4 applies (warn, proceed).

### 4.4 Repo-mode `integrations/codex/setup.sh` + `integrations/generic/setup.sh`

Same two changes, plus one machinery addition:

1. `AGENTS_FILE="${AGENTS_FILE:-$PWD/AGENTS.md}"` (was `~/.codex/AGENTS.md` /
   `$PLEXUS_HOME/AGENTS.plexus.md`).
2. **No PATH install by default**: the `ln -sf … "$BIN_DIR/plexus"` symlink runs
   ONLY when the user explicitly sets `BIN_DIR=` (no default value). The default
   flow teaches the absolute repo shim path — `<repo>/integrations/codex/bin/plexus`
   (resp. `generic/bin/plexus`) — as the command, via the same `{{PLEXUS_CMD}}`
   fill.
3. `integrations/codex/setup.sh` currently copies its block **verbatim** (no
   substitution machinery) and `integrations/codex/AGENTS.plexus.md` hardcodes the
   console URL; adding `{{PLEXUS_CMD}}` means the codex script gains the same
   `sed` fill step generic setup.sh already has (and may as well adopt the
   `{{PLEXUS_CONSOLE_URL}}` token for symmetry — implementation's call).

### 4.5 Unchanged

`PLEXUS_HOME` layout and `chmod 700` best-effort; the gateway pin file; the
enrollment discipline (setup stays CODE-FREE + KEY-FREE; `enroll <code>` runs out
of band, now spelled `<abs-launcher> enroll <code>`); the engine heredoc
materialization.

## 5. Invariants preserved + new structural guards

### 5.1 Preserved — stated explicitly

- **Inv III (secret hygiene)** — unchanged. install.sh: the one-time code rides
  `$PLEXUS_ENROLL_CODE` → 0600 scratch → redeem → delete; setup.sh and the
  instruction stay code-free + key-free; no emitted file ever carries a PAT /
  code / connection-key. The scope/location changes touch no secret channel.
- **Inv VI (sanctioned auth core)** — unchanged. The engine is embedded
  byte-identical (verifier axis 1 + `assertEngineSourceSanctioned`); the launcher
  remains templated, secret-free shell; nothing model-authored.
- **Heredoc self-containment** — unchanged. Both bootstraps stay `curl … | bash`
  safe with collision-guarded terminators (`assertNoHeredocCollision`).
- **Determinism** — preserved. Same inputs → byte-identical output; the new home
  input to `renderGenericInstruction` is explicit (like `compileStamp`), and the
  rendered setup.sh's run-time fill is a pure function of its own env.
- **`assertVerified` / `assertGenericVerified`** — still gate every served
  artifact; axes 1–5 are untouched by this change (axis 4's install.sh checks —
  `PLEXUS_ENROLL_CODE`, engine-enroll, gateway pin — all survive verbatim).

### 5.2 New structural regression guards (cheap, deterministic)

Add to `assertGenericVerified` / `verifyPlugin` (or, minimally, to
`tests/integration-render-security.test.ts`) — rendered artifacts must **NOT**
contain:

1. `--scope user` — in any CC-emitted file (install.sh, README.md) or generic
   artifact;
2. `.local/bin` — the retired global-PATH location, in any emitted file;
3. `.codex/AGENTS.md` **as a default** — no emitted `AGENTS_FILE="${AGENTS_FILE:-…codex…}"`
   (the string may appear only in opt-in documentation prose, so pin the guard to
   the default-expansion form);

and must satisfy positively:

4. **token-fill completeness** — no `{{PLEXUS_` survives in the served
   *instruction text* (the setup.sh legitimately carries the token it fills at run
   time — the guard for setup.sh is that the `sed` fill step is present);
5. CC install.sh contains `--scope "$PLEXUS_CC_SCOPE"` and the `$PWD = $HOME`
   guard; generic setup.sh writes the launcher under
   `$PLEXUS_HOME/agents/$AGENT_ID/bin/`.

These are the same shape as the existing single-quoted-`*_DEFAULT` injection
guards in `integration-render-security.test.ts` — string-structural, no execution
needed.

## 6. Migration / cleanup appendix (machines that ran the OLD installers)

Never automated; printed as suggestions (§3.5) and documented here. All commands
verified against R2 help output where CLI-shaped.

```bash
# 1. Remove the machine-global CC install (old install.sh, --scope user):
claude plugin uninstall plexus@plexus --scope user
claude plugin marketplace remove plexus --scope user   # omit --scope to purge every scope (R2)

# 2. Remove the global agent-bound launcher (old generic/codex setup):
ls -l ~/.local/bin/plexus     # confirm it is Plexus's (heredoc launcher, or a symlink into integrations/*/bin/plexus)
rm -f ~/.local/bin/plexus

# 3. Remove the Plexus block from the global Codex instructions (old codex setup.sh default):
awk '/<!-- BEGIN PLEXUS -->/{skip=1;next} /<!-- END PLEXUS -->/{skip=0;next} !skip' \
  ~/.codex/AGENTS.md > ~/.codex/AGENTS.md.tmp && mv ~/.codex/AGENTS.md.tmp ~/.codex/AGENTS.md

# 4. KEEP ~/.plexus/** — engine, gateway pin, PATs, plugin artifacts: sanctioned state home.
#    (CC's own cache/registry under ~/.claude/plugins/ is CC-managed; `claude plugin uninstall`
#    maintains it — do not hand-edit.)
```

Then re-run the (new) install/setup command **from the project directory**.
Migration for connected agents needs no re-enrollment: PATs and the artifact dir
are unchanged; only registration location and the taught command form move.

## 7. Impact map

### 7.1 Renderers + endpoint

| File | Change |
|---|---|
| `packages/runtime/src/integration/render-plugin.ts` | `renderInstallSh` step 4 → §3.1 (scope knob, `$HOME` guard, migration hint, new messages, fallback echo); `renderReadme` manual section → §3.6 + `--plugin-dir` line; header comments |
| `packages/runtime/src/integration/render-generic.ts` | `renderSetupSh`: drop `BIN_DIR`, launcher → `$PLEXUS_HOME/agents/$AGENT_ID/bin/plexus`, `AGENTS_FILE` default → `$PWD/AGENTS.md`, run-time `{{PLEXUS_CMD}}` fill, `$HOME` guard; `renderGenericInstruction`: new signature (agent/launcher-path/home input) + `{{PLEXUS_CMD}}` substitution; header comments |
| `packages/runtime/src/integration/verify-plugin.ts` + `render-generic.ts` verifier (or `tests/integration-render-security.test.ts`) | new structural guards §5.2 |
| `packages/runtime/src/core/integration-endpoint.ts` | pass the new `renderGenericInstruction` inputs |
| `render-in-context.ts` | **unaffected** (fills from `PROTOCOL.md`, pure-HTTP form — no command, no PATH) |

### 7.2 Repo-mode integration files

| File | Change |
|---|---|
| `integrations/codex/setup.sh` | `AGENTS_FILE` default → `$PWD/AGENTS.md`; symlink only when `BIN_DIR` explicitly set; gain `sed` token fill (§4.4) |
| `integrations/generic/setup.sh` | same two changes; extend existing `sed` fill with `{{PLEXUS_CMD}}` |
| `integrations/generic/AGENTS.plexus.md` | all `plexus <verb>` → `{{PLEXUS_CMD}} <verb>`; PATH prose rewritten (§4.2) |
| `integrations/codex/AGENTS.plexus.md` | same; hardcoded console URL → token (optional, §4.4.3) |
| `integrations/codex/setup.md` | automatic-vs-manual table (`~/.local/bin`, `~/.codex/AGENTS.md` rows), manual path §1 symlink, "Per-project vs global" section inverted (project = default, global = opt-in) |
| `integrations/README.md` | "shared `plexus` command on PATH" framing (lines ~13/108–160) → absolute per-agent launcher; `~/.codex/AGENTS.md` global-first description (line 111) |
| `integrations/codex/README.md` (line ~40), `integrations/generic/README.md` (line ~62) | `~/.local/bin` PATH-warning lines |

### 7.3 Docs + site (grep hits for `~/.local/bin` / `--scope user` / `~/.codex/AGENTS.md` / "on(to) PATH")

| File | Hit |
|---|---|
| `docs/design/cc-plugin-artifact-spec.md` | §2.1 + §6.7 + appendix teach `--scope user` as the chosen default (lines 127/139/363/376) — update to record §3's local-scope decision (this doc becomes the scope SSOT) |
| `docs/tutorials/connect-an-agent.md` | line 154 `~/.local/bin` PATH hint |
| `site/guide/connect-an-agent.md` | lines 176/187 ("shared `plexus` command on PATH", "installs the `plexus` CLI on PATH"), 201–203 (repo-mode snippet + `~/.local/bin` hint), B1 bare `plexus enroll`/`plexus list` examples → absolute launcher form |
| `site/zh/guide/connect-an-agent.md` | lines 168–170 (same snippet) + the zh equivalents of the B0/B1 claims |
| `site/guide/create-an-extension.md` | line 28 "`plexus` is already on PATH" — review/reword (CC plugin `bin/` PATH is plugin-managed and stays true; the generic half of the sentence changes) |
| `site/guide/first-party-sources.md` | lines 28–29 are about the `claude`/`codex` CLIs being on PATH — **not ours, no change** |

### 7.4 Tests (assertions that will need updating)

| Test | Assertions affected |
|---|---|
| `tests/d2-install-e2e.test.ts` | line 245 `expect(log).toContain("plugin install plexus@plexus --scope user")` → `--scope local`; add `marketplace add … --scope local` assertion; run install.sh with cwd = a fake project dir; NEW cases: `PLEXUS_CC_SCOPE=project`, `$PWD=$HOME` warning, user-scope migration hint (stub registry) |
| `tests/integrations-generic-e2e.test.ts` | `binDir`/`BIN_DIR` plumbing (lines 62, 235) and landing-path assertions (244–254) → launcher at `$PLEXUS_HOME/agents/<id>/bin/plexus`; AGENTS_FILE default assertion → `$PWD/AGENTS.md` (cwd-controlled); instruction `{{PLEXUS_CMD}}`-filled absolute-path assertions |
| `tests/g1-template-render.test.ts` | install.sh content assertions (lines ~250+): scope strings, message strings; README manual-form assertion if present |
| `tests/d1-integration-endpoint.test.ts` | served setup.sh/instruction assertions (lines 353–446): token-filled command, no unfilled tokens |
| `tests/integration-render-security.test.ts` | ADD the §5.2 structural guards (natural home) |
| `tests/integrations-codex-e2e.test.ts` | drives the shim by bare name via PATH-prepend (line 140) → invoke by absolute shim path, mirroring what the block now teaches |
| `tests/d3-launcher-shadow-e2e.test.ts` | comment-only (line 118 cites `~/.local/bin/plexus` as the attack — now also historical); scenario stays valid |
| `tests/g3-verify.test.ts` | re-run; axis 1–5 tamper cases unaffected (axis 4's install.sh needles survive) |
| `tests/integration-form-switch-code.test.ts`, `tests/integration-legibility.test.ts`, `tests/integrations-cc-e2e.test.ts`, `tests/integrations-in-context-e2e.test.ts` | sweep for install/setup text or PATH assumptions; expected no-op or string-touch only |

## 8. Open items — explicitly deferred

1. **Codex ephemeral path** — `codex -c developer_instructions="…"` works in
   0.144.1 [recon] and is the natural session-only analogue of CC's
   `--plugin-dir` (zero file writes). Deferred: a future "ephemeral" delivery
   form; not part of this change.
2. **CC machine-global cache/registry** — `~/.claude/plugins/cache`,
   `installed_plugins.json`, `known_marketplaces.json` are written regardless of
   scope [recon]. CC's domain; we document, we do not fight it.
3. **`claude plugin update` scope interaction** — whether the idempotent
   `update` fallback needs/accepts a scope flag is unverified; settle from
   `claude plugin update --help` at implementation time.
4. **`claude plugin list --json` scope field** — SETTLED by V1 e2e (2.1.207):
   the JSON does carry `scope` (+ `projectPath`). The registry-file grep the
   installer ships remains fine; `list --json` is an equally valid probe.
5. **Instruction-fill home vs. remote-ish setups** — the server-side
   `{{PLEXUS_CMD}}` fill assumes gateway and agent share `$HOME` (true for the
   loopback product shape). If a split ever appears, the run-time fill in
   setup.sh is already the correct fallback.
6. **Cross-platform launcher paths** (Windows) — out of scope with the rest of
   the xplat seam.
