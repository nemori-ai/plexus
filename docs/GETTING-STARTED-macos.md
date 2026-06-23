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
    1. Open http://127.0.0.1:7077/admin in your browser to manage capabilities + grants.
    2. Open an Obsidian vault read-only:  bun run start --vault ~/path/to/Vault
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

## 5. Add an Obsidian vault — read-only

An Obsidian vault is just a folder of `.md` files. Plexus exposes it as a single
read-only, path-confined capability `obsidian.vault.read`. The one-command flow is
to pass `--vault` when you start the gateway:

```sh
bun run start --vault ~/Documents/MyVault
```

The banner then confirms:

```
  • Opened Obsidian vault READ-ONLY: /Users/you/Documents/MyVault
      capability: obsidian.vault.read (path-confined, read-only)
```

That's it — `obsidian.vault.read` now appears in `.well-known` and in any agent's
handshake manifest. It is **read-only by construction** (no write/execute path) and
**path-confined** (a `../` traversal, an absolute path, or a symlink escaping the
vault is rejected, never served).

You can sanity-check discovery without an agent:

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json(); console.log(d.capabilities.map(c => c.id).join("\n"))'
# → … obsidian.vault.read …
```

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
| `bun run start --vault <path>` | Same, plus open an Obsidian vault read-only. |
| `bun run start --print-key` | Print the connection-key and exit. |
| `bun run start --help` | Show launcher options. |
| `PLEXUS_PORT=N bun run start` | Use port `N` instead of `7077`. |
| `bun run demo` | Run the self-contained end-to-end agent demo. |
| `bun run dev` | Watch-mode server (`src/index.ts`, no vault/banner — for development). |
| `bash run-tests.sh` | The canonical gate: `tsc --noEmit` + full test suite. |

All state lives under `~/.plexus/`. To reset, stop the gateway and remove that
directory; the next start regenerates a fresh connection-key + secret.
