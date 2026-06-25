# Plexus — Runtime/Client Separation + Desktop App: Architecture Design

> Design-only. No code changed. Derives from `docs/design/DESKTOP-RUNTIME-REDESIGN.md`
> (north star) and `docs/design/AUTHZ-UX-MODEL.md` (the authz model the product serves).
> Repo: `/Users/pandazki/Codes/plexus`. Verdict up front: this is **formalize + extend +
> package**, NOT a rewrite. The runtime is already a headless loopback service with two
> client species (web admin + `plexus` CLI) speaking its API.

---

## 1. Current-state separability audit

### 1.1 The runtime is already headless and loopback-only
The "gateway" is a pure Hono app constructed by `createAppWithState(config)`
(`src/core/server.ts:38`). Construction is fully decoupled from listening: `server.ts`
builds the `Hono` app + `GatewayState`; the actual socket bind happens only in the two
entrypoints (`src/index.ts:20`, `bin/plexus:256`) via `Bun.serve({ fetch: app.fetch, … })`.
There is **no UI coupling in the core** — the app is `app.fetch`, a standard
`Request→Response` function. That is the whole separability story in one sentence: the
runtime is a request handler; everything else is a client.

State is a single wired bundle, `GatewayState` (`src/core/state.ts:38`): source registry,
capability registry, audit writer, session/grant/revocation stores, connection-key store,
event bus, managed-sources service. All of it is constructed in-process and reachable only
through the HTTP/SSE surface. The auth/authz substance the owner wants preserved (grants,
scope constraints, task bundles, audit, managed sources) lives entirely inside this bundle
and its services (`grant-service.ts`, `pipeline.ts`, `auth/*`) — none of it touches a UI.

### 1.2 The existing client-facing surface (three planes)
There are already **three distinct API planes**, which is the key structural insight:

1. **Agent/protocol plane** (`src/core/server.ts:63-86`) — the frozen wire (protocol
   0.1.2): `GET /.well-known/plexus`, `POST /link/handshake`, `PUT/GET /grants`,
   `/grants/{context,refresh,revoke,status}`, `POST /invoke`, `GET /manifest`,
   `GET /events` (SSE), `POST/DELETE /extensions`. Auth = connection-key handshake →
   session → scoped JWT (`jti`). This is what **agents** speak.
2. **Management/admin plane** (`src/core/admin.ts`, mounted at `/admin`) — a *separate*
   same-origin API under `/admin/api/*`: capabilities, grants ledger, tokens, revoke,
   bundles, **pending approvals (`GET /api/pending` + `POST /api/pending/:id`)**,
   install-cc-master, audit, sources CRUD, secrets (write-only), and `GET /api/connection-key`.
   This is what **management clients** (web admin, `plexus` CLI) speak. Auth = a verified
   `X-Plexus-Connection-Key` header on every mutating route (`requireManagementKey`,
   `admin.ts:239`), loopback + Host/Origin guarded; read-only GETs are loopback-only.
3. **Push plane** — the in-process `EventBus` (`src/core/events.ts`) projected to agents
   over `GET /events` SSE (`handlers.ts:402`). It carries `manifest_changed`,
   `grant_resolved`, `token_revoked`, `source_status` (`protocol/types.ts:761`).

### 1.3 Two non-web clients already exist (proof of separability)
- **`plexus` CLI** (`integrations/cli/plexus-cli.ts`) — a non-web client over the SAME API.
  It resolves base URL from `--url`/`PLEXUS_URL`/`PLEXUS_PORT` (default
  `http://127.0.0.1:7077`), reads the connection-key from `~/.plexus/connection-key`
  (no paste), and always sends the loopback `Host` header. It calls both the protocol plane
  and `/admin/api/*`. This is the template for **any** server-side client (incl. the future TUI).
- **Web admin** (`management-client/`, React+Vite) — a SPA built to `management-client/dist`,
  served same-origin by the runtime under `/admin` (`admin.ts:651`). It reads the
  connection-key once from `GET /admin/api/connection-key` and caches it (`api.ts:35-49`).

