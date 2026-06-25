# Contributing to Plexus

Thanks for your interest in Plexus — a local, open-source capability gateway that
brokers your machine's software to AI agents over a stable, AI-native protocol. This
guide covers how to build and test, how the repo is laid out, the one inviolable
protocol rule, and what we expect in a PR.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3.0** — the only runtime/toolchain you need.
  `curl -fsSL https://bun.sh/install | bash`, then `bun --version`.
- macOS for the first-party Apple sources and the desktop app. The runtime, protocol,
  CLI, and web-admin packages are platform-independent and develop fine elsewhere
  (the first-party Apple adapters run against a fake provider under `PLEXUS_FAKE_APPLE=1`).

## Build & test

```sh
bun install            # install workspace dependencies

bash run-tests.sh      # THE canonical gate — must be green before you open a PR
                       #   = bunx tsc --noEmit (strict)  +  bun test

# Individually, while iterating:
bunx tsc --noEmit      # strict typecheck (strict: true + noUncheckedIndexedAccess)
bun test               # the full test suite (well-known, grants, sources, extensions, integrations, …)
```

Run the gateway locally to try a change end to end:

```sh
bun run start          # boot on 127.0.0.1:7077, print URL + connection-key, stay running
bun run demo           # the self-contained DISCOVER → GRANT → CALL proof (no setup)
bun run dev            # watch-mode dev server (no launcher banner/vault flow)
```

**A PR is not ready until `bash run-tests.sh` exits 0.** The typecheck bar is strict
on purpose — the protocol types are the compiler-enforced contract.

---

## Monorepo layout

Plexus is a Bun workspace monorepo (`packages/*`):

| Package | Role |
| --- | --- |
| `packages/protocol` | **The keystone.** The wire contract types (`PLEXUS_PROTOCOL_VERSION`, capability/grant/token/manifest shapes). Every other package imports from `@plexus/protocol`. |
| `packages/runtime` | The headless loopback gateway: discovery, handshake, grants, invoke, audit, sources, the admin API, the platform seam. Entry launcher at `packages/runtime/bin/plexus`. |
| `packages/cli` | The `plexus` CLI — `discover` / `manifest` / `skills` / `call`, plus `source`, `extension`, and `bundle` admin sub-CLIs (thin HTTP clients over the admin API). |
| `packages/web-admin` | The React management UI, served same-origin by the runtime. |
| `packages/desktop` | The Electron shell (macOS) — supervises the runtime sidecar, tray, native approval notifications, hosts the admin UI. |

Top-level: `docs/` (design, protocol, getting-started, tutorials), `examples/`
(the minimal reference agent), `tests/`, and `run-tests.sh` (the gate).

---

## The protocol rule: additive-only

The wire protocol is **frozen at `PLEXUS_PROTOCOL_VERSION = 0.1.2`** and may only ever
change **additively**:

- ✅ Add a **new optional** field to a response/request shape.
- ✅ Add a new endpoint, a new capability kind, a new error code.
- ❌ Remove or rename an existing field, change its type, or make an optional field required.
- ❌ Change the meaning of an existing endpoint or status code.

If your change touches the wire, edit the canonical types under `packages/protocol/`
(never a doc mirror), keep `docs/protocol/PLEXUS-PROTOCOL.md` + `docs/protocol/DECISIONS.md`
in sync, and call out the additive bump in your PR. A pending `0.1.3` exists for the
agent-facing health fields — additive, as above.

---

## Authoring a source module

A capability source is a self-contained module under `packages/runtime/src/sources/<id>/`
(see the existing `obsidian`, `apple-calendar`, `apple-reminders`, `things`, `cc-master`
adapters and `packages/runtime/src/sources/README.md` for the `SourceModule` contract).
The core **never branches on source/transport type** — routing flows through the
registry and the two-layer adapter model (`CapabilitySource` lifecycle +
`CapabilityBridge` per session). There is no `if (id === ...)` outside a source module.
Register a production module by adding it to the `MODULES` map in
`packages/runtime/src/sources/index.ts`.

## Authoring an extension (no core change)

End users (and authoring agents) add capabilities at runtime via a manifest — no code
change, no rebuild:

```sh
plexus extension preview ./my-source.json   # validate + show the security surface
plexus extension add     ./my-source.json   # install live
```

The manifest contract for coding agents is served by a running gateway at
`GET /admin/api/extensions/authoring-guide`. See [`docs/extension-authoring.md`](docs/extension-authoring.md).

---

## PR expectations

- **Green gate.** `bash run-tests.sh` passes locally.
- **Tests with behavior.** New behavior comes with tests; bug fixes come with a
  regression test. The suite is the spec.
- **Scoped & described.** One logical change per PR. Explain the *why*, not just the
  *what*; link the relevant ADR/design doc when you touch the protocol or trust model.
- **Respect the seams.** Keep the core black-box: no source/transport branching in the
  core, no secret values in config files (reference by name), no widening of the trust
  model without an ADR.
- **Docs alongside code.** If you add a flag, endpoint, source, or capability, update
  the doc that mentions it.

Thank you for helping make Plexus better.
