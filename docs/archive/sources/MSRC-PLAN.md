# Managed Sources — Build Plan (`msrc-design` → implementation)

Companion to `MANAGED-SOURCES-DESIGN.md`. Decomposes the work into parallelizable tasks
with crisp FILE OWNERSHIP so they build without collision. Each task names where it
touches registry / state / handlers / admin / management-client / bin / cli.

**Shared seam (build FIRST, then everything else parallelizes):** the new config layer
under `src/sources/config/` plus ONE additive field on `GatewayState`
(`managedSources: ManagedSources`) and ONE additive field on `GatewayState`
(`managedSources` constructed in `createGatewayState`). After Task 0 lands, Tasks 1–5 are
independent.

---

## Task 0 — Config layer + ManagedSources core (the seam)  ★ build first

**Owns (new files):**
- `src/sources/config/types.ts` — `ConfiguredSource`, `SourcesConfigFile`,
  `ConfiguredSourceKind`, `SourceKindAdapter`, `ManageOpts`, `AddResult`.
- `src/sources/config/store.ts` — read/write `~/.plexus/sources.json` (atomic),
  `loadPersistedSources(state)` boot helper.
- `src/sources/config/kinds.ts` — `SOURCE_KINDS` registry + the `obsidian-rest` /
  `obsidian-fs` adapters (wrap the EXISTING `openVaultRestManifest` / `openVaultExtension`).
- `src/sources/config/manage.ts` — `ManagedSources` (list/add/remove/enable/disable/
  reconfigure) with the register-then-persist + rollback logic (DESIGN §4) and the
  write-capable pend/approve routing (DESIGN §7).

**Touches (small, additive edits):**
- `src/core/state.ts` — add `managedSources` to `GatewayState`; construct it in
  `createGatewayState`; call `loadPersistedSources(state)` inside `bootScanCapabilities`
  AFTER `capabilities.start()`.

**Reuses (no edits):** `capability-registry.ts: registerExtension/unregister`,
`paths.ts: atomicWrite/readFileBestEffort/homePath`, `extension.ts: isSafeSecretName`,
`grants.removeForCapability` (purge), `sources/obsidian/*`.

**Deliverable contract for downstream tasks:** `state.managedSources` with the §3
interface; `detectSources` stub exported from `detect.ts` (Task 4 fills detectors).

---

## Task 1 — Boot load + flag bridge (bin)

**Owns:** `bin/plexus` (flag → `manage.add` shortcuts, §2.1), help text, banner note.
**Touches:** `src/index.ts` (no change needed — boot-load lives in `bootScanCapabilities`,
already updated by Task 0; verify the non-launcher entrypoint also benefits).
**Depends on:** Task 0 (`manage.add`, boot-load).
**Registry/state:** consumes `state.managedSources`; no registry edits.
**Fork:** F-1 (keep flags as persisting shortcuts + `--ephemeral`).

---

## Task 2 — Admin API + Sources panel (admin + management-client)

**Owns:**
- `src/core/admin.ts` — new routes: `GET/POST /admin/api/sources`,
  `/sources/:id/{enable,disable,reconfigure}`, `DELETE /sources/:id`,
  `POST /sources/detect`, `POST /admin/api/secrets/:name` (write-only secret ingress,
  `isSafeSecretName` guarded). All call `state.managedSources` / `detectSources`.
- `management-client/src/api.ts` — `api.sources()`, `addSource`, `enable/disable/remove`,
  `reconfigure`, `detect`, `putSecret`; new view types.
- `management-client/src/App.tsx` — new `"sources"` tab + Sources panel (detected
  suggestions, configured list, "Add Obsidian REST" form: baseUrl + API key).
- `management-client/src/icons.tsx` (optional: a sources icon).

