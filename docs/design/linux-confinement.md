# Linux exec-source confinement — the `SandboxBackend` seam (P3-5)

> Status: **design + impl** (the deferred P3-5 follow-on of the federated-mesh epic).
> SSOT for the epic = `federated-mesh-domain-model.md`; the code map = `mesh-model.md §9`
> (P3-1 `{workspace, sysinfo}` allowlist, P3-5 Linux confinement). This doc covers the
> **platform/confinement seam only** — not the mesh wire.

## 0. Problem

The two exec sources — `codex` (`codex exec`) and `claudecode` (`claude -p`) — are the only
capabilities whose security boundary is a **kernel sandbox**, not pure path math. Today that
boundary is macOS `sandbox-exec` (a seatbelt `.sb` profile), invoked inline by
`sources/codex/launcher.ts` + `sources/claudecode/launcher.ts`. `sandbox-exec` is a macOS-only
primitive: it has **no Linux equivalent**. So P3-1 gates both exec sources **OUT** of the active
registry on Linux (anti-"advertised but unjailed"): a Linux gateway advertises only
`{workspace, sysinfo}`.

P3-5 lifts that gate **only when a real Linux kernel jail exists** — `bwrap` (bubblewrap). The
seam must:
1. abstract "run this exec command confined to these paths/limits" so the launcher stops calling
   `sandbox-exec` directly;
2. ship two implementations — `DarwinSandboxBackend` (wraps the **unchanged** seatbelt profile)
   and `LinuxSandboxBackend` (builds an equivalent `bwrap` jail);
