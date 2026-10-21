# Exec-source confinement — the `SandboxBackend` seam (P3-5)

> Status: **design + impl**. macOS (`sandbox-exec`) is verified on a real kernel; the Linux
> (`bwrap`) path is verified on a real Linux kernel in Docker (`tests/docker-linux-bwrap-jail.sh`).
> SSOT for the epic = `federated-mesh-domain-model.md`; the code map = `mesh-model.md §9`
> (P3-1 `{workspace, sysinfo}` allowlist, P3-5 Linux confinement). This doc covers the
> **platform/confinement seam only** — not the mesh wire.

## 0. Problem

The two exec sources — `codex` (`codex exec`) and `claudecode` (`claude -p`) — are the only
capabilities whose security boundary is a **kernel sandbox**, not pure path math. Plexus owns
that sandbox: it wraps the tool itself, with `sandbox-exec` (a seatbelt `.sb` profile) on macOS
and `bwrap` (bubblewrap) on Linux. The tool's own sandbox is not the boundary.

The seam must:
1. abstract "run this exec command confined to these paths/limits" so the launcher never calls
   `sandbox-exec` or `bwrap` directly;
2. ship two implementations — `DarwinSandboxBackend` (wraps the per-tool seatbelt profile) and
   `LinuxSandboxBackend` (builds an equivalent `bwrap` jail);
3. carry an **availability gate** so the exec sources are advertised **iff** a working kernel
   jail exists on the host, on every platform.

## 1. The owner's execution policy

Each exec source carries an owner-chosen **execution policy**, persisted as `execPolicy` next to
"Real launch" in `~/.plexus/source-settings.json` (`sources/config/settings.ts`,
`execPolicyFor`). The console setting wins; the env fallback is `PLEXUS_CC_EXEC_POLICY` /
`PLEXUS_CODEX_EXEC_POLICY` (`jail` | `host`); anything else reads as `jail`. Only the owner's
console or the connection-key-gated admin API (`PUT /admin/api/source-settings/:sourceId`) can
set it; agents never can. Every change is audited as `source.settings`. The launcher reads it
per call, and each run's audit records the policy it used.