### 1.4 What is web-coupled vs truly headless
**Truly headless / portable (the runtime core):** the Hono app, all of `GatewayState`,
grant/invoke/auth services, protocol plane, admin *API* logic, event bus, the platform seam,
state under `~/.plexus/`.

**Web-coupled (thin, and only in two spots):**
- The **static-SPA serving** in `admin.ts:648-673` (reads `management-client/dist`, content-types,
  SPA fallback). This is the ONLY place the runtime knows a web UI exists. It is *additive* —
  the admin API works headless without it (`NOT_BUILT_HTML` degrades gracefully).
- The **same-origin constraint** (`security.ts`): because the web admin historically had to be
  same-origin to pass the Host/Origin guard, the SPA is served by the runtime. tfix1 already
  relaxed the guard to "any loopback host on any port" — so a separate loopback client origin
  (e.g. an Electron renderer on `http://127.0.0.1:PORT`) already passes. This is load-bearing
  for the desktop model and is already in place.

**Bun coupling is almost nil.** `grep "Bun\."` over `src/` + `bin/` returns exactly
`Bun.serve` (3 hits, 2 real entrypoints + 1 doc comment in `security.ts:33`). Everything
else uses Node-compatible APIs: `node:child_process` (spawn, `darwin.ts:14`), `node:fs`,
`node:net` (TCP probe), `node:crypto` (`timingSafeEqual`, connection-key). The runtime is
*de facto* portable across Bun and Node already; only the listen call is Bun-specific.

### 1.5 Separability verdict
**Substantially separable today; the re-architecture is NOT radical.** The work is:
(a) carve the runtime into its own package with a stable listen entrypoint that takes a port
and prints a machine-readable ready line; (b) formalize the union of the protocol + admin
planes as a **versioned Local Runtime API** contract; (c) add a real-time **push channel for
the management plane** (the one true gap — pending-approvals/status today require polling
`/admin/api/pending`; there is no SSE/WS for tray/notifications); (d) extract the web SPA to
its own client package and add an Electron client; (e) finish the platform seam for Win/Linux.
No rewrite of auth/authz, pipeline, or wire is required or recommended.

---

## 2. The runtime↔client API contract (the Local Runtime API, "LRA")

Define **LRA v1** — the stable, versioned, transport-clean local contract every client
(Electron / TUI / web / CLI) speaks. It is the *union of today's two planes plus a push
channel*, frozen and versioned, served on loopback over HTTP + SSE (WS optional). It is
JSON-only and language-agnostic so a Rust/Go TUI or a Swift client could speak it.

### 2.1 Layering (reuse, don't reinvent)
- **Agent plane = unchanged.** The protocol wire (handshake/grants/invoke/events/manifest/
  extensions) stays exactly as-is (protocol 0.1.2, additive-only). LRA *includes* it by
  reference; clients that are also agents use it directly.
- **Management plane = today's `/admin/api/*`, promoted to a versioned namespace.** Move it
  under `/v1/...` (or keep `/admin/api` as a v1 alias) and freeze the shapes. The shapes
  already exist and are typed in `src/protocol/types.ts`; promote those to the shared
  protocol package (§7) so all clients import them.
- **Push plane = NEW management event stream** (the gap). See §2.3.

### 2.2 Endpoint groups (the contract surface)
All loopback, all behind the Host/Origin guard; mutating management routes require the
management connection-key (or, for the desktop app, the connection-key delivered at handoff —
§3.5). Endpoints below are the *existing* admin handlers unless marked **[NEW]**.

