# Getting Started (macOS)

This is the real, end-to-end path: install Plexus, start the gateway, open the
admin UI, grab your connection-key, and connect your **first agent** — discover a
capability, handshake, request a grant, and invoke it.

Plexus is a **local capability gateway**. By default it binds to `127.0.0.1`
only; opening it to the LAN is **opt-in** and connection-key gated (read
[security.md](security.md) first). All its state lives under `~/.plexus/`. If the
mental model (Connector → Source → Capability, provenance, scoped grants) is new
to you, skim [concepts.md](concepts.md) first — but you can also just follow along
here and it will make sense.

> Platform: macOS (Apple Silicon or Intel). The Apple Calendar / Reminders
> sources are macOS-only.

---

## 1. Prerequisites

**[Bun](https://bun.sh) ≥ 1.3.0.** Install it if you don't have it:

```sh
curl -fsSL https://bun.sh/install | bash
bun --version          # → 1.3.x
```

---

## 2. Install

```sh
git clone <your-plexus-remote> plexus    # or cd into your existing checkout
cd plexus
bun install
```

The `/admin` management UI is a Vite-built SPA in `packages/web-admin`. If its
`dist/` is missing, build it once:

```sh
cd packages/web-admin && bun install && bun run build && cd ../..
```

---

## 3. Run the gateway

Start it from the repo root:

```sh
bun run start
```

The process **stays running** (Ctrl-C to stop) and prints a banner like:

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
    ...
  Press Ctrl-C to stop.
```

**First run is automatic:** the gateway creates `~/.plexus/` (your connection-key,
the per-install signing secret, and the audit log) on first boot. Nothing to
configure.

Change the port with `PLEXUS_PORT` if `7077` is taken:

```sh
PLEXUS_PORT=7099 bun run start
```

> Always reach the gateway on the exact `127.0.0.1:<port>` it printed.

### Prefer the desktop app?

There is also an Electron desktop app in `packages/desktop`. It boots the same
gateway and injects the connection-key into the admin page for you (over Electron
IPC) so you never have to paste it:

```sh
cd packages/desktop && bun run start
```

The rest of this guide assumes the `bun run start` CLI path, but every concept is
identical in the desktop app.

---

## 4. Open the admin UI and get your connection-key

Open the printed Management UI:

```
http://127.0.0.1:7077/admin
```

The admin console has tabs for **Capabilities**, **Sources**, **Pending**,
**Grants**, **Tokens**, and **Audit**. Because the UI is served same-origin from
the gateway itself, its HTML/assets load key-free — but every `/admin/api/*` call
still needs the connection-key. The SPA resolves it **desktop-IPC inject → cached
→ one-time paste**: in the Electron desktop app it's injected over IPC (no paste);
in a plain browser it uses a cached key, otherwise it prompts you to paste it once.
You, the local user reaching `/admin`, **are** the human approver.

![The admin overview](assets/screenshots/overview.png)

The **Capabilities** tab is your "what I expose" view — every capability with its
source-class (provenance) and sensitivity:

![What this machine exposes](assets/screenshots/what-i-expose.png)

**To copy the connection-key for an agent**, do any of:

```sh
# Print it (reads ~/.plexus/connection-key; works even while the server is stopped):
bun run start --print-key
# → plx_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# …or read the file directly:
cat ~/.plexus/connection-key
```

The connection-key is a **session-bootstrap secret**, not call authority. An agent
presents it **once** at handshake to open a session, then holds short-lived scoped
tokens for the actual calls. It is **never** served over any agent-reachable HTTP
route (see [security.md](security.md)).

---

## 5. (macOS) Grant the underlying app permission — TCC

First-party Apple sources (`apple-calendar`, `apple-reminders`) read through
macOS, so the **first call** triggers Apple's TCC consent prompt. If access
hasn't been granted, Plexus returns a clear, recoverable message rather than
crashing. Grant access in **System Settings ▸ Privacy & Security**:

- **Calendar** → System Settings ▸ Privacy & Security ▸ **Automation** (allow
  Plexus to control "Calendar") **and** ▸ **Calendars**.
- **Reminders** → System Settings ▸ Privacy & Security ▸ **Reminders**.

These are one-time, OS-level approvals — separate from Plexus's own grant model.

---

## 6. Connect your first agent

### The fastest proof: the bundled demo

```sh
bun run examples/min-agent/run.ts
```

This boots its own throwaway gateway + temp vault and prints the whole
`DISCOVER → handshake → grant → invoke` loop — including the deliberate
**un-granted invoke that gets denied** (default-deny) and the **granted read**
returning real note content. It's the self-contained end-to-end proof.

### Drive a real agent against YOUR gateway — the raw protocol

Any agent speaks the same four HTTP steps. Here's the exact flow with `curl`
against the gateway you started in step 3. Every request sends
`Host: 127.0.0.1:7077` — the gateway's Host/Origin guard rejects anything else.

We'll use the first-party **Apple Calendar** read `apple-calendar.events.list`
(no setup beyond the TCC grant in step 5).

**Step 1 — DISCOVER** (no auth):

```sh
curl -s -H "Host: 127.0.0.1:7077" \
  http://127.0.0.1:7077/.well-known/plexus
# → { "gateway": {...}, "capabilities": [ { "id": "apple-calendar.events.list", ... }, ... ],
#     "auth": { "handshakeUrl": ".../link/handshake", "grantsUrl": ".../grants",
#               "invokeUrl": ".../invoke", ... } }
```

**Step 2 — HANDSHAKE** (connection-key → session + full manifest):

```sh
KEY=$(bun run start --print-key)

curl -s -H "Host: 127.0.0.1:7077" -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:7077/link/handshake \
  -d "{\"connectionKey\":\"$KEY\"}"
# → { "sessionId": "sess_…", "manifest": { "entries": [ … ] }, "grantsUrl": "…", "expiresAt": "…" }
```

Note the `sessionId` — you need it to request grants.

**Step 3 — REQUEST A GRANT** (`PUT /grants`). A first-party **read** is
auto-approved, so you get a scoped token straight back:

```sh
SESSION=sess_…   # from step 2

curl -s -H "Host: 127.0.0.1:7077" -H "Content-Type: application/json" \
  -X PUT http://127.0.0.1:7077/grants \
  -d "{\"sessionId\":\"$SESSION\",\"grants\":{\"apple-calendar.events.list\":\"allow\"}}"
# → { "token": "ey…", "scopes": [...], "jti": "…", "expiresAt": "…" }   (~15 min)
```

The bare `"allow"` normalizes to the capability's required verbs (here, `read`).

**Step 4 — INVOKE** (`POST /invoke`, presenting the token as a Bearer):

```sh
TOKEN=ey…   # the .token from step 3

curl -s -H "Host: 127.0.0.1:7077" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST http://127.0.0.1:7077/invoke \
  -d '{"id":"apple-calendar.events.list","input":{"start":"2026-06-25T00:00:00Z","end":"2026-07-05T00:00:00Z"}}'
# → { "id": "apple-calendar.events.list", "ok": true, "output": { "events": [ … ] } }
```

That's the full loop: **discover → handshake → grant → invoke.** Try
`apple-calendar.calendars.list` (no input) the same way, or `obsidian.vault.read`
once you've added a vault.

> If `/invoke` returns `{ "ok": false, "error": { "code": "...", ... } }`, the
> body is always `InvokeResponse`-shaped on denial — read `ok` and `error.code`.
> A `grant_required` means you skipped step 3; a TCC message means step 5.

### The write-grant flow — pending → approve

`read` on a first-party / managed source flows automatically. A **write** (or any
verb on an agent-registered **extension**) is **default-deny + human approval**.
Request a write, e.g. on `apple-reminders.reminders.create`:

```sh
curl -s -H "Host: 127.0.0.1:7077" -H "Content-Type: application/json" \
  -X PUT http://127.0.0.1:7077/grants \
  -d "{\"sessionId\":\"$SESSION\",\"grants\":{\"apple-reminders.reminders.create\":{\"decision\":\"allow\",\"verbs\":[\"write\"]}}}"
# → { "status": "grant_pending_user", "pendingId": "pend_…", "pending": ["apple-reminders.reminders.create"], ... }
```

Instead of a token you get **`grant_pending_user`**. Now:

1. The request appears in the `/admin` **Pending** tab with a gateway-authored
   card (who, what, how long). Approve it and pick a **trust-window** (the picker
   pre-selects the per-class default — e.g. first-party write `1d`).
2. The agent polls `GET /grants/status?pendingId=pend_…` until the decision is
   terminal; on approval the response carries the minted token.

```sh
curl -s -H "Host: 127.0.0.1:7077" \
  "http://127.0.0.1:7077/grants/status?pendingId=pend_…"
# → { "state": "pending" }   …then after you approve:
# → { "state": "approved", "token": { "token": "ey…", "jti": "…", "expiresAt": "…" } }
```

Only **after** your approval can the agent invoke the write. An agent can never
self-grant a sensitive capability.

A complete reference agent that handles the pending→poll path for you is
[`examples/min-agent/client.ts`](../examples/min-agent/client.ts).

---

## 7. Add your own source (optional)

The Apple sources work out of the box. To expose your notes, add an Obsidian
vault as a **managed source** — from the `/admin` **Sources** tab, the
`@plexus/cli` `plexus source` command, or the launcher shortcut flags:

```sh
# Read-only filesystem vault (no plugin, no secret):
bun run start --vault ~/Documents/MyVault          # ⇒ obsidian.vault.read

# Read-write via the Obsidian Local REST API plugin:
bun run start --obsidian-rest --rest-url https://127.0.0.1:27124
# ⇒ obsidian-rest.vault.{list,read,write}   (write pends for a human)
```

The flags **persist** to `~/.plexus/sources.json` and auto-load on the next boot —
no need to re-pass them. Add `--ephemeral` to register for this run only.
Managed sources hot-appear in `.well-known` and every agent's manifest
immediately — no restart.

---

## Command reference

| Command | What it does |
| --- | --- |
| `bun run start` | Boot the gateway on `127.0.0.1:7077`; print URL + connection-key; stay running. |
| `bun run start --print-key` | Print the connection-key and exit. |
| `bun run start --vault <path>` | Also add an Obsidian vault as a managed read-only source (persists). |
| `bun run start --obsidian-rest` | Also add a managed read-write Obsidian REST source (persists). |
| `bun run start --ephemeral` | With a source flag: register for this run only (don't persist). |
| `bun run start --help` | Show launcher options. |
| `PLEXUS_PORT=N bun run start` | Use port `N` instead of `7077`. |
| `bun run demo` | Run the self-contained end-to-end agent demo. |
| `bash run-tests.sh` | The canonical gate: `bunx tsc --noEmit` + `bun test`. |

All state lives under `~/.plexus/`. To reset: stop the gateway and remove that
directory — the next start regenerates a fresh connection-key + signing secret.

---

## Next steps

- **[concepts.md](concepts.md)** — the full mental model (provenance, the two
  clocks, MCP vs Plexus, the self-describe tiers).
- **[security.md](security.md)** — the trust boundary and threat model. Read this
  before you ever open the gateway to the LAN.
- **[Project README](../README.md)** — the overview and repo map.
