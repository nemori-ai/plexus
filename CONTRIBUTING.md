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
bun run gate           # THE canonical gate — must be green before you open a PR
                       #   = bunx tsc --noEmit (strict)  +  bun test   (no coverage; fast)
```

`bun run gate` is just `bash run-tests.sh`; run either. A PR is not ready until it
exits 0. The typecheck bar is strict on purpose — the protocol types are the
compiler-enforced contract.

### Testing

The full set of test/quality scripts (defined in `package.json`):

```sh
bun run test           # the full suite (well-known, grants, sources, extensions, …), un-instrumented
bun run test:watch     # the suite in watch mode while iterating
bun run typecheck      # strict typecheck — bunx tsc --noEmit (strict + noUncheckedIndexedAccess)
bun run coverage       # the suite WITH coverage — prints a table + writes coverage/lcov.info
bun run gate           # the canonical gate: typecheck + tests (= bash run-tests.sh)
```

**Coverage.** `bun run coverage` (= `bun test --coverage`) is **opt-in** — the default
`bun test` and the gate stay un-instrumented so they're fast. Coverage settings live in
[`bunfig.toml`](bunfig.toml) under `[test]`: a `text` + `lcov` reporter (lcov lands in
`coverage/`) and a **don't-regress floor** of `coverageThreshold = 0.85` (line + function).
Current coverage is ~**89.6% lines / ~88.0% functions** (731 tests, 69 files); the floor is
rounded down so it fails only on real regression. Raise it as coverage climbs. To run the
gate with the coverage pass too: `bash run-tests.sh --coverage`.

Run the gateway locally to try a change end to end:

```sh
bun run start          # boot on 127.0.0.1:7077, print URL + connection-key, stay running
bun run demo           # the self-contained DISCOVER → GRANT → CALL proof (no setup)
bun run dev            # watch-mode dev server (no launcher banner/vault flow)
```

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

The wire protocol is **frozen at `PLEXUS_PROTOCOL_VERSION = 0.1.3`** and may only ever
change **additively**:

- ✅ Add a **new optional** field to a response/request shape.
- ✅ Add a new endpoint, a new capability kind, a new error code.
- ❌ Remove or rename an existing field, change its type, or make an optional field required.
- ❌ Change the meaning of an existing endpoint or status code.

If your change touches the wire, edit the canonical types under `packages/protocol/`
(never a doc mirror), keep `docs/protocol/PLEXUS-PROTOCOL.md` + `docs/protocol/DECISIONS.md`
in sync, and call out the additive bump in your PR. The agent-facing health fields
(`HealthStatus` / `CapabilityHealth` / the optional `health` on `CapabilityEntry` /
`CapabilitySummary`) **shipped additively in `0.1.2`** — they are part of the frozen
contract, not pending.

---

## Authoring a source module

A capability source is a self-contained module under `packages/runtime/src/sources/<id>/`
(see the existing `obsidian`, `apple-calendar`, `apple-reminders`, `things`, `claudecode`,
`workspace`, `claudecode`, `codex` adapters and `packages/runtime/src/sources/README.md`
for the `SourceModule` contract).
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