| Concern | Method · path | Source today |
|---|---|---|
| **Lifecycle/status** | `GET /v1/status` **[NEW, thin]** — pid, version, protocol, port, uptime, source/grant counts, pending count | compose from `gatewayInfo` + stores |
| | `GET /.well-known/plexus` — discovery | `server.ts:63` |
| | `GET /v1/health` **[NEW, thin]** — `{ok:true}` for the supervisor | trivial |
| **Capabilities/sources** | `GET /admin/api/capabilities` | `admin.ts:281` |
| | `GET/POST /admin/api/sources`, `…/detect`, `…/:id/{enable,disable,reconfigure}`, `DELETE …/:id` | `admin.ts:542-604` |
| | `POST /admin/api/install-cc-master` | `admin.ts:475` |
| **Pending approvals** | `GET /admin/api/pending` (list) | `admin.ts:436` |
| | `POST /admin/api/pending/:id` (approve/deny + trustWindow + agentId) | `admin.ts:440` |
| **Grants/bundles** | `GET/PUT /admin/api/grants`, `POST /admin/api/revoke` | `admin.ts:293,334,374` |
| | `GET/POST /admin/api/bundles` | `admin.ts:409,429` |
| | `GET /admin/api/tokens` | `admin.ts:341` |
| **Audit** | `GET /admin/api/audit?limit=` (snapshot) | `admin.ts:527` |
| | audit *stream* — see §2.3 | event bus |
| **Config** | `GET /v1/config` **[NEW]** — port, instance, auth defaults/clamps (read) | `config.ts` |
| | `PUT /v1/config` **[NEW]** — write `auth-config.json` fields (token lifetime, trust-window table, allowUntilRevoked) | `loadAuthConfig` |
| **Connection-key** | `GET /admin/api/connection-key` (trusted-local) | `admin.ts:276` |
| | `POST /v1/connection-key/rotate` **[NEW]** — expose `connectionKey.rotate()` | `connection-key.ts:77` |

### 2.3 The push channel (the one real gap — design it now)
Today only **agents** get a push stream (`GET /events` SSE), carrying agent-relevant events.
The **management** plane has no push: the web admin and any tray must *poll* `/admin/api/pending`
to learn a new approval arrived. For a tray badge + native notification that is wrong.

**Add `GET /v1/events` — a management SSE stream** (mirror of the agent `/events`, different
audience filter). It re-emits the existing `EventBus` plus management-relevant events:
- `pending_added` / `pending_resolved` **[NEW event types]** — emitted when an agent's
  `PUT /grants` or `POST /extensions` creates a pending item, and when it is approved/denied.
  This is what drives the tray badge + the native "Agent X wants to WRITE your vault…"
  notification (AUTHZ-UX §2 Mode-1). The pending narration already exists
  (`PendingNarration`, `types.ts:300`) — the event just needs to carry/reference it.
- `audit_appended` **[NEW]** — projection of each `audit.write` so the dashboard "audit pulse"
  is live without polling.
- re-broadcast of `manifest_changed`, `token_revoked`, `source_status` (already published).

Implementation cost is small: the `EventBus` (`events.ts`) is already a fan-out; add the new
event variants to `PlexusEvent`, publish them where pending items are created/resolved
(`grant-service.ts`, `handlers.extensions`, `admin pending` handlers), and add a second SSE
handler that subscribes the management audience. **Transport choice: SSE, not WS.** SSE is
one-directional server→client (exactly the tray/notification need), survives the loopback
guard trivially, needs no upgrade handshake, and the agent plane already proves the pattern.
Keep WS as an *optional future* if a client needs bidirectional streaming (none does today).

### 2.4 Versioning + stability rules
- LRA carries its own version (`lraVersion: "1.0"`) in `GET /v1/status`, independent of the
  agent protocol version. Additive-only within a major; breaking changes bump to `/v2`.
- The agent wire stays frozen at its own cadence (0.1.x additive). A client negotiates both:
  `GET /v1/status` returns `{ lraVersion, protocolVersion, runtimeVersion }`.
- Shapes are owned by the shared protocol package (§7) and imported by every client, so the
  contract is *compiler-enforced* across runtime, Electron, and (TS) TUI.

---

## 3. Desktop embedding model

### 3.1 Recommendation: **Bun runtime as a supervised sidecar child process**
The Electron **main** process spawns the Plexus runtime as a child process and supervises it.
This is the lead option in the north star and the right call. Rationale:
- **The separation stays real.** The runtime is the same binary a server admin runs headless;
  the desktop app is just one more client that happens to also own the process lifecycle.
- **The runtime stays untouched.** No port to Node/Electron-main, no rewrite of the
  `Bun.serve` entrypoints, no risk to the working auth logic.
