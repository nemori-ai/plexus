# SPIKE: macOS `sandbox-exec` confinement of headless Claude Code

**Verdict: YES — it works.** macOS seatbelt (`sandbox-exec`) kernel-confines headless
Claude Code to a single directory. CC reads/writes freely INSIDE the jail and does real
work (creates files, exits 0), while every read/write OUTSIDE the jail fails at the kernel
level with `Operation not permitted` — proven both with a direct `cat`/`sh` probe and by
prompting CC itself to read/write outside (it returns `ACCESS-DENIED` / `WRITE-DENIED`,
creates no escape file, and never exfiltrates the out-of-jail secret).

This gates the t3 build: the confinement linchpin (GOAL §4 / AC5 / AC6) is REAL.

Environment verified on: `claude` v2.1.191 (native Mach-O arm64, self-contained 219 MB
binary — NOT a node script, so **no separate `node`/dyld-of-node grants needed**),
macOS Darwin 25.5, OAuth (Max) auth. Date 2026-06-26.

---

## 1. Canonical headless invocation

Matches the repo's launcher (`packages/runtime/src/sources/cc-master/launch.ts`):

```
claude -p "<prompt>"                                  # base
claude --plugin-dir <EMBEDDED cc-master> -p "<prompt>" # with embedded plugin
```

For an **autonomous** headless run CC must bypass its OWN per-action approval gate.
In v2.1.191 the flags are:

```
--dangerously-skip-permissions          # bypass all of CC's permission checks
--permission-mode bypassPermissions      # (equivalent / belt-and-suspenders)
```

> NOTE: the older name `--dangerously-bypass-approvals-and-sandbox` does NOT exist in
> 2.1.191. Use `--dangerously-skip-permissions`.

**Bypassing CC's own gate is SAFE here precisely because the OS seatbelt is the real jail.**
CC's permission prompts are a UX guardrail for an interactive human; in the Plexus model the
kernel sandbox is the actual trust boundary, and Plexus (not CC) decides what dir CC may
touch. We intentionally turn off CC's internal gate and rely on seatbelt + the
capability-layer (path-confined `workspace.*`, PENDS for mutating actions) instead.

Always pass `< /dev/null` on stdin (headless CC otherwise waits ~3 s for piped stdin).

---

## 2. The credentials gotcha (the one real subtlety)

CC's OAuth token lives in the **macOS login Keychain** (`security` service
`Claude Code-credentials`), NOT in a file. Two consequences:

1. A naive sandbox that blocks the Keychain makes CC print **`Not logged in · Please run
   /login`** and do nothing. The profile MUST allow the login-keychain files
   (`~/Library/Keychains`) **read+write** plus `mach-lookup` (to reach `securityd`).
   Read+write is needed because the stored access token is short-lived and **CC refreshes
   it in place** (writes the new token back to the Keychain) on each run.

2. Passing the raw token via `CLAUDE_CODE_OAUTH_TOKEN=<accessToken from keychain>` does
   **NOT** work — that env var expects a long-lived `claude setup-token` token, and the
   stored OAuth *access* token is rotating/expired (the one on this machine expired
   2026-02-27; CC silently refreshes it). So: **let CC reach the Keychain inside the
   sandbox** rather than injecting a token. This is the approach the working profile uses.

(An alternative for a hardened build: mint a long-lived `claude setup-token` token once,
inject it via `CLAUDE_CODE_OAUTH_TOKEN`, and then the sandbox needs NO Keychain access at
all. Out of scope for the demo, but worth knowing.)

---

## 3. The working `.sb` profile

Saved here as the canonical artifact. Three params are injected at launch via `-D`:
`JAIL` (the one authorized dir), `HOMEDIR` (real home, for CC config + Keychain),
`CLAUDE_BIN_DIR` (the dir holding the `claude` version binaries).

```scheme
(version 1)
(deny default)
(import "/System/Library/Sandbox/Profiles/bsd.sb")

(allow process-exec*)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow iokit-open)
(allow mach-lookup)        ; reaches securityd (Keychain), DNS resolver, etc.
(allow network*)           ; REQUIRED — the model API. Without it CC hangs (see §5).

;; ---- READ-ONLY system paths CC needs to run ----
(allow file-read*
  (subpath "/usr") (subpath "/System") (subpath "/Library")
  (subpath "/private/var/db/dyld") (subpath "/private/var/db/timezone")
  (subpath "/private/var/db/mds")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (literal "/dev/dtracehelper") (literal "/dev/tty")
  (subpath "/private/etc") (subpath "/opt/homebrew")
  (subpath (param "CLAUDE_BIN_DIR")))

;; ---- CC's OWN config + creds (read; write only where CC persists state) ----
(allow file-read*
  (literal (string-append (param "HOMEDIR") "/.claude.json"))
  (subpath (string-append (param "HOMEDIR") "/.claude")))
(allow file-write*
  (subpath (string-append (param "HOMEDIR") "/.claude"))
  (literal (string-append (param "HOMEDIR") "/.claude.json"))
  (literal (string-append (param "HOMEDIR") "/.claude.json.lock")))

;; ---- KEYCHAIN (so CC can read + refresh its OAuth token) ----
(allow file-read* file-write*
  (subpath (string-append (param "HOMEDIR") "/Library/Keychains")))
(allow user-preference-read)
(allow user-preference-write)

;; ================= THE JAIL — the ONLY broad read+write =================
(allow file-read*  (subpath (param "JAIL")))
(allow file-write* (subpath (param "JAIL")))

;; ---- /dev tty ioctl ----
(allow file-ioctl (literal "/dev/tty"))
```