**Depends on:** Task 0. **Coordinates with Task 4** on the `DetectedSource`/`detect` shape
(defined in Task 0's `detect.ts` so both compile against it).
**Registry/state:** consumes `state.managedSources`; no registry edits.
**Security:** §7 W-2 (secret-write route) is this task's responsibility to get right.

---

## Task 3 — Admin CLI (`plexus source …`)

**Owns:** `integrations/cli/source-commands.ts` (new) + a `source` dispatch hook in
`integrations/cli/plexus-cli.ts` (one added `case "source"`), `integrations/cli/README.md`
update.
**Depends on:** Task 2's admin routes (the CLI is a thin client over `/admin/api/sources*`,
authenticated by the management connection-key from `~/.plexus/connection-key`).
`--api-key-stdin` reads stdin → `POST /admin/api/secrets/:name`.
**Registry/state:** none (HTTP client only). **Fork:** F-2 (subcommand vs new binary →
recommended subcommand in a separate module).

---

## Task 4 — Detect / scan framework + Obsidian detector

**Owns:** `src/sources/config/detect.ts` — `SourceDetector`, `DetectedSource`,
`DETECTORS`, `detectSources(platform, config)`; the `obsidianRestDetector` (wraps
`platform.locateLocalService({ app:"obsidian" })`) and a thin `ccMasterDetector`
(reads `readCcMasterState()`).
**Touches:** `src/sources/config/kinds.ts` — wire each adapter's optional `detector` into
`DETECTORS` (collection point; agreed with Task 0).
**Depends on:** Task 0 types. **Reuses (no edits):** `platform/darwin.ts: locateLocalService`,
`sources/cc-master/install.ts: readCcMasterState`.
**Registry/state:** none. Pure probes; non-mutating.

---

## Task 5 — Obsidian migration + grant-purge-on-reconfigure + demo

**Owns:**
- Migration wiring: ensure the `obsidian-rest`/`obsidian-fs` kind adapters in
  `kinds.ts` reproduce today's `--obsidian-rest`/`--vault` behavior exactly (Task 0 author
  may stub these; this task verifies parity + write-capability classification).
- `src/sources/config/manage.ts` reconfigure grant-purge (DESIGN §4.2, F-4) — coordinate
  with Task 0 (same file); recommend Task 0 lands the skeleton, Task 5 lands the
  surface-change purge + tests.
- Demo: extend `examples/min-agent/run.ts` (or a new `examples/managed-sources/`) to add
  Obsidian REST via `manage.add`, show it persists + hot-loads + write-pends.
- Docs: update `docs/GETTING-STARTED-macos.md` to the managed-sources flow.

**Depends on:** Tasks 0, 2 (UI), 4 (detect). **Registry/state:** consumes
`state.managedSources` + `state.grants` (purge).

---

## Cross-cutting tests (each task owns its tests; integration test is Task 5)

- Task 0: round-trip `sources.json` read/write; add→register→persist; rollback on
  persist-fail; reconfigure re-register hot-swap; disable keeps-in-file; remove purges
  grants.
- Task 2: secret-write route rejects path-traversal names + is write-only; sources routes
  guarded same-origin.
- Task 4: detector returns reachable Obsidian; non-mutating; `alreadyConfigured` flag.
- Task 5: e2e — add Obsidian REST via management path, restart (re-read config), source
  re-registers, `vault.write` pends; reconfigure baseUrl purges grants.

---

## File-ownership matrix (collision check)

| File | T0 | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|---|
| `src/sources/config/types.ts` | ● | | | | | |
| `src/sources/config/store.ts` | ● | | | | | |
| `src/sources/config/kinds.ts` | ● | | | | ◐ | ◐ |
| `src/sources/config/manage.ts` | ● | | | | | ◐ |
| `src/sources/config/detect.ts` | | | | | ● | |
| `src/core/state.ts` | ● | | | | | |
| `bin/plexus` | | ● | | | | |
| `src/core/admin.ts` | | | ● | | | |
| `management-client/src/{api,App,icons}` | | | ● | | | |
| `integrations/cli/*` | | | | ● | | |
| `examples/**`, `docs/GETTING-STARTED-macos.md` | | | | | | ● |

● = primary owner · ◐ = shared (coordinate). The only shared files are `kinds.ts`
(detector wiring) and `manage.ts` (reconfigure purge) — both inside the config layer one
team owns; sequence T0 → (T4 detector hook, T5 purge). No two outer-layer tasks touch the
same file.

**Recommended sequence:** T0 first (unblocks all). Then T1/T2/T4 fully parallel. T3 after
T2 (CLABI over T2's routes). T5 last (integrates + demos).