- **Clean failure isolation.** A runtime crash doesn't take down the UI; the supervisor
  restarts it and the renderer reconnects to the same `~/.plexus` state.

### 3.2 Why NOT port the runtime to Node/Electron-main (the alternative, assessed)
The Bun coupling is *trivial* (§1.4: only `Bun.serve`), so a port is technically cheap — one
adapter swapping `Bun.serve` for `node:http` + `@hono/node-server` (Hono supports both). But
porting is still the **wrong** choice:
- It dissolves the separation the owner explicitly wants (runtime would live *inside* Electron-main,
  no longer the same artifact a server runs).
- Electron-main is Node, and bundling/running Bun-targeted code there means re-validating every
  `node:*` call under Electron's Node, plus losing Bun's startup speed and single-file-exe
  packaging story (§5). 
- It couples runtime release cadence to Electron's.
- **However**: because the coupling is so small, keep a thin **listen-adapter seam** (one
  module that owns the `Bun.serve` call) so that IF a future client must run the runtime
  in-process (e.g. a pure-Node TUI environment without the Bun binary), the same `app.fetch`
  can be served by `@hono/node-server` with zero core changes. Cheap insurance; recommend
  building it during Phase 1.

### 3.3 Process lifecycle + health/restart
- **Spawn**: Electron-main spawns the runtime sidecar binary (§5) on app launch, passing
  `PLEXUS_PORT` (chosen per §3.4), `PLEXUS_HOME` (default `~/.plexus`), and an instance name.
- **Ready handshake**: the runtime already prints a ready line (`index.ts:27`); formalize it to
  emit a machine-readable line on stdout, e.g. `PLEXUS_READY {"port":54321,"pid":…,"lraVersion":"1.0"}`,
  which the supervisor parses to learn the actual bound port (critical for ephemeral ports).
  Alternatively the supervisor polls `GET /v1/health` until 200. Use both: parse-then-confirm.
- **Health**: supervisor polls `GET /v1/health` on an interval; on N consecutive failures it
  treats the runtime as dead.
- **Restart**: exponential-backoff restart with a cap; surface a tray "runtime restarting…"
  state. Because all authoritative state is on disk under `~/.plexus`, a restart loses only
  in-memory sessions/tokens (agents re-handshake — already a supported recovery path).
- **Shutdown**: on app quit, supervisor sends SIGTERM (runtime already handles SIGINT/SIGTERM
  gracefully, `index.ts:31`/`bin/plexus:298`), waits, SIGKILL as last resort. Guard against
  orphaned runtimes (detached children) — track the pid and kill on `will-quit`.
- **Single-instance**: Electron `requestSingleInstanceLock()` so a second launch focuses the
  existing window rather than spawning a second runtime against the same `~/.plexus`.

### 3.4 Port / socket selection
- **Default**: keep `7077` for continuity with the CLI + existing agents (the `plexus` CLI and
  Claude-Code plugin default to it). The desktop app should prefer 7077 so server-side agents
  keep working unchanged.
- **Conflict fallback**: if 7077 is taken, bind an ephemeral port (`port: 0`) and learn the
  actual port from the ready line. The Host/Origin guard already tolerates any-loopback-port
  (tfix1, `security.ts:39`), so ephemeral binds are safe. Write the chosen port to
  `~/.plexus/runtime.json` (`{port, pid, lraVersion}`) so the CLI/agents can discover a
  non-default port without env vars.
- **Unix-domain socket option (future)**: for the desktop case a UDS under `~/.plexus/run.sock`
  would remove the loopback-port surface entirely (no other local process can connect without
  fs permission). Recommend keeping TCP loopback for v1 (agents already speak it; cross-platform
  UDS/named-pipe parity is extra work) and noting UDS as a hardening option.