| policy | what runs | what the run can reach |
| --- | --- | --- |
| `jail` (default) | the tool inside the kernel jail, after the canary (§4) passes | the authorized directory (reads, writes, temp files), the network, the tool's own login and configuration (readable, unchanged by the run), and the run's own session (writable, the owner's resume handle). The owner's other sessions are unreadable: Claude Code's transcripts, prompt history, pastes, file snapshots and auto-memory; Codex's rollouts, history, shell snapshots and, on macOS, its sqlite stores (§2, §3) |
| `host` | the tool unwrapped, exactly as the owner would start it in a terminal; no canary | everything the owner's user account can reach: files, credentials, network |

Under both policies the tool's environment is built from an allow-list, never inherited from the
gateway: the shell basics (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LC_*`, `TERM`,
`TZ`, `TMPDIR`), proxy and CA settings (`HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY` and their
lowercase forms, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`), and the tool's own
documented variables (Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`; Codex: `CODEX_HOME`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL`). `BASE_CHILD_ENV` and each tool's `env` in the launcher
table are the list. Nothing `PLEXUS_*`, no cloud credentials (an owner on Bedrock or Vertex runs
Claude Code under `host`, or not through Plexus), nothing the owner happened to export.

Inside the jail the tool's **own** sandbox is turned off — Claude Code via
`--settings '{"sandbox":{"enabled":false}}'`, Codex via `--sandbox danger-full-access` — because
nesting it inside the kernel jail breaks the tool's shell commands, and the kernel jail is the
boundary. Under `host`, Claude Code gets its native argv (no `--settings` override) and Codex
runs `codex exec --sandbox danger-full-access --skip-git-repo-check`.

The result's `isolation` field reports the policy to the calling agent without naming a host
path:

```json
{ "policy": "jail", "mechanism": "sandbox-exec",
  "scope": { "files": "authorized-dir", "temp": "authorized-dir",
             "network": "open", "toolState": "own-config-read-only" },
  "enforced": true }
```

Under `host` it is `mechanism: "none"`, `scope` all `host-user` (network `open`), and
`enforced: false`. `enforced` is true only for a jail run whose canary passed **and** whose tool
then launched inside the wrap; a record-mode run reports `false`. The contract lives in
`sources/exec-isolation.ts`.

## 2. The seam

```
packages/runtime/src/platform/sandbox-backend.ts
  ┌─ SandboxMechanism = "sandbox-exec" | "bwrap"
  ├─ interface SandboxBackend
  │    readonly mechanism: SandboxMechanism
  │    isAvailableSync(): boolean          // the availability gate (sync — registry build is sync)
  │    wrap(spec: SandboxSpec): { command: string; args: string[] }   // PURE
  ├─ DarwinSandboxBackend   (sandbox-exec)
  ├─ LinuxSandboxBackend    (bwrap)
  └─ selectSandboxBackend(platform): SandboxBackend
```

`SandboxSpec` is the OS-neutral description of one confined run:

| field | meaning | darwin uses | linux uses |
| --- | --- | --- | --- |
| `innerCommand`, `innerArgs` | the real binary + its args (`codex exec …` / `claude -p …`) | yes | yes |
| `jail` | the ONE authorized dir — the only broad **read-write** subtree | `-D JAIL=` | `--bind <jail> <jail>` |
| `cwd` | where the tool starts: the root or a confined sub-dir of it | spawn cwd | `--chdir <cwd>` |
| `homedir` | the real `$HOME` (Keychain and `~/.claude.json` live under it) | `-D HOMEDIR=` | — |
| `toolHome` | the tool's own state dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`; `$CODEX_HOME` or `~/.codex`) | `-D TOOL_HOME=` | via `toolState` |
| `tmpdir` | `TMPDIR`, pinned **inside** the jail (`<jail>/.tmp`) | env (launcher) | `--setenv TMPDIR` |
| `network` | network policy | implicit in profile (`allow network*`) | `--share-net` vs unshared |
| `profilePath` | the seatbelt `.sb` file (`cc-confine.sb` / `codex-confine.sb`) | `-f <profile>` | ignored |
| `params: {name,path}[]` | ordered named read-only mounts: `TOOL_BIN_DIR`, `TOOL_PKG_DIR`, `TOOL_INTERP_DIR` | `-D NAME=path` (profile references them by name) | `--ro-bind-try path path` |
| `toolState: {path,access}[]` | the tool's state entries and their access, **in bind order** | encoded in the profile by param name | `--bind-try` (rw) / `--ro-bind-try` (ro), in order |
| `roSystemDirs: string[]` | read-only OS dirs the tool needs to run | granted by the profile (`/usr /System …`) | `--ro-bind-try dir dir` |

The three `TOOL_*` params are the read-only grants the jail needs to exec the tool
(`resolveToolBinaryDirs` in `sources/exec-isolation.ts`): the dir holding the resolved binary
(symlinks followed), the install root or enclosing `node_modules`, and the script interpreter's
dir when the binary is a script. A param with no meaning for the tool points at the jail root, a
grant the jail already has.

The darwin backend emits
`sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D TOOL_HOME=.. -D TOOL_BIN_DIR=.. -D TOOL_PKG_DIR=.. -D TOOL_INTERP_DIR=.. <bin> <args>`.
The linux backend ignores `profilePath`/`params.name` and consumes the **paths** to build an
equivalent namespace jail.

`toolState` order matters on Linux: a later entry narrows or widens an earlier one.

| tool | `toolState`, in order |
| --- | --- |
| Claude Code | ro `~/.claude`, then each existing entry of `CC_PRIVATE_STATE` hidden (the owner's transcripts, prompt history, pastes, file snapshots, shell snapshots, plans, the auto-memory, other instances' keys: an empty tmpfs over a dir, `/dev/null` read-only over a file), then this run's transcript (the owner's `claude --resume <sessionId>` handle): on macOS rw `projects/<slug>/<sessionId>.jsonl` + `projects/<slug>/<sessionId>/` by name; on Linux rw `projects/<slug>/` then `projects/<slug>/memory/` hidden (pre-created, an empty tmpfs), then ro `~/.claude.json`. `<slug>` is the cwd with every character outside `[A-Za-z0-9]` replaced by `-`. The auto-memory (`memory/`, injected into the owner's future sessions) is never readable or writable |
| Codex | rw `$CODEX_HOME` (Codex hangs when it cannot write its sqlite state and logs), then each existing entry of `CODEX_PRIVATE_STATE` hidden (`history.jsonl`, `session_index.jsonl`, `sessions/`, `archived_sessions/`, `shell_snapshots/`, `log/`, `.tmp/`, `tmp/`, `generated_images/`: the owner's past threads and shell), then ro each of `config.toml`, `hooks.json`, `AGENTS.md`, `hooks/`, `plugins/`, `skills/`, `rules/`, `prompts/`, then ro each existing `memories_*.sqlite*` and `goals_*.sqlite*` (the cross-session stores Codex renders into future sessions; the seatbelt denies writing the two families by regex, and reading every `*.sqlite*` store; see the gap below for why Linux leaves them readable) |

## 3. The sandbox-exec → bwrap mapping

The seatbelt profile (`codex-confine.sb` / `cc-confine.sb`) is **deny-default + an allow-list of
subpaths**. `bwrap` is the dual: an **empty mount namespace + an explicit bind-list**. Both are
allow-lists — anything not named is invisible/denied at the kernel. That symmetry is what makes the
two backends *equivalent*, not merely *similar*.

| seatbelt (`.sb`) clause | meaning | bwrap flag(s) |
| --- | --- | --- |
| `(version 1) (deny default)` | nothing allowed unless listed | start from an empty namespace: `--unshare-all` (user+ipc+pid+net+uts+cgroup ns) |
| `(import "bsd.sb")` + `(allow process-exec*/process-fork)` | run/fork the tool | inherent in the new ns; `--die-with-parent` ties the jail's lifetime to the gateway |
| `(allow network*)` | reach the model API | `--share-net` (re-share net after `--unshare-all`); **omitted ⇒ no network** when `network:false` |
| `(allow file-read* (subpath "/usr") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/opt/homebrew") …)` | read-only OS dirs needed to run | `--ro-bind-try /usr /usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/etc`, `/opt`, `/usr/local` (`roSystemDirs`) |
| `(subpath (param "TOOL_BIN_DIR"))` / `TOOL_PKG_DIR` / `TOOL_INTERP_DIR` | read-only tool binary, package and interpreter dirs | `--ro-bind-try <path> <path>` (one per `params[]`) |
| cc: `(allow file-read* (subpath TOOL_HOME) (literal HOMEDIR/.claude.json))`, then `(deny file-read* …)` over `CC_PRIVATE_STATE`, then `(allow file-read* file-write* (literal CC_SESSION_FILE) (subpath CC_SESSION_DIR))` | Claude Code's login and configuration: readable; the owner's past sessions: unreadable; this run's transcript: read-write | `--ro-bind-try ~/.claude`, then `--tmpfs <dir>` / `--ro-bind /dev/null <file>` per existing private entry, `--bind-try ~/.claude/projects/<slug>`, `--tmpfs ~/.claude/projects/<slug>/memory`, `--ro-bind-try ~/.claude.json` (bwrap binds only existing nodes and Claude Code refuses a pre-created transcript, so Linux grants the slug dir; see the gap below) |
| codex: `(allow file-read* file-write* (subpath TOOL_HOME))`, then `(deny file-write* …)` over the protected entries and store families, then `(deny file-read-data …)` over `CODEX_PRIVATE_STATE` and every `*.sqlite*` | Codex's state: writable except what changes its behaviour; the owner's past threads: unreadable while this run still creates and appends its own (metadata stays, so `mkdir -p` and append work) | `--bind-try $CODEX_HOME`, then `--tmpfs <dir>` / `--ro-bind /dev/null <file>` per existing private entry, then `--ro-bind-try` each protected entry and existing `memories`/`goals` store; the other sqlite stores stay bound rw (see the gap below) |
| `~/Library/Keychains`, `user-preference-*` | macOS Keychain creds | **N/A on Linux** — no Keychain analog; creds live in the tool state dir, bound per `toolState` |
| `(allow file-read* file-write* (subpath (param "JAIL")))` | THE jail — the only broad rw | `--bind <jail> <jail>` (rw, hard — must exist) |
| `TMPDIR="$JAIL/.tmp"` (launcher, not the profile; Claude Code also gets `CLAUDE_CODE_TMPDIR`) | temp **inside** the jail | `--setenv TMPDIR <jail>/.tmp` |
| `/dev/null`, `/dev/urandom`, `/dev/tty`, `file-ioctl` | device nodes | `--dev /dev` (a minimal devtmpfs) |
| (the seatbelt runs in the host pid/proc) | — | `--proc /proc` (a fresh proc for the new pid ns) |
| `(deny default)` ⇒ `/tmp`, `$HOME/Documents`, … invisible | no blanket temp, no home read | NOT bound ⇒ absent in the ns; plus `--tmpfs /tmp` (private, empty), `--new-session` (detaches the controlling tty ⇒ no `TIOCSTI` injection) |

Concretely, a jailed `codex exec` run becomes:

```
bwrap \
  --die-with-parent --unshare-all --share-net --new-session \
  --ro-bind-try /usr /usr  --ro-bind-try /lib /lib  --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /bin /bin  --ro-bind-try /sbin /sbin --ro-bind-try /etc /etc \
  --ro-bind-try /opt /opt  --ro-bind-try /usr/local /usr/local \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind <JAIL> <JAIL> \
  --bind-try <CODEX_HOME> <CODEX_HOME> \
  --ro-bind-try <CODEX_HOME>/config.toml <CODEX_HOME>/config.toml \
  … (one --ro-bind-try per protected entry) … \
  --ro-bind-try <TOOL_BIN_DIR> <TOOL_BIN_DIR> \
  --ro-bind-try <TOOL_PKG_DIR> <TOOL_PKG_DIR> \
  --ro-bind-try <TOOL_INTERP_DIR> <TOOL_INTERP_DIR> \
  --setenv TMPDIR <JAIL>/.tmp \
  --chdir <CWD> \
  -- <abs/codex> exec --sandbox danger-full-access --skip-git-repo-check "<task>"
```

### Why this is a *real* kernel boundary, not a stub

- **It is the kernel, not the tool.** `bwrap` creates real Linux **namespaces** (mount + user + pid
  + ipc + uts + cgroup) via `unshare(2)`/`clone(2)`. A path not bound into the mount namespace
  **does not exist** for the process — `open()` returns `ENOENT`/`EACCES` from the kernel, exactly
  like the seatbelt's `Operation not permitted`. The tool cannot "ask nicely" to escape; there is
  no node in its namespace to reach. This is why the launcher may tell the inner tool to bypass *its
  own* approval prompts (`--dangerously-skip-permissions`) and turn *its own* sandbox off
  (`--settings '{"sandbox":{"enabled":false}}'` / `--sandbox danger-full-access`): Plexus's jail,
  not the tool's politeness, is the boundary.
- **No privilege re-acquisition.** bwrap drops into an unprivileged **user namespace** and (because
  we pass no `--cap-add`) sets **`PR_SET_NO_NEW_PRIVS`** — a setuid/fscaps binary inside the jail
  cannot gain privileges. (On hosts that ship a *setuid-root* bwrap instead of an unprivileged-userns
  one, the jail is built without a user namespace; the availability probe in §5 accounts for this —
  it concludes "available" only from a jail that actually ran a command, so either build path is
  detected correctly.) `--die-with-parent` guarantees the jail cannot outlive the gateway
  (no orphaned, un-reaped confined process). `--new-session` severs the controlling terminal so a
  confined process cannot inject into the parent's tty.
- **Same deny-default shape as darwin.** The jail starts empty and we add back *only* the
  allow-list above — the dual of `(deny default)` + `(allow …)`. The only broad **write** surface
  is the single `--bind <jail>`, plus the tool-state entries `toolState` marks `rw`; everything else
  is read-only or absent. A write outside them hits a read-only or non-existent mount ⇒ kernel
  denial.

This is the same security argument the seatbelt profile makes, expressed in the Linux primitive.

### Known Linux gap: a protected file that does not exist yet

`bwrap` can make only an **existing** node read-only (`--ro-bind-try` skips an absent path). For
Codex, Plexus creates the protected entries before binding them, with the content Codex treats
as "nothing configured": the dirs `hooks/`, `plugins/`, `skills/`, `rules/`, `prompts/` empty,
`config.toml` and `AGENTS.md` empty, and `hooks.json` as `{}` (codex 0.163 accepts `{}` silently
and warns "failed to parse hooks config … EOF while parsing a value" on an empty file). What
remains unshielded on Linux is a cross-session store file that does not exist yet (a next schema
version of `memories_<n>.sqlite`, a missing `-shm`): the launcher binds the files it finds, a
new one is creatable because `$CODEX_HOME` is writable. The seatbelt profile denies the write by
path and the store families by regex, so macOS has no such gap.

The owner's past Codex threads follow the same rule. On macOS the profile denies only
`file-read-data` on the private entries and on every `*.sqlite*` store, so the jailed Codex
still creates its rollout under `sessions/`, appends to `history.jsonl` and
`session_index.jsonl`, and runs with no handle on its sqlite stores (`codex exec resume <id>`
works from the rollout; verified on codex-cli 0.163.0). bwrap can only replace a node, so on
Linux a hidden dir is an empty tmpfs (the run's own rollout lands there and is discarded, so
the `sessionId` is not a resume handle on Linux) and a hidden file is `/dev/null` read-only
(the appends fail). The sqlite stores are not hidden on Linux: sqlite would open the `/dev/null`
replacement read-only as an empty database, the shape Codex hangs on, so `thread_history`,
`state`, `logs` and `queue` stay readable there. This Linux behaviour is covered by the bwrap
matrix with a fake tool, not by the real Codex binary.

The same limit shapes Claude Code's transcript grant. macOS hides all of `projects/` and grants
back exactly this run's `projects/<slug>/<sessionId>.jsonl` and `projects/<slug>/<sessionId>/`.
bwrap cannot bind a file that does not exist, and Claude Code refuses a pre-created transcript
("Session ID … is already in use"), so Linux mounts an empty tmpfs over `projects/`, binds
`projects/<slug>/` read-write on top of it, and mounts another empty tmpfs over
`projects/<slug>/memory/` (pre-created). The auto-memory and every other project's sessions are
hidden on both platforms; on Linux the other transcripts under the same slug (the sessions the
owner ran from the authorized directory) stay readable and writable.

## 4. The canary: every real launch proves the jail first

Under `jail`, before every real launch the launcher runs a canary (`runJailCanary` in
`sources/exec-isolation.ts`): `/bin/sh` under the **identical** wrap, cwd and env the tool will
get. It must:

1. write a file inside the jail's temp dir;
2. **fail** to write a file outside the authorized directory (checked on the host side, so a write
   that landed in a private tmpfs cannot fake a pass);
3. **fail** to read a file outside the authorized directory.

If any check fails, or the wrapper itself errors (a broken profile, a namespace that cannot be
built), the call fails with the reason and the tool never launches. There is no silent downgrade
to an unwrapped run. The canary's outcome goes to the owner's audit `detail` (`confinement.canary`),
never to the wire. Record mode (Real launch off) assembles and audits the argv without running the
canary or the tool, and reports `enforced: false`.

The unwrapped argv is reachable from exactly one place, `launchArgv(plan)` in
`sources/exec-launcher.ts`, and only with the literal `policy: "host"`; there is no boolean that
can be left false.

## 5. The availability gate (anti-"advertised but unjailed")

`bwrap` may be absent (not installed, or present-but-unusable — e.g. user namespaces disabled by
sysctl). `LinuxSandboxBackend.isAvailableSync()` probes it **synchronously** (registry build is
sync): resolve `bwrap` on `PATH`/canonical bin dirs (`X_OK`), then confirm it can **actually build
a jail** by having bwrap construct a minimal namespace and run a trivial command — equivalent to
`bwrap --ro-bind / / --unshare-user --unshare-net --die-with-parent true`, requiring exit 0. This
deliberately exercises `unshare(2)` rather than running `bwrap --version`: `--version` prints and
exits *without* touching namespaces, so on a host where unprivileged user namespaces are disabled
(`kernel.apparmor_restrict_unprivileged_userns=1`, `kernel.unprivileged_userns_clone=0`,
`user.max_user_namespaces=0`, hardened containers) a present-but-unusable non-setuid bwrap would
pass `--version` yet fail *every* real jailed invocation — the exact "advertised but unjailable"
state this gate exists to prevent. With the real probe such a host correctly reports **unavailable**
⇒ exec sources stay gated OUT (fail-closed). (A *setuid-root* bwrap can build the jail without an
unprivileged userns, so the test command still runs and exits 0 — the probe correctly reports
available, because we conclude "available" only from a jail that actually ran a command.) Both steps
are **injectable** so tests never depend on a real `bwrap` binary. `DarwinSandboxBackend.isAvailableSync()`
is `existsSync(/usr/bin/sandbox-exec)`.

The registry gate takes **one boolean**, consulted on **every** platform:

```
activeModulesForPlatform(platform, { execConfinementAvailable })
  linux:          { workspace, sysinfo }  (+ codex, claudecode iff execConfinementAvailable)
  darwin / win32: the full module set     (minus codex, claudecode unless execConfinementAvailable)
```

`createSourceRegistry(platform, opts?)` resolves the backend (`opts.sandbox ?? selectSandboxBackend`),
asks `isAvailableSync()`, and feeds the boolean to the gate. `{workspace, sysinfo}` stay always-on
on Linux. The allowlist remains an **allowlist**: a new first-party source defaults gated-OUT on
Linux until proven portable. On win32 the selected backend is the sandbox-exec one, which reports
unavailable, so the exec sources stay out.

When no working backend exists, the exec sources are **not scanned, not advertised**;
`.well-known` carries zero `codex.*` / `claudecode.*` caps; their ids stay RESERVED (anti-squat).
Nothing is advertised that cannot be jailed. The launcher re-checks `isAvailableSync()` before
every jailed launch and fails the call if the backend has gone away.

## 6. Routing the launchers through the seam

`claudecode.run` and `codex.run` share one launcher, `ExecLauncher` (`sources/exec-launcher.ts`).
Each tool is a table entry (`ExecToolSpec`: `CLAUDE_TOOL` in `sources/claudecode/launcher.ts`,
`CODEX_TOOL` in `sources/codex/launcher.ts`) naming its binary, seatbelt profile, state dir,
`toolState` mounts, jail and host args, and temp env. The launcher:
- takes an injected `sandbox?: SandboxBackend` (default = `selectSandboxBackend(platform)`),
- reads the owner's policy and Real-launch setting per call,
- under `jail`, builds the OS-neutral `SandboxSpec`, runs the canary, then spawns
  `sandbox.wrap(spec)`; under `host`, spawns the tool's host args directly,
- reports `isolation` on the result and the owner-only diagnostics (`policy`, `mechanism`,
  `argv` with the prompt masked, `confinement` with root, jail, homedir, toolHome, profile,
  binaryDirs and canary, `sessionId`) in the audit `detail`.

## 7. Test plan

Hermetic (no real `bwrap`):
- **registry/linux + bwrap available (mocked):** inject `PlatformServices{platform:"linux"}` and a
  `SandboxBackend` whose `isAvailableSync()` → `true`; assert the active set is
  `{workspace, sysinfo, codex, claudecode}`.
- **registry/linux + bwrap absent:** `isAvailableSync()` → `false`; assert exactly
  `{workspace, sysinfo}` and zero exec caps advertised.
- **registry/darwin without sandbox-exec:** the exec sources are gated out.
- **`LinuxSandboxBackend.wrap` argv:** the pure arg construction — `--unshare-all --share-net
  --die-with-parent --new-session`, `--bind <jail>`, `--ro-bind-try` for system + bin dirs, the
  `toolState` binds in order, `TMPDIR` inside jail, `--chdir <cwd>`, then `--` and the inner argv.
- **`DarwinSandboxBackend.wrap` argv:** `JAIL`, `HOMEDIR`, `TOOL_HOME`, then the params in order.
- **the isolation report, the canary and `launchArgv`** (`tests/exec-isolation.test.ts`).

On a real kernel (`tests/exec-jail-kernel.test.ts`, skipped when no backend is available): for
each tool, writes and reads outside the jail (including via symlink, `/tmp` and the system
`TMPDIR`) are held, the tool state access matches `toolState`, and a permissive or broken profile
fails the canary so the tool never runs. This suite runs on macOS under `sandbox-exec` and, through
`tests/docker-linux-bwrap-jail.sh`, under `bwrap` on a real Linux kernel (Ubuntu 22.04 in Docker,
with seccomp, AppArmor and the masked system paths lifted so `bwrap` can create its namespaces
and mount a fresh `/proc`). The permissive-profile and broken-profile cases are seatbelt-only.
