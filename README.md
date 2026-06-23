# Plexus

> **Local capability gateway.** Plexus is a user-installed, open-source gateway
> that exposes ONE stable, AI-native **self-describe** endpoint so any AI agent can
> **DISCOVER → UNDERSTAND → be GRANTED → CALL** the capabilities of software on
> the user's machine.
>
> Framing: *"MCP = what functions I have; Plexus = how you should use me."* MCP is
> the first-class, privileged ingestion transport; the additive layer —
> `.well-known` self-describe, usage **Skills**, user **extensions**, per-capability
> **scoped grants/tokens** — lives above the MCP wire.

**Stack:** Bun + TypeScript + Hono. macOS first (platform seam is multi-platform).
**Contract:** **`PLEXUS_PROTOCOL_VERSION = 0.1.2`** — the wire was frozen at `v0.1.0`
and every change since (ADR-017 `/invoke`, ADR-018 unified trust model) is **additive**
over that frozen base. See [`docs/protocol/`](docs/protocol/).

The gateway is feature-complete: discovery, handshake, scoped grants/tokens, the
unified trust model (trust-windows, 3-class provenance, sensitivity, the `GET /grants`
ledger — ADR-018), invoke, audit, the same-origin management UI, managed capability
sources (add/remove/enable/hot-reload at runtime), user extensions, and first-party
sources (the Obsidian vault adapters + the cc-master orchestration adapter) are all
real and covered by the test gate.

## Quick start (macOS)

```sh
bun install

# Boot the gateway (loopback only, 127.0.0.1:7077), print the URL + connection-key.
bun run start
# stays running — Ctrl-C to stop

# Add capability sources from the /admin Sources panel or the `plexus source` CLI.
# (The --vault / --obsidian-rest launcher flags are thin shortcuts that persist the
#  same managed source — e.g. open an Obsidian vault read-only at boot:)
bun run start --vault ~/Documents/MyVault

# Copy the connection-key for an agent:
bun run start --print-key

# Prove the whole loop end-to-end (self-contained, no setup):
bun run demo
```

**→ Full walkthrough: [`docs/GETTING-STARTED-macos.md`](docs/GETTING-STARTED-macos.md)**
— install, start, open the `/admin` UI, copy the connection-key, add an Obsidian
vault as a managed source, approve a grant (trust-window picker + the Grants ledger),
connect an agent, and optionally enable cc-master. Every command in it was run on a
real Mac.

First run is automatic: the gateway creates `~/.plexus/` (connection-key, signing
secret, audit log) on first boot — nothing to configure. Override the bind with
env vars: `PLEXUS_PORT` (default `7077`), `PLEXUS_INSTANCE` (friendly name in
`.well-known`). The gateway binds **`127.0.0.1` only** — never `0.0.0.0` — and
enforces a **Host/Origin guard** on every endpoint before auth (DNS-rebinding
defense, §5b). A request without the matching `Host` header is rejected with
`host_forbidden` (403).

The watch-mode dev server (`bun run dev`) runs `src/index.ts` directly without the
launcher banner/vault flow — use it for gateway development, `bun run start` to
actually use Plexus.

## Tests & typecheck

```sh
bash run-tests.sh    # the canonical gate: tsc --noEmit + bun test (exit 0 == green)

# or individually:
bun run typecheck    # bunx tsc --noEmit (strict)
bun test
```

The strictness bar matches what the frozen `types.ts` already passes (`strict: true`
+ `noUncheckedIndexedAccess`).

## Protocol types — single source of truth

The canonical, importable protocol types live at:

```
src/protocol/types.ts        ← THE source of truth (importable module)
src/protocol/index.ts        ← barrel; all source code imports protocol types from here
```

`docs/protocol/types.ts` is now a **re-export mirror** of `src/protocol/types.ts`
(it does `export * from "../../src/protocol/types.ts"`). There is exactly ONE source
of truth; the docs copy never diverges silently. **Edit the canonical module under
`src/protocol/`, never the mirror.** The human-readable contract
([`docs/protocol/PLEXUS-PROTOCOL.md`](docs/protocol/PLEXUS-PROTOCOL.md)) and the ADRs
([`docs/protocol/DECISIONS.md`](docs/protocol/DECISIONS.md)) remain in `docs/`.

## Project layout

```
src/
  index.ts                 gateway entrypoint — boots & serves on loopback
  config.ts                runtime config (loopback bind, port, versions)
  protocol/
    types.ts               ★ CANONICAL frozen contract types (single source of truth)
    index.ts               protocol barrel
  core/
    server.ts              Hono app — full endpoint surface (discovery, handshake, grants, invoke, admin)
    registry.ts            SourceRegistry impl (aggregates MODULES + managed sources + transports)
    capability-registry.ts in-memory entry index (entries by id) + summary projection
    well-known.ts          builds the WellKnownDocument (discovery, §2)
    security.ts            Host/Origin guard middleware (§5b)
    index.ts               core barrel
  sources/
    index.ts               MODULES map (cc-master first-party module; mock reference source)
    config/                managed-source subsystem (detect/store/manage — persists to ~/.plexus/sources.json)
    extension.ts           user-extension source/bridge (wire-registered via POST /extensions)
    obsidian/  cc-master/  first-party source adapters
    README.md              the SourceModule contract
  transports/              one file per TransportKind, + index.ts (kind→Transport map)
    local-rest.ts stdio.ts ipc.ts mcp.ts cli.ts skill.ts workflow.ts
  platform/
    index.ts               PlatformServices selector by OS
    darwin.ts              macOS impl (path-resolver, locate/spawn/secret)
    win32.ts linux.ts      deferred typed stubs (same seam)
    path-resolver.ts       login-shell PATH capture + fallback dirs (from pneuma)
  auth/
    authorizer.ts          Authorizer seam + AutoApproveAuthorizer (v1 stub)
    tokens.ts              scoped-token sign/verify/revocation (§4)
    index.ts
  audit/
    index.ts               append-only JSONL writer + redaction contract (§7)
tests/                     the canonical test gate (well-known, grants, sources, integrations, m4, …)
management-client/         React management UI (Capabilities / Sources / Pending / Grants / Tokens / Audit tabs)
docs/protocol/             contract: types.ts (mirror), PLEXUS-PROTOCOL.md, DECISIONS.md, VERSION, examples/
run-tests.sh               canonical test gate (bash run-tests.sh → exit 0)
```

## Architecture discipline

- **Black box:** the gateway **core never branches on source/transport type**.
  Routing flows through `SourceRegistry.get(id)` / `getTransport(kind)` and the
  two-layer adapter model (`CapabilitySource` lifecycle + `CapabilityBridge`
  per-session) — there is no `if (id === ...)` outside a source module.
- **Seams are real and implemented:** the registry, transport map, platform
  seam, authorizer, and audit-writer are typed against the contract and live. The
  `.well-known` discovery endpoint serves the current capability set; capabilities
  hot-appear as managed sources are added/enabled (no restart). The Windows/Linux
  platform impls remain typed stubs behind the same seam (macOS is the shipped target).
- **Single source of truth** for types, as above.

See [`docs/protocol/PLEXUS-PROTOCOL.md`](docs/protocol/PLEXUS-PROTOCOL.md) §6 for
the adapter-layer architecture and the platform/authorizer/audit seams.
