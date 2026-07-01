# Phase 3 — Standalone Linux Gateway Port: Implementation Plan

> Plan doc for the federated-mesh epic, phase 3. SSOT = `federated-mesh-domain-model.md`.
> A Linux gateway parallel to macOS, running as a mesh PROXY (or primary), exposing only
> platform-portable capabilities. Dev/test in Docker ubuntu (`docker/Dockerfile`).

## Headline
The platform seam is **already Linux-ready** (`platform/index.ts:22-33` returns `LinuxPlatformServices`
for `linux`; `platform/linux.ts` is a written impl) and boot is crash-safe (`state.ts:293`
`bootScanCapabilities` `.catch()`-wraps dead sources). The gateway will very likely **import + boot on
Linux today**. P3 is NOT "make it run" — it's **"make it advertise the right capability set"**:
`scan()` returns the UNGATED entry set regardless of `health()`, so a Linux gateway would still
*advertise* dead Apple/exec capabilities. **P3 = platform-gate `MODULES` + settle Linux confinement.**

## The gating decision (verified per-source)
| Source | Linux verdict |
| --- | --- |
| `cc-master` | **KEEP** — spawns `claude`, no osascript/sandbox |
| `workspace` | **KEEP** — path-confined (`realpathSync` lexical), zero darwin refs — the flagship portable cap |
| `apple-calendar`/`apple-reminders`/`things` | **GATE OUT** — osascript/EventKit/`things://` |
| `codex`/`claudecode` | **GATE OUT (P3)** — binary portable but confinement is `sandbox-exec` (`*/launcher.ts:54/61`), NO Linux equivalent. Re-include only behind a real Linux jail (P3-5 follow-on) |
| `mock`/`obsidian` | not in production MODULES |

**Linux portable set after gating = `{cc-master, workspace}`** (+ wire-registered extensions / managed REST). The mesh (`mesh/*`) is pure-TS networking — fully portable.

## P3 task DAG
- **P3-1 — Platform-gate MODULES** [spine]. Filter at registry-build (`core/registry.ts`, keyed on `platform.platform`) with an **allowlist `{cc-master, workspace}`** (not a denylist). Keep gated ids RESERVED cross-platform (`capability-registry.ts:68` `RESERVED_SOURCE_IDS`) but not active — split "reserved id set" (all platforms) from "active module set" (platform-filtered). Accept: on Linux the registry has exactly `{cc-master, workspace}`; `.well-known` advertises zero Apple/exec caps; darwin unchanged (all 7). Test: inject fake `PlatformServices{platform:'linux'}` into `createSourceRegistry`. **Execution-coupled with A4** (A4 runs the gateway importing these files) → serialize after A4; **file-disjoint from the P2 mesh tail (A3/B6/B7)** → parallel with them.
- **P3-2 — Linux proxy boot + e2e** ← P3-1, A3. A Linux-platform-injected proxy boots, enrolls, executes a `workspace`/`cc-master` cap forwarded from the primary. Extend `mesh-e2e-walking-skeleton.test.ts` hermetically (fake linux platform). Soft-dep on the P2 mesh tail (reuses that e2e).
- **P3-3 — Docker Linux smoke** ← P3-1. Ubuntu container: `tsc` clean + `bun test` (Apple/sandbox suites self-skip) + gateway boots in proxy mode advertising `workspace`/`cc-master` only. **ASYNC/CI gate — Docker build is SLOW, do NOT block the DAG on it.**
- **P3-4 — Audit gated tests self-skip on Linux** [independent, ready now]. Verify `tests/{apple-calendar,apple-reminders,things}-source`, `source-codex`, `claudecode-run`, `acceptance-apple-e2e`, `integrations-codex-e2e`, `pomodoro-acceptance` all `it.skipIf(platform!=='darwin')` — none FAIL on Linux. Edits test files only (disjoint from A4's execution + the mesh tail).
- **P3-5 — Linux confinement backend (bwrap) for exec sources** [FOLLOW-ON, deferred past P3]. A `SandboxBackend` seam (darwin→sandbox-exec, linux→bwrap) so codex/claudecode could re-include on Linux with a real kernel jail. Out of the P3 critical path — ship P3 without exec caps on Linux.

## Coupling / parallelism
P3 surface: `sources/index.ts`, `core/registry.ts`, `core/capability-registry.ts`, `platform/*`, source manifests, `docker/`, the gated test files. P2 surface: `mesh/*`, `cli/mesh-commands.ts`. **P3-1/P3-3/P3-4 run fully parallel with the P2 tail** (only P3-2 soft-depends on the P2 mesh e2e). P3-1 serializes after A4 (execution coupling). Prefer the registry-filter approach to avoid touching the shared `protocol/types.ts`.

## Top risks
1. Exec-source confinement has no Linux primitive (security boundary) → gate codex/claudecode OUT (P3-1); bwrap is a tested follow-on (P3-5), never half-shipped.
2. "Advertised but dead" leakage if gating is incomplete → allowlist + `.well-known` assertion (P3-3).
3. Clean import on Linux is static-verified but unvalidated (`linux.ts` e2e was deferred) → the Docker boot (P3-3) is the only honest proof.
4. RESERVED_SOURCE_IDS coupling — keep Apple ids reserved on Linux (anti-squat) while inactive.
5. Slow Docker build → treat P3-3 as async CI, not an inline blocker.