3. carry an **availability gate** so that on Linux, exec sources re-activate **iff** a working
   `bwrap` is present — and stay gated OUT (today's behavior) when it is absent.

## 1. The seam

```
packages/runtime/src/platform/sandbox-backend.ts
  ┌─ SandboxMechanism = "sandbox-exec" | "bwrap"
  ├─ interface SandboxBackend
  │    readonly mechanism: SandboxMechanism
  │    isAvailableSync(): boolean          // the availability gate (sync — registry build is sync)
  │    wrap(spec: SandboxSpec): { command: string; args: string[] }   // PURE
  ├─ DarwinSandboxBackend   (sandbox-exec — behavior UNCHANGED)
  ├─ LinuxSandboxBackend    (bwrap)
  └─ selectSandboxBackend(platform): SandboxBackend
```

`SandboxSpec` is the OS-neutral description of one confined run:

| field | meaning | darwin uses | linux uses |
| --- | --- | --- | --- |
| `innerCommand`, `innerArgs` | the real binary + its args (`codex exec …` / `claude -p …`) | yes | yes |
| `jail` | the ONE authorized dir — the only broad **read-write** subtree; also the `chdir` target | `-D JAIL=` | `--bind <jail> <jail>` + `--chdir` |
| `homedir` | the real `$HOME` (config/creds live under it) | `-D HOMEDIR=` | base for default config dirs |
| `tmpdir` | `TMPDIR`, pinned **inside** the jail | env (launcher) | `--setenv TMPDIR` |
| `network` | network policy | implicit in profile (`allow network*`) | `--share-net` vs unshared |
| `profilePath` | the seatbelt `.sb` file | `-f <profile>` | ignored |
| `params: {name,path}[]` | ordered named read-only mounts (`CODEX_BIN_DIR` / `CLAUDE_BIN_DIR` / `PLUGIN_DIR`) | `-D NAME=path` (profile references them by name) | `--ro-bind-try path path` |
| `configDirs: string[]` | dirs the tool must **write** (`~/.codex`, `~/.claude`) | granted by the profile | `--bind-try dir dir` (rw) |
| `roSystemDirs: string[]` | read-only OS dirs the tool needs to run | granted by the profile (`/usr /System …`) | `--ro-bind-try dir dir` |

The darwin backend consumes `profilePath` + `jail`/`homedir` + the **named** `params`, emitting the
**exact** argv `buildSandboxedArgv` produced before this seam existed — so darwin behavior is
byte-for-byte unchanged. The linux backend ignores `profilePath`/`params.name` and consumes the
**paths** to build an equivalent namespace jail.

## 2. The sandbox-exec → bwrap mapping

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
| `(subpath (param "CODEX_BIN_DIR"))` / `CLAUDE_BIN_DIR` / `PLUGIN_DIR` | read-only tool binary / plugin dir | `--ro-bind-try <path> <path>` (one per `params[]`) |
| `(allow file-read*/file-write* (subpath HOME/.codex))` / `.claude` | tool config + persisted state (writable) | `--bind-try <home>/.codex <home>/.codex` (rw) (`configDirs`) |
| `~/Library/Keychains`, `user-preference-*` | macOS Keychain creds | **N/A on Linux** — creds live in the (already-bound, rw) `~/.codex` / `~/.claude`; no Keychain analog |
| `(allow file-read* file-write* (subpath (param "JAIL")))` | THE jail — the only broad rw | `--bind <jail> <jail>` (rw, hard — must exist) |
| `TMPDIR="$JAIL/.tmp"` (launcher, not the profile) | temp **inside** the jail (the "almost-faked-the-spike" bug) | `--setenv TMPDIR <jail>/.tmp` |
| `/dev/null`, `/dev/urandom`, `/dev/tty`, `file-ioctl` | device nodes | `--dev /dev` (a minimal devtmpfs) |
| (the seatbelt runs in the host pid/proc) | — | `--proc /proc` (a fresh proc for the new pid ns) |
| `(deny default)` ⇒ `/tmp`, `$HOME/Documents`, … invisible | no blanket temp, no home read | NOT bound ⇒ absent in the ns; plus `--tmpfs /tmp` (private, empty), `--new-session` (detaches the controlling tty ⇒ no `TIOCSTI` injection) |

Concretely, a `codex exec` run becomes:

```
bwrap \
  --die-with-parent --unshare-all --share-net --new-session \
  --ro-bind-try /usr /usr  --ro-bind-try /lib /lib  --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /bin /bin  --ro-bind-try /sbin /sbin --ro-bind-try /etc /etc \
  --ro-bind-try /opt /opt  --ro-bind-try /usr/local /usr/local \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind <JAIL> <JAIL> \
  --bind-try <HOME>/.codex <HOME>/.codex \
  --ro-bind-try <CODEX_BIN_DIR> <CODEX_BIN_DIR> \
  --setenv TMPDIR <JAIL>/.tmp \
  --chdir <JAIL> \
  -- <abs/codex> exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

(`cc-confine`'s extra `PLUGIN_DIR` is just a second `--ro-bind-try`.)

### Why this is a *real* kernel boundary, not a stub

- **It is the kernel, not the tool.** `bwrap` creates real Linux **namespaces** (mount + user + pid
  + ipc + uts + cgroup) via `unshare(2)`/`clone(2)`. A path not bound into the mount namespace
  **does not exist** for the process — `open()` returns `ENOENT`/`EACCES` from the kernel, exactly
  like the seatbelt's `Operation not permitted`. The tool cannot "ask nicely" to escape; there is
  no node in its namespace to reach. This is why we can keep telling the inner tool to bypass *its
  own* approval prompts (`--dangerously-bypass-approvals-and-sandbox` /
  `--dangerously-skip-permissions`): Plexus's jail, not the tool's politeness, is the boundary.
- **No privilege re-acquisition.** bwrap drops into an unprivileged **user namespace** and (because
  we pass no `--cap-add`) sets **`PR_SET_NO_NEW_PRIVS`** — a setuid/fscaps binary inside the jail
  cannot gain privileges. (On hosts that ship a *setuid-root* bwrap instead of an unprivileged-userns
  one, the jail is built without a user namespace; the availability probe in §3 accounts for this —
  it concludes "available" only from a jail that actually ran a command, so either build path is
  detected correctly.) `--die-with-parent` guarantees the jail cannot outlive the gateway
  (no orphaned, un-reaped confined process). `--new-session` severs the controlling terminal so a
  confined process cannot inject into the parent's tty.
- **Same deny-default shape as darwin.** The jail starts empty and we add back *only* the
  allow-list above — the dual of `(deny default)` + `(allow …)`. The only broad **write** surface
  is the single `--bind <jail>`; everything else is read-only or absent. A write outside the jail
  hits a read-only or non-existent mount ⇒ kernel denial.

This is the same security argument the seatbelt profile makes, expressed in the Linux primitive.
It is a tested follow-on, **never half-shipped**: if the jail can't be built, the source is not
advertised (next section).

## 3. The availability gate (anti-"advertised but unjailed")

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
is `existsSync(/usr/bin/sandbox-exec)` — the same check the source health used before.

The P3-1 registry gate is extended by **one boolean**:

```
activeModulesForPlatform("linux", { execConfinementAvailable })
  = { workspace, sysinfo }                         when execConfinementAvailable === false  (DEFAULT today: bwrap absent)
  = { workspace, sysinfo, codex, claudecode }      when execConfinementAvailable === true   (a working bwrap jail exists)
```

`createSourceRegistry(platform, opts?)` resolves the backend (`opts.sandbox ?? selectSandboxBackend`),
asks `isAvailableSync()` **only on Linux**, and feeds the boolean to the gate. Non-Linux
(`darwin`/`win32`) is **unchanged** — the full module set, no probe consulted. `{workspace,
sysinfo}` stay always-on on Linux. The allowlist remains an **allowlist**: a new first-party
source defaults gated-OUT on Linux until proven portable.

Behavior when `bwrap` is unavailable — either absent (not installed; today, including this macOS
dev box where the fake-linux tests run) **or present-but-unusable** (the binary runs but cannot
create a namespace, e.g. unprivileged userns disabled, which the real namespace-exercising probe
above now detects): identical to before P3-5 — exec sources are **not scanned, not advertised**;
`.well-known` carries zero `codex.*` / `claudecode.*` caps; their ids stay RESERVED (anti-squat).
Nothing is advertised that cannot be jailed.

## 4. Routing the launchers through the seam

`SandboxedCodexLauncher` / `SandboxedClaudeLauncher` no longer call `sandbox-exec` inline. They:
- take an injected `sandbox?: SandboxBackend` (default = `selectSandboxBackend(getPlatformServices())`;
  the legacy `sandboxExec?: string` dep, when set, pins a `DarwinSandboxBackend` for back-compat),
- build the OS-neutral `SandboxSpec`, and call `sandbox.wrap(spec)` to get the spawned argv,
- report `confinement.mechanism = sandbox.mechanism` (`"sandbox-exec"` on darwin, `"bwrap"` on
  linux) so audit is honest about the real jail used.

`buildSandboxedArgv` (codex/cc) is retained as a thin pure adapter that maps its tool-specific
params onto `DarwinSandboxBackend.wrap`, so the existing unit tests + the exact darwin argv are
preserved with a single source of truth. The source `health()` probes the backend's
`isAvailableSync()` instead of a hardcoded `sandbox-exec` path, so on Linux a `codex` source that
*is* active reports healthy via `bwrap` (not "sandbox-exec missing").

## 5. Test plan (all hermetic — no real `bwrap`)

- **registry/linux + bwrap available (mocked):** inject `PlatformServices{platform:"linux"}` and a
  `SandboxBackend` whose `isAvailableSync()` → `true`; assert the active set is
  `{workspace, sysinfo, codex, claudecode}`.
- **registry/linux + bwrap absent:** `isAvailableSync()` → `false`; assert exactly
  `{workspace, sysinfo}` and zero exec caps advertised.
- **`LinuxSandboxBackend.wrap` argv:** unit-test the pure arg construction for a sample command —
  `--unshare-all --share-net --die-with-parent --new-session`, `--bind <jail>`, `--ro-bind-try`
  for system + bin dirs, `--bind-try` for config, `TMPDIR` inside jail, `--chdir`, then `--` and the
  inner argv. No real bwrap.
- **darwin unchanged:** the registry on darwin keeps all sources; `DarwinSandboxBackend.wrap`
  reproduces the exact `sandbox-exec -f … -D … <bin> …` argv; the existing
  `source-codex` / `claudecode-run` suites stay green.
```