### ⚠️ The bug that almost faked the result (read this)

An earlier draft also granted `(allow file-read* file-write* (subpath "/private/tmp")
(subpath "/private/var/folders"))` to give CC a scratch temp dir. **That silently
defeated confinement** — because the spike's jail lives under `/private/tmp`, the broad
`/tmp` grant re-opened the whole tree and the out-of-jail probe was readable/writable.
**Do NOT grant a broad temp subpath.** Instead point CC's temp INSIDE the jail:

```
TMPDIR="<JAIL>/.tmp"   # create this dir before launch
```

CC ran fine with TMPDIR inside the jail (11 s, created `hello.txt`). If a future CC version
needs a system temp, scope it to a per-launch subdir that is NOT an ancestor of anything
sensitive — never a blanket `/private/tmp` or `/private/var/folders`.

---

## 4. Exact launch command Plexus should use

```bash
# Plexus side (unsandboxed) prepares: JAIL dir, JAIL/.tmp, resolves CLAUDE_BIN_DIR.
JAIL="$HOME/PlexusDemo/pomodoro"          # the ONE authorized dir
mkdir -p "$JAIL/.tmp"
CLAUDE_BIN_DIR="$(dirname "$(readlink "$(command -v claude)")")"   # .../share/claude/versions

TMPDIR="$JAIL/.tmp" \
sandbox-exec -f /path/to/cc-confine.sb \
  -D JAIL="$JAIL" \
  -D HOMEDIR="$HOME" \
  -D CLAUDE_BIN_DIR="$CLAUDE_BIN_DIR" \
  claude \
    -p "<the task prompt>" \
    --dangerously-skip-permissions \
    --permission-mode bypassPermissions \
    < /dev/null
```

- Run with **cwd = `$JAIL`** (the spawn `cwd` in `launch.ts`).
- Add `--plugin-dir "$EMBEDDED_CC_MASTER"` when `loadCcMaster:true`; the embedded plugin
  dir must itself be readable — it sits under the repo/runtime, so add a
  `(allow file-read* (subpath (param "PLUGIN_DIR")))` line + a `-D PLUGIN_DIR=...` when you
  wire the plugin path (the spike tested without `--plugin-dir`; trivial to extend).
- Plexus owns this command entirely; the calling DeepAgent never sees it (GOAL §4).

---

## 5. Caveats / observations

- **Does CC function fully inside the jail?** Yes. Headless file creation works; exit 0;
  output normal. Real work (read refs, write HTML, multi-step) should be fine as long as it
  stays in the jail.
- **Minimal system paths required:** `/usr`, `/System`, `/Library` (read), dyld+timezone+mds
  db, a handful of `/dev/*`, `/private/etc`, `/opt/homebrew` (if CC shells out to brew
  tools), and `CLAUDE_BIN_DIR`. The `claude` binary is a self-contained native Mach-O, so no
  separate node runtime grant is needed.
- **Network:** REQUIRED for the model API. With network denied, CC does NOT fail fast — it
  retries the connection and **hangs until killed** (timed out at 2 min in the test). Plexus
  must keep `(allow network*)` and rely on its own hard `timeoutMs` (launcher already
  defaults to 10 min). Consider tightening `network*` to just the Anthropic API host:port if
  desired (not required for the demo).
- **Keychain / TCC:** No interactive TCC prompt appeared — `securityd` + login-keychain file
  access over the seatbelt was sufficient for the token read/refresh. The profile grants the
  Keychain **read+write** (refresh writes back). This is the only access to `$HOME` outside
  the jail, besides CC's own `~/.claude*` config.
- **`~/.claude` is reachable** (read+write) under this profile — that is CC's own state, not
  the user's project data. GOAL §4 wants CC to "never touch `~/.claude`"; that is a CC
  *config-layer* concern (managed settings / `--plugin-dir`), handled separately from the
  seatbelt. The sandbox still blocks the rest of `$HOME` (verified: real `~/.ssh` and a
  sibling `~/Documents/private.txt` both denied while the jail lived inside a home tree).
- **Latency:** ~11 s for a trivial headless run under the sandbox (model round-trip
  dominated; sandbox overhead negligible).
- **No `timeout(1)` on macOS** — don't rely on it in runner scripts; use CC's own timeout or
  `gtimeout`.

## 6. Evidence (from the spike runs)

| Test | Expectation | Result |
|---|---|---|
| Unsandboxed `claude -p` create hello.txt | works | ✅ `hi`, exit 0 |
| Sandboxed `claude -p` create hello.txt (final profile) | works in jail | ✅ `hi`, 11 s |
| Sandboxed `cat <outside file>` | denied | ✅ `Operation not permitted` |
| Sandboxed `sh -c "echo > <outside file>"` | denied | ✅ denied, no file |
| Sandboxed `cat <inside file>` | works | ✅ |
| CC prompted to READ outside file | refuses / cannot | ✅ `ACCESS-DENIED`, secret not leaked |
| CC prompted to WRITE outside file | refuses / cannot | ✅ `WRITE-DENIED`, no file |
| Real `~/.ssh`, sibling `~/Documents` (jail in home tree) | denied | ✅ both denied |
| Network denied | model unreachable | ✅ hangs → killed (network required) |

## 7. Blockers needing the user

**None.** Auth works (OAuth/Max, Keychain-refreshed inside the sandbox), no TCC wall hit.
The spike is fully green. The only build-time follow-up (not a blocker): add a
`PLUGIN_DIR` read grant when wiring `--plugin-dir <embedded cc-master>`.
