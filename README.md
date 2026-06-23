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
**Contract:** FROZEN at **M0 `v0.1.0`** — see [`docs/protocol/`](docs/protocol/).

This repository currently contains the **M0 scaffold**: the bootable server, the
typed seams (registry / transports / platform / authorizer / audit), and a green
test gate. Gateway business logic (`/link/handshake`, `/grants`, `/invoke`, adapter
scan/dispatch) is intentionally stubbed (`not implemented` throws) — it lands in
later tasks (t6 core, t7 adapter layer).

## Quick start

```sh
bun install

# Run the gateway (loopback only, default 127.0.0.1:7077).
bun run dev          # watch mode
# or
bun start            # one-shot

# Discover (the one unauthenticated, pre-session endpoint):
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus
```

Override the bind with env vars: `PLEXUS_PORT` (default `7077`), `PLEXUS_INSTANCE`
(friendly name in `.well-known`). The gateway binds **`127.0.0.1` only** — never
`0.0.0.0` — and enforces a **Host/Origin guard** on every endpoint before auth
(DNS-rebinding defense, §5b). A request without the matching `Host` header is
rejected with `host_forbidden` (403).

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
    server.ts              Hono app — endpoint surface; .well-known is REAL, rest stubbed
    registry.ts            SourceRegistry impl (aggregates MODULES + transports)
    capability-registry.ts in-memory entry index (entries by id) + summary projection
    well-known.ts          builds the WellKnownDocument (discovery, §2)
    security.ts            Host/Origin guard middleware (§5b)
    index.ts               core barrel
  sources/
    index.ts               MODULES map (empty in M0; pneuma registry pattern)
    README.md              the SourceModule contract
  transports/              one file per TransportKind, + index.ts (kind→Transport map)
    local-rest.ts stdio.ts ipc.ts mcp.ts cli.ts skill.ts workflow.ts
  platform/
    index.ts               PlatformServices selector by OS
    darwin.ts              macOS impl (path-resolver CONCRETE; locate/spawn/secret stubbed)
    win32.ts linux.ts      deferred typed stubs (same seam)
    path-resolver.ts       login-shell PATH capture + fallback dirs (from pneuma)
  auth/
    authorizer.ts          Authorizer seam + AutoApproveAuthorizer (v1 stub)
    tokens.ts              scoped-token sign/verify/revocation skeleton (§4)
    index.ts
  audit/
    index.ts               append-only JSONL writer skeleton + redaction contract (§7)
tests/
  well-known.test.ts       .well-known returns a valid WellKnownDocument; host guard
  scaffold.test.ts         seams wired (registry/transport map/authorizer)
management-client/         React management UI — DEFERRED to t11 (README only)
docs/protocol/             FROZEN contract: types.ts (mirror), PLEXUS-PROTOCOL.md, DECISIONS.md, VERSION, examples/
run-tests.sh               canonical test gate (bash run-tests.sh → exit 0)
```

## Architecture discipline

- **Black box:** the gateway **core never branches on source/transport type**.
  Routing flows through `SourceRegistry.get(id)` / `getTransport(kind)` and the
  two-layer adapter model (`CapabilitySource` lifecycle + `CapabilityBridge`
  per-session) — there is no `if (id === ...)` outside a source module.
- **Seams are real, logic is stubbed:** the registry, transport map, platform
  seam, authorizer, and audit-writer **shapes** are typed against the contract and
  wired; their behavior throws `not implemented: <task>` until the owning task
  builds it. The `.well-known` discovery endpoint is fully real and serves an
  empty-capabilities document until sources are scanned (t7).
- **Single source of truth** for types, as above.

See [`docs/protocol/PLEXUS-PROTOCOL.md`](docs/protocol/PLEXUS-PROTOCOL.md) §6 for
the adapter-layer architecture and the platform/authorizer/audit seams.
