# Plexus

> **A local capability gateway for AI agents.** Plexus is a user-installed,
> open-source gateway that exposes **one** AI-native **self-describe** endpoint, so
> any AI agent can **DISCOVER → UNDERSTAND → be GRANTED → CALL** the capabilities of
> the software on *your* machine — under a trust model you can see, scope, and revoke.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Protocol 0.1.2](https://img.shields.io/badge/protocol-0.1.2-555.svg)](docs/protocol/PLEXUS-PROTOCOL.md)
[![Runtime: Bun + TypeScript](https://img.shields.io/badge/runtime-Bun%20%2B%20TypeScript-f9f1e1.svg)](https://bun.sh)
[![Platform: macOS-first](https://img.shields.io/badge/platform-macOS--first-black.svg)](#macos-first-with-a-real-cross-platform-seam)

---

## Why Plexus

MCP answers *"what functions do I have?"* Plexus answers *"how should you use me?"* —
it wraps the functions in **usage knowledge**, a **legible trust model**, and an
**audit trail**, then brokers them to agents over a stable, AI-native protocol.

The point isn't another tool registry. It's the surface no vendor ships a server
for: **the local macOS software you already use.** Plexus turns your Obsidian vault,
your Apple Calendar and Reminders, your Things 3 inbox, and your Claude Code
orchestration into capabilities an agent can discover and call — without you handing
over a blanket key, and without an agent ever self-granting a mutating action.

**Transparency is the product.** Default-deny, per-capability, scoped, revocable,
audited — that trust story *is* the value, not a tax on it.

---

## Quick start (macOS)

Plexus runs on [Bun](https://bun.sh) (≥ 1.3.0). Install Bun if you don't have it
(`curl -fsSL https://bun.sh/install | bash`), then:

```sh
# 1. Install dependencies (workspace monorepo)
bun install

# 2. Boot the gateway — loopback only (127.0.0.1:7077). Prints the URL +
#    connection-key, then stays running (Ctrl-C to stop).
bun run start

# Optionally open an Obsidian vault read-only at boot (persists as a managed source):
bun run start --vault ~/Documents/MyVault

# Print the connection-key for an agent (no server needed — read from ~/.plexus/):
bun run start --print-key

# Prove the whole DISCOVER → GRANT → CALL loop end-to-end (self-contained, no setup):
bun run demo
```

First run is automatic: the gateway creates `~/.plexus/` (connection-key, signing
secret, audit log) on first boot — nothing to configure. Open the management UI at
`http://127.0.0.1:7077/admin` to add sources, approve grants, and read the audit
trail. It's served same-origin from the gateway, so it already holds the
connection-key — you don't paste anything in.

**Desktop app (Electron, macOS):** a tray-resident shell supervises the runtime as a
sidecar and hosts the same admin UI, with native approval notifications. Run it from
the desktop package:

```sh
bun run --cwd packages/desktop start
```

**→ Full walkthrough: [`docs/getting-started.md`](docs/getting-started.md)** — install,
start, copy the connection-key, add an Obsidian vault, approve a grant (with the
trust-window picker), connect an agent, and optionally enable cc-master.

---

## Concepts (the 60-second model)

An agent talks to Plexus in four steps over the frozen wire protocol:

| Step | Endpoint | What happens |
| --- | --- | --- |
| **DISCOVER** | `GET /.well-known/plexus` | Pre-session scan: id, kind, one-line describe, grant cost, transport per capability. No auth. |
| **UNDERSTAND** | `POST /link/handshake` | Present the connection-key → open a session, get the full manifest (describe + I/O schemas + **usage skills**). |
| **be GRANTED** | `PUT /grants` | Request scoped, per-capability access. Mutating grants **pend for a human**; the gateway authors an honest one-line approval narration. Tokens are short-lived (15 min). |
| **CALL** | `POST /invoke` | Invoke with a `Bearer` token → real result → an append-only audit event. |

What you **expose** is modeled as **Connector → Source → Capability**: a managed
source (e.g. an Obsidian vault) registers capabilities (e.g. `obsidian.vault.read`)
that hot-appear in discovery with **no restart**. What you **trust** is a unified
model: per-capability **scoped grants**, **trust-windows** (`once` / `1h` / `1d` /
`7d` / `until-revoked`), **3-class provenance** (first-party / managed / extension),
a **sensitivity** rating, and the **`GET /grants` ledger** where every standing grant
is visible and revocable. The **connection-key is the trust boundary**.

**→ Deep dive: [`docs/concepts.md`](docs/concepts.md)** ·
**Protocol contract: [`docs/protocol/PLEXUS-PROTOCOL.md`](docs/protocol/PLEXUS-PROTOCOL.md)**

---

## What's exposed

**First-party sources** (real, macOS-first, covered by the test gate):

- **Obsidian** — read-only path-confined filesystem read (`obsidian.vault.read`), or
  read-**write** via the Obsidian Local REST API plugin (`obsidian-rest.vault.{list,read,write}`).
- **Apple Calendar** — read-only (`grants:["read"]` by construction).
- **Apple Reminders** — read **and** write.
- **Things 3** — AppleScript read + a narrow URL-scheme write ("append a to-do").
- **cc-master** — Claude Code long-horizon orchestration, launched **headless with an
  embedded plugin** (it never touches your `~/.claude/`).

Each source reports its own **health** (agent-facing field + the admin dashboard via
`GET /admin/api/health`), so an agent — and you — can see when a backing app is
unreachable before a call fails.

**User extensions** — author a manifest, **preview the security surface** (cli bins,
rest hosts, cross-source attaches, per-capability verbs), then install it live:

```sh
plexus extension preview ./my-source.json   # validate + show the security surface (no commit)
plexus extension add     ./my-source.json   # install live (you are the human approver)
plexus extension list
plexus extension remove  my-source
```

Or do all of it from the `/admin` UI. An **authoring guide** for coding agents is
served at `GET /admin/api/extensions/authoring-guide`.

**→ Tutorials:** [connect an agent](docs/tutorials/connect-an-agent.md) ·
[create an extension](docs/tutorials/create-an-extension.md) ·
[first-party sources](docs/tutorials/first-party-sources.md)

---

## Screenshots

**Overview** — the dashboard: what's exposed, what needs you, recent activity.

![Plexus overview](docs/assets/screenshots/overview.png)

**What I expose** — the Connector → Source → Capability surface, with the dynamic
config form for adding a source.

![What I expose](docs/assets/screenshots/what-i-expose.png)

**Create an extension** — author a manifest and preview its security surface before
it ever goes live.

![Create an extension](docs/assets/screenshots/create-extension.png)

---

## Security posture

- **Loopback by default.** The gateway binds `127.0.0.1` only. Binding to a chosen
  NIC or `0.0.0.0` is **opt-in** (`~/.plexus/network.json`), and when you do, **every
  `/admin/api/*` route is connection-key gated** — the connection-key becomes the
  trust boundary for the LAN.
- **Host/Origin guard** on every endpoint before auth (DNS-rebinding defense); a
  request without the matching `Host` is rejected (`host_forbidden`, 403).
- **Default-deny, scoped invoke.** A grant is per-capability and verb-scoped; tokens
  are short-lived. Mutating (`write`/`execute`) grants pend for a human — an agent
  cannot self-grant them.
- **Re-gating on change.** Reconfiguring a source's endpoint/secret purges its grants,
  so a prior approval can't silently carry over to a new target.
- Secrets are stored under `~/.plexus/secrets/` and referenced by **name** — never
  written into config files, never echoed back.

**→ Full write-up: [`docs/security.md`](docs/security.md)**

---

## macOS-first, with a real cross-platform seam

Plexus is a **Bun + TypeScript + Hono** workspace monorepo:

```
packages/
  protocol/    the keystone — the compiler-enforced wire contract (frozen at 0.1.2)
  runtime/     the headless loopback gateway (discovery, grants, invoke, audit, sources)
  cli/         the `plexus` CLI (discover / manifest / skills / call / source / extension / bundle)
  web-admin/   the same-origin React management UI
  desktop/     the Electron shell (macOS) — supervisor + tray + native notifications
```

The OS surface lives behind a single `PlatformServices` seam: macOS is the shipped,
fully-implemented target; the Windows/Linux implementations are typed stubs behind the
**same seam**, so cross-platform is a fill-in, not a rewrite.

The **protocol is frozen at `PLEXUS_PROTOCOL_VERSION = 0.1.2`** and evolves
**additive-only** — new optional fields, never a breaking change to the wire.

---

## Build, test, typecheck

```sh
bash run-tests.sh    # the canonical gate: bunx tsc --noEmit (strict) + bun test
bunx tsc --noEmit    # typecheck only
bun test             # tests only
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the monorepo layout, the additive-only
protocol rule, and how to author a source module or an extension.

---

## Docs

| Doc | What it covers |
| --- | --- |
| [Getting started (macOS)](docs/getting-started.md) | Install → start → connect an agent, end to end. |
| [Concepts](docs/concepts.md) | The self-describe protocol, the trust model, sources & extensions. |
| [Security](docs/security.md) | Loopback boundary, connection-key, Host/Origin guard, re-gating. |
| [Connect an agent](docs/tutorials/connect-an-agent.md) | Drive Plexus from a coding agent. |
| [Create an extension](docs/tutorials/create-an-extension.md) | Author + preview + install a manifest. |
| [First-party sources](docs/tutorials/first-party-sources.md) | Obsidian, Apple Calendar/Reminders, Things 3, cc-master. |
| [Protocol contract](docs/protocol/PLEXUS-PROTOCOL.md) | The frozen wire spec + the ADRs. |

---

## Contributing & conduct

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). This project follows
the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Plexus contributors.