### 3.5 The trusted-client auth handoff (no paste)
The desktop app is *the* trusted management client and must authenticate to the runtime
**without the user pasting a key**. The mechanism already exists for same-origin web:
`GET /admin/api/connection-key` returns the key over loopback, and mutating routes require it
back as `X-Plexus-Connection-Key`. For the sidecar model, harden the handoff:
- **Preferred: the supervisor mints/holds a handoff secret.** Since Electron-main *spawns* the
  runtime, it can pass a one-time **bootstrap token** to the child via env
  (`PLEXUS_DESKTOP_HANDOFF=<random>`), and the runtime exposes it as the proof the renderer
  presents. Or, simplest and consistent with today: Electron-main reads `~/.plexus/connection-key`
  directly (it has fs access to the user's home, same trust domain) and hands it to the renderer
  over a private IPC channel — the renderer never reads the file, never shows the key, and sends
  it as `X-Plexus-Connection-Key`. This is exactly what the web admin does, minus the network
  round-trip, and is the **recommended v1** path: zero new crypto, reuses the proven gate.
- **Renderer isolation**: `contextIsolation: true`, `nodeIntegration: false`. The renderer talks
  to the runtime over loopback HTTP/SSE (passes the guard as a loopback origin). The connection-key
  is injected by main via a `contextBridge` preload, kept out of page-reachable globals.
- **Key never leaves the box**: identity posture is unchanged (AUTHZ-UX §4 — connection-key is the
  local single-user trust boundary; `agentId` is for scoping/audit, not crypto auth).
- **Rotation**: expose `POST /v1/connection-key/rotate`; the desktop "rotate key" action drops all
  standing sessions/tokens (already wired, `state.ts:127`) and re-reads the new key.

---

## 4. Cross-platform

### 4.1 The platform seam is the right boundary, already
`PlatformServices` (`protocol/types.ts:1729`) is the single OS-abstraction interface:
`resolveBinary`, `getEnrichedPath`, `locateLocalService`, `spawnProcess`, `resolveSecret`.
The selector (`platform/index.ts:20`) dispatches on `process.platform`; `darwin.ts` is concrete,
`win32.ts`/`linux.ts` are typed throw-stubs (the interface shape is real, t15 deferred them).
No `process.platform` check leaks past this seam — confirmed (`grep` shows it only in the
selector + `path-resolver.ts`). So **cross-platform = fill two stubs**, not re-architect.

### 4.2 What each platform impl needs
For each of `LinuxPlatformServices` / `Win32PlatformServices`, implement:
- **`getEnrichedPath`** — capture the user's real interactive PATH. macOS uses a login-shell
  probe (`path-resolver.ts`); Linux: same login-shell approach (`$SHELL -lic 'echo $PATH'`) +
  fallback dirs (`/usr/local/bin`, `~/.local/bin`, etc.). Windows: read `PATH` from the
  environment/registry; no login-shell concept — usually `process.env.PATH` + known install dirs
  is enough.
- **`resolveBinary`** — `which`-equivalent over the enriched PATH. Windows must honor `PATHEXT`
  (`.exe/.cmd/.bat`) and `where`.
- **`spawnProcess`** — the NDJSON line-framer over `node:child_process.spawn` is already
  OS-neutral (`darwin.ts:114` uses only `node:child_process`); Linux can reuse it nearly verbatim.
  Windows needs care with `shell`/quoting and `.cmd` shims (`spawn` of a `.cmd` needs `shell:true`
  or the `.cmd` resolved path) — encapsulate that here.
- **`locateLocalService`** — TCP probe (`node:net`) is already cross-platform; the `KNOWN_SERVICES`
  table is OS-neutral. Windows/Linux mostly inherit it; named-pipe (Win) / UDS (Linux) support is
  additive under the existing `LocalServiceLocation.kind` union.
- **`resolveSecret`** — file store under `~/.plexus/secrets/` is already cross-platform. Future:
  macOS Keychain / Windows Credential Manager / libsecret behind this same method (noted in
  `darwin.ts:176`).

### 4.3 State + paths portability
`plexusHome()` = `~/.plexus` via `node:os.homedir()` (`paths.ts:17`), cross-platform already.
Atomic writes use `node:fs` rename (cross-platform). One Windows caveat: `chmod 0600` on secrets
(`admin.ts:177`) is a no-op on Windows — gate it behind the platform seam or accept the no-op
with ACL-based hardening as a follow-up. No other path coupling.

### 4.4 The TUI client seam (server-side, no GUI)
The TUI is **just another LRA client** — the `plexus` CLI already proves the entire pattern
(`integrations/cli/plexus-cli.ts`): resolve base URL, read `~/.plexus/connection-key`, send the
loopback Host header, call protocol + `/admin/api/*`. Define the TUI as:
- a long-running client that connects to a **headless runtime the operator starts directly**
  (the server case — runtime runs as a systemd service / bare `plexus serve`, no Electron),
- subscribes to `GET /v1/events` (§2.3) for live pending/audit, renders an approve/deny inbox,
  grants ledger, and audit tail in the terminal,
- authenticates exactly like the CLI (connection-key from `~/.plexus`).
No new runtime surface is needed for the TUI beyond LRA + the management event stream. Keep the
TUI in its own client package (§7); it can be TS (shares the protocol pkg) or any language.

### 4.5 Cross-platform sequencing
The runtime is portable *now* except the two seam stubs. Recommend filling Linux first (server +
TUI target, and the simpler seam), then Windows (desktop target, more spawn/PATHEXT nuance). This
can proceed **in parallel** with the Electron work because the seam is isolated. See §7 DECISION.

---

## 5. Distribution / packaging (one app, no perceived separation)

### 5.1 Bundle the runtime as a single-file Bun executable, shipped as an Electron sidecar
- `bun build --compile` produces a **single-file native executable** of the runtime per target
  (`bun build --compile --target=bun-darwin-arm64|bun-darwin-x64|bun-windows-x64|bun-linux-x64`).
  This is the sidecar binary Electron-main spawns (§3). No Bun install required on the user's
  machine — the runtime carries its own Bun.
- Electron packaging (electron-builder / electron-forge) ships the per-OS runtime binary as an
  **extraResource**. Electron-main resolves the binary path (dev: repo build dir; prod:
  `process.resourcesPath`) and spawns it. This is the same supervisor code in dev and prod.
- The web SPA (`management-client/dist`) is loaded into the Electron **renderer** directly
  (`loadFile`/`loadURL` to a packaged build) — it does NOT need to be served by the runtime in the
  desktop app (the runtime's static-serve stays, but only for the *optional headless web admin*).

### 5.2 Per-OS installers + auto-update
- electron-builder targets: macOS `.dmg`/`.zip` (notarized + signed), Windows `.exe` (NSIS) +
  optional MSI, Linux `.AppImage`/`.deb`/`.rpm`.
- **Auto-update**: electron-updater (Squirrel.Mac / NSIS / AppImage). The runtime sidecar updates
  *with* the app (it's bundled as a resource) — single update channel, single version the user sees.
  Note: the `lraVersion`/`protocolVersion` negotiation (§2.4) means a mid-update runtime/client
  version skew degrades gracefully rather than breaking.
- **Code signing**: required for notarization (macOS) and SmartScreen (Windows). The bundled Bun
  exe must be signed too (it's spawned as a child; unsigned binaries trip Gatekeeper).

### 5.3 State lives in `~/.plexus` (shared, single source of truth)
All runtime state stays under `~/.plexus` (`paths.ts`), unchanged. The desktop app, the CLI, and a
server-side TUI all read the same home, so a user can install the desktop app AND use the CLI
against the same gateway with no migration. Electron's own app data (window state, prefs) lives in
Electron's `userData`, kept separate from runtime state. The user perceives one app; under the hood
the runtime is the same artifact a server runs.

### 5.4 Headless server distribution (parallel artifact)
Ship the same `bun build --compile` runtime binary standalone (no Electron) for the server/TUI case:
`plexus serve` (headless) + `plexus tui` (the client). One runtime, two distribution shells
(desktop bundle vs bare binary).

---

## 6. Migration (minimal churn to working auth logic)

**What STAYS (untouched):** the entire auth/authz substance — `GatewayState`, grant/invoke/auth
services, the frozen agent wire, the event bus, the platform seam interface, `~/.plexus` layout,
the `admin.ts` API *logic*. This is the explicit non-goal-to-disturb.

**What MOVES (repackaging, not rewriting):**
- The runtime (`src/**` minus the web-static-serve concern) → a `runtime` package with a stable
  `plexus serve` entrypoint that owns the listen-adapter seam (§3.2) and the machine-readable ready
  line (§3.3). The two `Bun.serve` call sites (`index.ts`, `bin/plexus`) collapse into one
  supervised entrypoint + keep `bin/plexus` as the human launcher.
- `management-client/**` → a `desktop`-renderer / `web` client package; its static-serve coupling
  in `admin.ts:648-673` becomes *optional* (kept for headless web admin, bypassed in Electron).
- The protocol/admin *shapes* in `src/protocol/types.ts` → a shared `protocol` package both runtime
  and clients import (§7).

**What is NET-NEW:**
- The Electron app (main: supervisor + tray + native notifications; renderer: the reorganized admin
  + dashboard).
- The management event stream `GET /v1/events` + the `pending_added`/`pending_resolved`/
  `audit_appended` event types (§2.3) — the single most important new runtime capability.
- `GET /v1/status`, `GET /v1/health`, `GET/PUT /v1/config`, `POST /v1/connection-key/rotate` (thin).
- Win/Linux platform-seam impls (§4).
- The TUI client (post-desktop).
- Packaging pipeline (§5).

**Compatibility:** keep `/admin/api/*` as a v1 alias so the existing CLI + web admin keep working
during the transition; agents are untouched (frozen wire).

---

## 7. DECISIONS

**DECISION 1 — Embedding model.** Recommend the **Bun-runtime-as-supervised-sidecar** child
process. Electron-main spawns/supervises the `bun build --compile` runtime binary. Do NOT port to
Node/Electron-main (it dissolves the separation and couples cadences), but DO add a thin listen-
adapter seam so `app.fetch` could be served by `@hono/node-server` if ever needed (cheap insurance,
Phase 1).

**DECISION 2 — Web-admin fate.** **Keep it, demoted to optional.** The same React client is the
Electron renderer; the runtime's same-origin static-serve (`admin.ts`) is retained but optional, so a
headless server still offers a browser admin fallback (`plexus serve` → `/admin`). One UI codebase,
two shells (Electron renderer primary, served-web fallback). Don't fork the UI.

**DECISION 3 — Cross-platform sequencing.** **In parallel with the desktop work, Linux-first then
Windows.** The seam is isolated (§4.1), so filling stubs doesn't block Electron. Linux first (server +
TUI target, simpler seam); Windows next (desktop target, spawn/PATHEXT nuance). Desktop on macOS can
ship before Windows seam parity — gate Windows desktop release on the Win32 seam.

**DECISION 4 — Electron vs Tauri.** Owner chose **Electron — endorse it.** Tradeoffs noted: Tauri
(Rust core + system webview) yields far smaller installers (~5–10 MB vs ~80–120 MB) and lower RAM,
but (a) its sidecar/IPC story for a *Bun* runtime is less mature, (b) per-OS webview differences add
QA cost, (c) the team's JS/TS skillset + the React admin map directly onto Electron, (d) Electron's
tray + native-notification + auto-update ecosystem is the most batteries-included for exactly the
three features the north star names (tray, notifications, dashboard). For a desktop app whose whole
job is supervising a local runtime + showing a tray/notification UI, Electron's maturity outweighs
its size. **Recommend Electron**; revisit Tauri only if install size becomes a hard requirement.

**DECISION 5 — Monorepo layout.** Adopt a workspace monorepo:
```
packages/
  protocol/   # shared TS types: agent wire + LRA shapes + event types (the contract)
  runtime/    # the headless gateway (today's src/**) — `plexus serve`, listen-adapter seam
  cli/        # the `plexus` CLI client (today's integrations/cli) — LRA client
  desktop/    # Electron: main (supervisor+tray+notifications) + renderer (admin+dashboard)
  web-admin/  # the React SPA (today's management-client) — shared by desktop renderer + served-web
  tui/        # future server-side TUI client (post-desktop)
```
`protocol` is the keystone: runtime + every client import it, so the contract is compiler-enforced.
Bun workspaces (or pnpm) for the JS side; the runtime builds to a single-file exe consumed by
`desktop` as a sidecar resource.

**DECISION 6 — Push transport for management.** **SSE (`GET /v1/events`), not WebSocket.**
Server→client only is exactly the tray/notification/audit-pulse need; the agent `/events` plane
already proves SSE through the loopback guard with no upgrade handshake. WS stays an optional future
if a client ever needs bidirectional streaming.

**DECISION 7 — Auth handoff.** **Electron-main reads `~/.plexus/connection-key` and injects it to the
renderer via a `contextBridge` preload; the renderer sends it as `X-Plexus-Connection-Key`.** Reuses
the proven management-key gate, zero new crypto, no user paste. `contextIsolation:true`,
`nodeIntegration:false`; key never reaches page globals. Identity posture unchanged (AUTHZ-UX §4).

---

## 8. Phased build roadmap (each phase independently shippable)

**Phase 0 — Monorepo carve + protocol package.** (~S, low risk) Extract `packages/protocol` from
`src/protocol/types.ts`; set up the workspace; move runtime/cli/web-admin into packages with no
behavior change. Ship: identical product, cleaner boundaries. *Independently shippable:* yes (no
user-visible change; CI proves parity via existing tests).

**Phase 1 — Formalize the runtime entrypoint + LRA v1 thin endpoints.** (~S–M) Single supervised
`plexus serve` entrypoint with the listen-adapter seam + machine-readable ready line + `runtime.json`
port file; add `GET /v1/status`, `/v1/health`, `GET/PUT /v1/config`, `POST /v1/connection-key/rotate`;
alias `/admin/api/*` under `/v1`. Ship: a runtime that any supervisor can drive. *Shippable:* yes
(server users get status/health/config endpoints + headless serve).

**Phase 2 — Management event stream (the gap).** (~M) Add `pending_added`/`pending_resolved`/
`audit_appended` to `PlexusEvent`; publish them at the pending-create/resolve + audit-write sites;
add `GET /v1/events` management SSE. Ship: live pending/audit push — immediately usable by the web
admin (drop its polling) and the future tray. *Shippable:* yes (web admin gains live updates).

**Phase 3 — Electron desktop (macOS first).** (~L) `packages/desktop`: supervisor (spawn/health/
restart/shutdown, single-instance), connection-key handoff (§3.5), tray (status + pending badge +
start/stop), native notifications driven by `pending_added` (Mode-1 approval), renderer hosting the
web-admin SPA + dashboard. macOS-signed/notarized `.dmg` + auto-update. Ship: the one-app desktop
experience on macOS. *Shippable:* yes (macOS desktop app).

**Phase 4 — Cross-platform runtime (Linux → Windows).** (~M each, parallelizable with Phase 3) Fill
`LinuxPlatformServices` then `Win32PlatformServices`; handle Windows chmod/PATHEXT/spawn nuances.
Ship: headless runtime on Linux servers; unblock Windows desktop. *Shippable:* yes (Linux server
runtime; then Windows desktop build behind the Win32 seam).

**Phase 5 — Admin IA/UX + onboarding redesign.** (~L, can overlap Phase 3) The reorganized admin
around the two modes + the onboarding arc (AUTHZ-UX §1, DESKTOP §3). This is UI work over the stable
LRA; sequence after the contract + event stream exist so the UI builds on live data. *Shippable:* yes
(reskinned admin, served in Electron + web).

**Phase 6 — TUI client + headless server distribution.** (~M) `packages/tui` over LRA + `/v1/events`;
standalone runtime binary (`plexus serve`/`plexus tui`) for Linux servers. *Shippable:* yes
(server-side approval UX without a GUI).

**Rough effort:** S≈days, M≈1–2 weeks, L≈3–5 weeks per phase, parallelizable where noted. Critical
path to "one desktop app": Phases 0→1→2→3 (macOS). Windows desktop adds Phase 4 (Win32).
