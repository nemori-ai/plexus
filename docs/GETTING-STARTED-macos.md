# Getting Started on macOS

This is the real path to sit down and use Plexus on your Mac: install, start the
gateway, open the management UI, copy the connection-key, open an Obsidian vault
read-only, connect an agent, and (optionally) enable cc-master.

Plexus is a **local capability gateway**. It binds to `127.0.0.1` only (never
`0.0.0.0`) and keeps all its state under `~/.plexus/`. Nothing here talks to the
network beyond loopback.

Every command below was run on a real Mac (macOS, Apple Silicon, Bun 1.3.11) and
produces the output shown.

---

## 1. Prerequisites — Bun

Plexus runs on [Bun](https://bun.sh) (≥ 1.3.0). Install it if you don't have it:

```sh
curl -fsSL https://bun.sh/install | bash
```

Verify:

```sh
bun --version
# → 1.3.11  (any 1.3.x is fine)
```

---

## 2. Install Plexus

Clone the repo and install dependencies:

```sh
git clone <your-plexus-remote> plexus    # or: cd into your existing checkout
cd plexus
bun install
```

The management UI (the `/admin` SPA) ships pre-built in `management-client/dist`.
If that folder is ever missing, build it once:

```sh
cd management-client && bun install && bun run build && cd ..
```

---

## 3. Start the gateway

```sh
bun run start
```

You'll see a banner like this and the process **stays running** (Ctrl-C to stop):

```
  Plexus gateway is running (loopback only).

  Management UI:   http://127.0.0.1:7077/admin
  Discovery:       http://127.0.0.1:7077/.well-known/plexus

  Connection-key:  plx_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
      (stored at /Users/you/.plexus/connection-key — also via:  bun run start --print-key)
      Paste it into an agent at handshake to grant capabilities.

  State directory: /Users/you/.plexus

  Next steps:
    1. Open http://127.0.0.1:7077/admin in your browser to manage capabilities, grants + sources.
    2. Add a source from the /admin Sources panel or `plexus source` CLI (or the
       --vault / --obsidian-rest shortcut flags).
    3. Optionally enable cc-master from the /admin "Install cc-master" action.

  Press Ctrl-C to stop.
```

**First run is automatic:** the gateway creates `~/.plexus/` (the connection-key,
the per-install signing secret, the audit log) on first boot. There's nothing to
configure.

Change the port with `PLEXUS_PORT` if `7077` is taken:

```sh
PLEXUS_PORT=7099 bun run start
```

> The gateway pins its Host/Origin guard to the configured port at startup, so
> always reach it on the exact `127.0.0.1:<port>` it printed.

---

## 4. Open the management client + copy the connection-key

Open the printed Management UI in your browser:

```
http://127.0.0.1:7077/admin
```

You get the **Capability Control** panel: list capabilities, set access + issue
scoped tokens, approve/deny pending grants, view the audit trail, and (optionally)
install cc-master. Because the UI is served same-origin from the gateway itself, it
already knows the connection-key — you don't paste anything into the UI.

**To copy the connection-key for an agent**, either:

- read it from the start banner, or
- run (from the repo, while or even when the server is stopped — it's read from `~/.plexus/`):

  ```sh
  bun run start --print-key
  # → plx_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  ```

- or read the file directly:

  ```sh
  cat ~/.plexus/connection-key
  ```

The connection-key is a **session-bootstrap secret**, not call authority: an agent
presents it once at handshake to open a session, then holds short-lived scoped
tokens for actual calls.

---

## 5. Add an Obsidian vault as a managed source

Capability sources in Plexus are **managed**: you add/remove/enable/disable/
reconfigure them at runtime, they **persist** to `~/.plexus/sources.json`, and they
**hot-reload** into the live registry with **no flag and no gateway restart**. The
two primary ways to manage sources are the **`/admin` Sources panel** and the
**`plexus source` CLI**. The old `--vault` / `--obsidian-rest` launcher flags still
work — they are now thin shortcuts that route through the same managed add-and-persist
path (see step 5.4). For the full picture see
[`docs/sources/MANAGING-SOURCES.md`](sources/MANAGING-SOURCES.md).

An Obsidian vault is just a folder of `.md` files. Plexus can expose it two ways:

- **`obsidian-fs`** — direct, read-only, path-confined filesystem read
  (`obsidian.vault.read`). No plugin, no secret.
- **`obsidian-rest`** — read-WRITE via the Obsidian Local REST API plugin
  (`obsidian-rest.vault.{list,read,write}`) over loopback HTTPS, Bearer-authenticated.

### 5.1 Via the `/admin` Sources panel (recommended)

Open `http://127.0.0.1:7077/admin` and switch to the **Sources** tab. There you can:

- see **detected** but not-yet-added sources (e.g. a running Obsidian Local REST API)
  with a one-click **Add**;
- add a source manually (the **Add Obsidian REST** form takes a base URL + API key —
  the key is written to `~/.plexus/secrets/` and referenced by NAME, never echoed back);
- **enable / disable / remove / reconfigure** any configured source.

Because the `/admin` UI is served same-origin from the gateway and is connection-key
authenticated, you (the local user) are the human approver — adding a write-capable
source from the panel registers it without a separate pend. The capability **hot-appears
in `.well-known` and every agent's manifest immediately — no restart.**

### 5.2 Via the `plexus source` CLI

The same management surface from the terminal (a thin HTTP client over the `/admin`
API, authenticated by `~/.plexus/connection-key`):

```sh
# Find reachable sources the gateway could add:
bun run integrations/cli/plexus-cli.ts source detect

# Add the read-only fs vault (no secret):
bun run integrations/cli/plexus-cli.ts source add obsidian-fs --vault-path ~/Documents/MyVault

# Add the read-WRITE Local REST source (key read from STDIN, stored by NAME):
printf %s "$OBSIDIAN_KEY" | bun run integrations/cli/plexus-cli.ts source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin

bun run integrations/cli/plexus-cli.ts source list
bun run integrations/cli/plexus-cli.ts source disable obsidian-rest
bun run integrations/cli/plexus-cli.ts source reconfigure obsidian-rest --base-url https://127.0.0.1:27123
bun run integrations/cli/plexus-cli.ts source remove obsidian-rest
```

The API key is read from **STDIN only** (`--api-key-stdin`) — never argv (which would
leak via `ps`). Reconfiguring the `--base-url` / secret of a source **purges its grants**
so a prior approval can't carry over to a new endpoint.

### 5.3 Confirm it hot-appeared (no restart)

Any source added above is live immediately — sanity-check discovery without an agent:

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json(); console.log(d.capabilities.map(c => c.id).join("\n"))'
# → … obsidian.vault.read …            (obsidian-fs)
# → … obsidian-rest.vault.read …       (obsidian-rest)
```

The `obsidian-fs` read is **read-only by construction** (no write/execute path) and
**path-confined** (a `../` traversal, an absolute path, or a symlink escaping the vault
is rejected, never served). The `obsidian-rest` `vault.write` carries a `write` grant,
so granting it **pends for a human** — an agent cannot self-grant the mutating call.

### 5.4 Launcher-flag shortcut (still supported)

If you prefer one command at start, the flags persist + register the same managed
source (then auto-load on the next boot — no need to re-pass them):

```sh
bun run start --vault ~/Documents/MyVault            # ⇒ managed obsidian-fs source
bun run start --obsidian-rest --rest-url https://127.0.0.1:27124   # ⇒ managed obsidian-rest source
```

Add `--ephemeral` to register for THIS run only (the old non-persisting behavior, for
CI / one-offs). After the first start you manage everything from the Sources panel or
the CLI — no flag re-supply.

---

## 6. Connect an agent

### The self-contained demo (no setup)

The fastest proof is the bundled minimal agent. It speaks ONLY the published
protocol — `DISCOVER → handshake → grant → invoke` — and reads a real note:

```sh
bun run examples/min-agent/run.ts
```

It boots its own throwaway gateway + temp vault and prints the whole loop,
including the deliberate **un-granted invoke that gets denied** (default-deny) and
the **granted read** returning real note content.

### Drive an agent against YOUR running gateway

Point the same demo at the gateway you started in step 3 (with your real vault):

```sh
# Terminal 1: keep the gateway running
PLEXUS_PORT=7077 bun run start --vault ~/Documents/MyVault

# Terminal 2: drive it as an external agent
export PLEXUS_BASE_URL=http://127.0.0.1:7077
export PLEXUS_CONNECTION_KEY=$(bun run start --print-key)
bun run examples/min-agent/run.ts
```

The agent will discover `obsidian.vault.read`, handshake with your connection-key,
request a read grant, and read a note from your real vault.

### How a coding agent (e.g. Claude Code) discovers it

Any agent that speaks the Plexus protocol follows the same four steps:

1. `GET http://127.0.0.1:7077/.well-known/plexus` (with `Host: 127.0.0.1:7077`) to
   discover capability summaries — no auth required.
2. `POST /link/handshake` with the connection-key to get a session + full manifest.
3. `PUT /grants` to request scoped access (e.g. `read` on `obsidian.vault.read`).
4. `POST /invoke` with the minted `Bearer` token to call it.

`examples/min-agent/client.ts` is a complete, dependency-light reference
implementation of that agent side you can copy from.

---

## 7. (Optional) Enable cc-master

If you use [cc-master](https://github.com/nemori-ai/cc-master) (Claude Code
long-horizon orchestration), Plexus detects it automatically when Claude Code
(`claude`) is on your PATH and the plugin is installed under `~/.claude/`. Its
orchestration workflow, board members, and usage skills then appear as
capabilities (`cc-master.orchestration.run`, `cc-master.board.*`, etc.).

If cc-master isn't enabled yet, use the **Install cc-master** action in the `/admin`
panel. It performs a first-class, **idempotent, audited** install: it only adds the
two settings keys that enable the plugin + register its marketplace, never rewriting
unrelated settings. If it's already enabled, the action is a safe no-op.

You can confirm detection from discovery:

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json(); console.log(d.capabilities.filter(c => c.id.startsWith("cc-master")).map(c => c.id).join("\n"))'
```

---

## Reference: commands

| Command | What it does |
| --- | --- |
| `bun run start` | Boot the gateway on `127.0.0.1:7077`, print the URL + connection-key, stay running. |
| `bun run start --vault <path>` | Same, plus add an Obsidian vault as a managed `obsidian-fs` source (persists). |
| `bun run start --obsidian-rest` | Same, plus add a managed `obsidian-rest` read-write source (persists). |
| `bun run start --print-key` | Print the connection-key and exit. |
| `bun run start --help` | Show launcher options. |
| `PLEXUS_PORT=N bun run start` | Use port `N` instead of `7077`. |
| `… plexus-cli.ts source list \| detect \| add \| enable \| disable \| reconfigure \| remove` | Manage sources from the CLI (see [MANAGING-SOURCES.md](sources/MANAGING-SOURCES.md)). |
| `bun run demo` | Run the self-contained end-to-end agent demo. |
| `bun run dev` | Watch-mode server (`src/index.ts`, no vault/banner — for development). |
| `bash run-tests.sh` | The canonical gate: `tsc --noEmit` + full test suite. |

All state lives under `~/.plexus/`. To reset, stop the gateway and remove that
directory; the next start regenerates a fresh connection-key + secret.
