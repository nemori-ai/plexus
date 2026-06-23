# Managed Sources — Design (task `msrc-design`)

Status: DESIGN ONLY (no implementation). Plexus v0.3.1, gate 336.
Audience: implementers building the managed-sources layer + the project owner.

---

## 0. Problem & thesis

Plexus's thesis is **Scan / Adapt / Describe / Expose**: capability SOURCES should be
*managed via the plugin/extension system*, *scannable*, and *hot-reloadable*. Today the
two real third-party sources — the Obsidian vault (read-only fs) and the Obsidian Local
REST API (read-write) — are wired in through **launcher flags** (`bin/plexus --vault`,
`--obsidian-rest`, `--rest-url`, `--secret-name` + matching `PLEXUS_*` env). That path:

- is **not persisted** — re-supply the flags every boot;
- is **not manageable at runtime** — no add/remove/enable/disable/reconfigure without a
  restart;
- is **not discoverable/scannable** — nothing probes for "is Obsidian REST reachable?";
- lives **outside** the registry/management surface the rest of Plexus already governs.

What we ALREADY have (and must build *above*, not redesign):

| Mechanism | Where | What it gives us |
|---|---|---|
| `registerExtension(manifest, opts)` | `src/core/capability-registry.ts` | live add of a source → registry overlay → invoke routing → revision bump → `manifest_changed` |
| `unregister(sourceId)` | same | live remove → revision bump → `list_changed` |
| `validateRegistration` | same | pure validate-vs-commit seam (default-deny) |
| `materializeExtension` | `src/sources/extension.ts` | manifest → runtime `SourceModule`; `secretRef` by name; `serviceHint`→loopback discovery |
| boot scan | `src/core/state.ts: bootScanCapabilities` | start+scan compile-time `MODULES` at boot |
| pending/approve | `src/core/handlers.ts` (`POST/DELETE /extensions`) + `src/auth/authorizer.ts` | human-in-the-loop confirm of risky/transport-backed sources |
| admin surface | `src/core/admin.ts` + `management-client/**` | same-origin trusted management UI/API |
| detect primitive | `src/platform/darwin.ts: locateLocalService` / `probeTcp` | loopback TCP reachability probe (Obsidian ports 27124/27123) |
| secrets store | `src/platform/darwin.ts: resolveSecret`, `~/.plexus/secrets/<name>` | name-referenced secret resolution |

The missing pieces are exactly three: **persistence**, **management** (3 entry points),
and **scan/detect**. This design adds a thin **config + management + scan layer** over
the existing runtime mechanism. **No wire-protocol redesign. No frozen-type changes** —
everything composes additively (see §1.4).

---

## 1. Persistent source config

### 1.1 File: `~/.plexus/sources.json`

A single JSON document, atomically written via the existing
`src/core/paths.ts: atomicWrite` helper, read via `readFileBestEffort`, sandboxed by the
existing `PLEXUS_HOME` override (tests already rely on it). It sits beside
`connection-key`, `secrets/`, `audit/`, `grants` under the local-first `~/.plexus/` root.

```jsonc
{
  "version": 1,
  "sources": [
    {
      "id": "obsidian-rest",            // SourceId — also the registry/extension source id
      "kind": "obsidian-rest",          // ConfiguredSourceKind (drives the materializer; see §1.3)
      "label": "Obsidian vault (Local REST API, read-write)",
      "enabled": true,                  // disabled ⇒ persisted but NOT registered at boot
      "transport": "local-rest",        // mirrors the materialized manifest's transport
      "route": {                        // kind-specific config (NEVER a secret VALUE)
        "baseUrl": "https://127.0.0.1:27124"
      },
      "secretRef": "obsidian-local-rest-api-key",   // NAME only; value lives in secrets/<name>
      "metadata": {                     // free-form, non-load-bearing: provenance/UI hints
        "addedBy": "detect",            // "detect" | "cli" | "ui" | "api" | "flag-migrated"
        "addedAt": "2026-06-23T10:00:00Z"
      }
    },
    {
      "id": "obsidian",
      "kind": "obsidian-fs",
      "label": "Obsidian vault (~/Notes)",
      "enabled": true,
      "transport": "ipc",
      "route": { "vaultPath": "/Users/me/Notes" },   // path-confined fs root
      "metadata": { "addedBy": "flag-migrated" }
    }
  ]
}
```

### 1.2 `ConfiguredSource` schema (authoritative TypeScript shape)

This type lives in the NEW config layer (`src/sources/config/types.ts`), NOT in the
frozen `protocol/types.ts`. It is a *persistence/management* concept, distinct from the
wire `ExtensionManifest`.

```ts
export type ConfiguredSourceKind = "obsidian-rest" | "obsidian-fs" | string;

export interface ConfiguredSource {
  /** SourceId — the registry id AND the materialized extension's source id. */
  id: SourceId;
  /** Which materializer turns this config → an ExtensionManifest (+ handlers). */
  kind: ConfiguredSourceKind;
  label: string;
  /** Disabled ⇒ persisted but not registered into the live registry. */
  enabled: boolean;
  /** Mirrors the resulting manifest transport (informational + UI). */
  transport: Exclude<TransportKind, "mcp">;
  /** Kind-specific, NON-SECRET route config (baseUrl, vaultPath, defaultPort…). */
  route?: Record<string, unknown>;
  /** NAME of a secret under ~/.plexus/secrets/. NEVER the value. */
  secretRef?: string;
  /** Free-form provenance/UI hints; never load-bearing for security. */
  metadata?: Record<string, unknown>;
}

export interface SourcesConfigFile {
  version: 1;
  sources: ConfiguredSource[];
}
```

### 1.3 Kind → materializer mapping (the only place a "kind" is interpreted)

A `ConfiguredSource` is inert data. A **SourceKindAdapter** turns it into the inputs
`registerExtension` already accepts. This is the single, registry-style table (mirrors
the `MODULES` discipline: no `if (kind === …)` branching anywhere else):

```ts
export interface SourceKindAdapter {
  kind: ConfiguredSourceKind;
  /** Build the wire manifest + (trusted) in-process handlers from persisted config. */
  materialize(cfg: ConfiguredSource): {
    manifest: ExtensionManifest;
    handlers?: Record<string, ExtensionHandler>;
  };
  /** OPTIONAL: contributes a detector to scan/detect (§5). */
  detector?: SourceDetector;
  /**
   * OPTIONAL: classify whether enabling this source is write-capable, so the
   * management path knows to route through the confirming authorizer (§7).
   * Default: derive from the materialized entries' grants (any write/execute ⇒ true).
   */
  isWriteCapable?(cfg: ConfiguredSource): boolean;
}

export const SOURCE_KINDS: SourceKindAdapter[] = [obsidianRestKind, obsidianFsKind];
```

- `obsidian-rest` → `openVaultRestManifest({ baseUrl: route.baseUrl, secretName: secretRef })`
  (already exists in `src/sources/obsidian/open-vault-rest.ts`). No handlers — pure
  `local-rest` transport.
- `obsidian-fs` → `openVaultManifest(route.vaultPath)` + `{ [VAULT_READ_NAME]: vaultReadHandler }`
  (already exists in `src/sources/obsidian/open-vault.ts`).

The existing `openVault*` builders become the materializers; the config layer just feeds
them persisted route data instead of CLI flags. **Zero change to the Obsidian manifest
builders.**

### 1.4 Composition with the frozen protocol types (additive, no edits)

- `ConfiguredSource` is a NEW type in the config layer — it does NOT touch
  `protocol/types.ts`. The frozen `ExtensionManifest`, `SourceModule`, `SourceRegistry`,
  `ExtensionSecretRef`, `LocalServiceHint` are all consumed **as-is**.
- A `ConfiguredSource` is *projected into* a frozen `ExtensionManifest` by its kind
  adapter. The manifest's `secrets: [{ name: secretRef, attach: "bearer" }]` and
  `route.baseUrl` already carry everything the runtime needs.
- Per-source **extras** (provenance, UI hints) live in `ConfiguredSource.metadata` and, if
  ever needed on an entry, in the entry's existing `extras` escape hatch (`route` is
  already `Record<string, unknown>`, read only by the owning transport). This is the same
  "extras/config layer" discipline `applyCrossSourceAttach`/`serviceHint` already use.
- **No frozen-type change is proposed.** (Flag F-3 in §8 notes the ONE place a frozen
  addition might tempt an implementer, with the recommended additive workaround.)

---

## 2. Boot scan — load persisted sources

`bootScanCapabilities(state)` (in `src/core/state.ts`) currently does: `start()` the
registry (scans compile-time `MODULES`) then serve. New boot sequence — **strictly
additive, same function**:

1. **Compile-time MODULES** — unchanged. `state.capabilities.start()` scans
   `MODULES` (cc-master when `claude` is on PATH).
2. **Load persisted sources** — read `~/.plexus/sources.json`. For each `enabled`
   `ConfiguredSource`, look up its `SourceKindAdapter`, `materialize()` it, and call
   `state.capabilities.registerExtension(manifest, { handlers, trusted: true })`. This is
   the **trusted, first-party boot path** (the local user configured these; the wire path
   that *pends* is a different surface — see §7). Disabled sources are skipped (kept in
   the file). A single source that fails to materialize/register logs + is skipped — it
   must never abort boot (same best-effort discipline as the current scan).
3. **Auto-detect probes (OPTIONAL, off by default at boot)** — run §5 detectors in
   *non-mutating* mode and surface results to the management UI as "detected, not added"
   suggestions. Boot does **not** auto-add a detected source (that would silently grant
   discovery surface without user intent). Detection at boot is purely advisory.

The bounded-await behavior (`BOOT_SCAN_TIMEOUT_MS`) is preserved: loading persisted
sources is part of the bounded `start` phase; a slow REST probe can't hang startup.

**New module**: `src/sources/config/store.ts` owns read/write of `sources.json` and the
`loadPersistedSources(state)` boot helper. `bootScanCapabilities` calls it after
`capabilities.start()`.

### 2.1 Flag replacement (the awkward shortcuts)

`bin/plexus`'s `--vault` / `--obsidian-rest` (+ `--rest-url`/`--secret-name`/`PLEXUS_*`)
are **demoted to thin convenience shortcuts over the managed add-and-persist path**, not
a parallel boot path:

- `--vault <path>` ⇒ `manage.add({ kind: "obsidian-fs", id: "obsidian", route: { vaultPath }, enabled: true })`
  then the normal boot-load registers it. (i.e. the flag PERSISTS the source on this boot.)
- `--obsidian-rest [--rest-url --secret-name]` ⇒ `manage.add({ kind: "obsidian-rest", id: "obsidian-rest", route: { baseUrl }, secretRef, enabled: true })`.
- A `--ephemeral` modifier (recommended default OFF) lets the flag register WITHOUT
  persisting, preserving the old "just this run" behavior for scripts/CI.

Recommended: **keep the flags as persisting shortcuts** (least-surprise for existing
users + the `min-agent` demo) and print a one-line "added to managed sources; manage at
/admin" note. They now route through the SAME `manage.add` core as UI/CLI/API, so there
is one code path. See Fork **F-1** for deprecate-vs-keep.

---

## 3. Management surface — three entry points, one core

All three entry points call ONE function so behavior can never diverge:

```ts
// src/sources/config/manage.ts — the single managed-sources service.
export interface ManagedSources {
  list(): ConfiguredSource[];                                   // from config (live status merged in)
  add(cfg: ConfiguredSource, opts?: ManageOpts): Promise<AddResult>;     // persist + hot-register (§4)
  remove(id: SourceId): Promise<void>;                          // unregister + drop from config
  enable(id: SourceId, opts?: ManageOpts): Promise<AddResult>;  // register + flip enabled=true
  disable(id: SourceId): Promise<void>;                         // unregister + flip enabled=false
  reconfigure(id: SourceId, patch: Partial<ConfiguredSource>, opts?: ManageOpts): Promise<AddResult>; // hot-swap (§4.2)
}
```

`ManageOpts` carries the trust/approval context (`{ approvedByHuman?: boolean }`).
`AddResult` carries `{ ok, source, registered, revision, pending?: { pendingId } }` so a
write-capable add that must pend can report it (§7).

It is constructed once in `createGatewayState` and hung on `GatewayState.managedSources`
(additive field), so handlers, admin, and the boot loader share the SAME instance (same
discipline as `state.capabilities`).

### (a) Management-client 'Sources' panel (UI)

New tab in `management-client/src/App.tsx` (`Tab = "capabilities" | "sources" | "pending" | "tokens" | "audit"`)
backed by new methods in `management-client/src/api.ts` and new admin routes in
`src/core/admin.ts`:

- `GET  /admin/api/sources` → `{ sources: ConfiguredSourceView[] }` (config + live status:
  `registered`/`scanning`/`unavailable`, entry count).
- `POST /admin/api/sources` → add (body = `ConfiguredSource` minus secret value).
- `POST /admin/api/sources/:id/enable` · `/disable` · `DELETE /admin/api/sources/:id`.
- `POST /admin/api/sources/:id/reconfigure`.
- `POST /admin/api/sources/detect` → run §5 detectors, return suggestions.
- `POST /admin/api/secrets/:name` → write a secret VALUE to `~/.plexus/secrets/<name>`
  (the ONLY ingress for a secret value; never echoed back, never in any GET). The UI's
  "Add Obsidian REST" form posts `{ baseUrl, apiKey }` → the admin route writes the key
  to `secrets/obsidian-local-rest-api-key`, then `manage.add` with `secretRef` only.

The Sources panel renders: detected-but-not-added suggestions (one-click "Add"), the
configured list with enable/disable/remove/reconfigure, and the "Add Obsidian REST"
form (baseUrl + API key). Because the admin app is the trusted same-origin surface
(connection-key authenticated), the local user IS the human approver — a write-capable
enable from the UI is treated as human-approved (no self-pend) exactly as the admin grant
issuance already auto-approves (`AutoApproveAuthorizer` in `admin.ts`). See §7.

### (b) `plexus source …` admin CLI

The existing `integrations/cli/plexus-cli.ts` is an AGENT driver (discover/grant/invoke).
The admin verbs are a custodial surface, so add a **`source` command group** that calls
the same-origin admin API over loopback, authenticated by the management connection-key
(read from `~/.plexus/connection-key`, as the CLI already locates `~/.plexus`):

```
plexus source list
plexus source add obsidian-rest --base-url https://127.0.0.1:27124 --api-key-stdin
plexus source add obsidian-fs   --vault ~/Notes
plexus source enable  <id>
plexus source disable <id>
plexus source remove  <id>
plexus source reconfigure <id> --base-url https://127.0.0.1:27123
plexus source detect            # probe + print detected sources, offer --add
```

`--api-key-stdin` reads the key from stdin (never argv — argv leaks via `ps`) and POSTs it
to `/admin/api/secrets/<name>`. Recommended home: a **new** `integrations/cli/plexus-source.ts`
(or a `source` subcommand dispatched from `plexus-cli.ts`) so the agent-driver CLI stays
uncluttered. See Fork **F-2**.

### (c) API endpoints

Extend the EXISTING surfaces, do not invent a new namespace:

- **Trusted/local management** → the `/admin/api/sources*` routes above (same-origin,
  connection-key, used by UI + CLI). This is the primary management API.
- **Agent-initiated** (an agent that wants to *propose* adding a source) → reuse
  `POST /extensions`: an agent already can POST an `ExtensionManifest`, which **pends**
  for human approval and, on approval, should ALSO persist via `manage.add` (so an
  agent-installed source survives restart like any other). This is the one behavioral
  addition to the existing `/extensions` flow: **on approve, persist** (§6, §7). The
  `DELETE /extensions/:source` path likewise drops the persisted config.

All three entry points converge on `ManagedSources` → `registerExtension`/`unregister` +
`sources.json` write. No path can persist-without-registering or register-without-persisting
(except the explicit `--ephemeral` and the boot-load-of-already-persisted cases).

---

## 4. Hot-reload semantics — persistence ⇄ live registry in sync

The invariant: **the live registry and `sources.json` are kept in lockstep by
`ManagedSources`, which is the only writer of both.** Every mutating method does the two
sides in a defined order with rollback.

### 4.1 add / enable (register-then-persist with rollback)

```
add(cfg):
  1. resolve SourceKindAdapter(cfg.kind)         // unknown kind ⇒ reject, no mutation
  2. materialize(cfg) → { manifest, handlers }
  3. if write-capable AND not human-approved ⇒ PEND (return pendingId; no register, no persist)  // §7
  4. res = capabilities.registerExtension(manifest, { handlers, trusted: true })   // LIVE: overlay + scan + revision++ + manifest_changed
  5. if !res.ok ⇒ return res (DO NOT persist — a config that won't register is not written)
  6. config.upsert(cfg); atomicWrite(sources.json)   // PERSIST only after a clean live register
  7. if persist throws ⇒ best-effort unregister(cfg.id) + return error (keep the two sides consistent)
```

Order rationale: register first so we never persist a broken source; persist second so a
restart reproduces exactly what is live now. `registerExtension` already bumps the
revision and emits `manifest_changed` (via the `EntrySetChange` → event-bus wiring in
`state.ts`), so connected agents re-fetch `GET /manifest` with **no gateway restart**.

### 4.2 reconfigure (hot-swap, e.g. change baseUrl)

A `ConfiguredSource` materializes to a NEW `ExtensionManifest` for the SAME source id.
`registerExtension` already supports **re-register**: it overwrites
`extensionModules.set(source, module)`, drops the stale `liveSources` entry, and re-scans
(`capability-registry.ts` lines 457–461). So reconfigure is:

```
reconfigure(id, patch):
  1. next = { ...current, ...patch }
  2. if write-capability changed false→true AND not approved ⇒ PEND  // §7
  3. registerExtension(materialize(next).manifest, { handlers, trusted: true })  // RE-register, hot-swaps the module
  4. on ok ⇒ persist next; on fail ⇒ keep the old live module + old config (no half-apply)
```

**Grant-purge note (security-critical):** `registerExtension` re-register does NOT purge
existing grants (only `DELETE /extensions` does, via `handlers.ts: removeForCapability`).
A reconfigure that changes the security surface (new baseUrl/host, new secret) MUST purge
grants for the affected ids so a prior human approval can't silently carry over to a new
endpoint. `ManagedSources.reconfigure` calls `state.grants.removeForCapability(id)` for
each re-registered id when `route.baseUrl`/`secretRef`/transport changed. (See §7, F-4.)

### 4.3 remove / disable

`disable` = `unregister(id)` (live removal, revision bump, `list_changed`) + flip
`enabled:false` in config (kept in file). `remove` = `unregister(id)` + drop from config +
**purge grants** for the removed ids (reuse the `DELETE /extensions` purge logic in
`handlers.ts`). Both go through `ManagedSources` so config and registry stay in sync.

### 4.4 Crash-consistency

`sources.json` is written atomically (`atomicWrite`: temp + rename). The live registry is
in-memory and authoritative *while running*; `sources.json` is authoritative *across
restarts*. If a write fails after a successful register, we roll back the live register
(§4.1 step 7) so a restart never resurrects a source the user couldn't persist. There is
no two-phase-commit requirement because boot deterministically rebuilds the live state
from the file.

---

## 5. Scan / auto-detect framework

A pluggable **detector** interface so more sources plug in later; v1 ships ONE detector
(Obsidian Local REST) + the cc-master availability probe that already exists.

```ts
// src/sources/config/detect.ts
export interface DetectedSource {
  kind: ConfiguredSourceKind;
  /** Suggested id + label + route to pre-fill the "Add" form. */
  suggested: Pick<ConfiguredSource, "id" | "label" | "kind" | "transport" | "route" | "secretRef">;
  /** Human-readable evidence ("reachable at https://127.0.0.1:27124"). */
  evidence: string;
  /** True if a same-id source is already configured (UI shows "configured"). */
  alreadyConfigured: boolean;
  /** Does adding/enabling this require a secret the user must still provide? */
  needsSecret?: { name: string };
}

export interface SourceDetector {
  kind: ConfiguredSourceKind;
  /** NON-MUTATING probe. Returns 0+ candidates. Bounded + best-effort. */
  detect(platform: PlatformServices): Promise<DetectedSource[]>;
}

export const DETECTORS: SourceDetector[] = [obsidianRestDetector /*, ccMasterDetector */];

/** Run every detector, aggregate, mark alreadyConfigured against the live config. */
export async function detectSources(platform, config): Promise<DetectedSource[]>;
```

### 5.1 v1 — Obsidian Local REST detector

Reuses the EXISTING loopback primitive: `platform.locateLocalService({ app: "obsidian" })`
already probes ports 27124/27123 (`darwin.ts: KNOWN_SERVICES` + `probeTcp`) and returns the
reachable loopback `address` (+ the `secretRef` it knows). The detector wraps that:

```
obsidianRestDetector.detect(platform):
  loc = await platform.locateLocalService({ app: "obsidian" })   // loopback-enforced
  if !loc ⇒ []
  return [{
    kind: "obsidian-rest",
    suggested: { id: "obsidian-rest", kind: "obsidian-rest", transport: "local-rest",
                 label: "Obsidian vault (Local REST API)", route: { baseUrl: loc.address },
                 secretRef: "obsidian-local-rest-api-key" },
    evidence: `Obsidian Local REST API reachable at ${loc.address}`,
    alreadyConfigured: config.has("obsidian-rest"),
    needsSecret: { name: "obsidian-local-rest-api-key" },
  }]
```

It detects **reachability** only; it never reads/writes the vault and never auto-adds.
The UI/CLI offer "Add" → the user supplies the API key → `manage.add`. Egress confinement
is unchanged: detection rides the loopback-only `locateLocalService` and the resulting
`baseUrl` is still re-validated (loopback/allow-list) by the `local-rest` transport at
dispatch.

### 5.2 cc-master availability

cc-master is a compile-time `MODULE` already gated by `checkRequirements` (`claude` on
PATH) and installed via the existing `/admin/api/install-cc-master` action. The detector
framework surfaces its availability uniformly (a `ccMasterDetector` reading
`readCcMasterState()` from `src/sources/cc-master/install.ts`) so the Sources panel shows
one consistent "available / installed" view — but cc-master keeps its existing
install action (don't rebuild it; just surface it).

### 5.3 Pluggability

A new source kind ships `{ materialize, detector }` in its `SourceKindAdapter` and is
added to `SOURCE_KINDS` (and its detector auto-collected into `DETECTORS`). No core
branching — same registry discipline as `MODULES`.

---

## 6. Obsidian-REST migration (flag → managed source)

End-state: Obsidian REST is added/managed via UI/CLI/API, persisted in `sources.json`,
hot-loaded at boot, still secure. Concretely:

1. **Materializer reuse** — `obsidian-rest` `SourceKindAdapter.materialize` calls the
   UNCHANGED `openVaultRestManifest({ baseUrl, secretName })`. The manifest already
   references the key by name and routes through the loopback-enforced `local-rest`
   transport.
2. **Add flow** (UI/CLI/API): user supplies `baseUrl` (default
   `https://127.0.0.1:27124`) + API key → key written to
   `~/.plexus/secrets/obsidian-local-rest-api-key` → `manage.add({ kind:"obsidian-rest",
   route:{ baseUrl }, secretRef })` → register (PENDS for human because it is
   write-capable on the wire/agent path; auto-approved on the trusted UI/CLI path) →
   persist.
3. **Boot** — on next start, `loadPersistedSources` re-materializes + re-registers it.
   No flag, no env, no restart-to-reconfigure.
4. **Flag bridge** — `--obsidian-rest` becomes `manage.add(...)` (§2.1) so the old
   command still works but now persists + appears in the Sources panel.
5. **Detector** — `plexus source detect` / the UI "Detect" button finds a running Obsidian
   REST and offers a pre-filled Add (still requires the user to paste the key).
6. **Security carried over verbatim** — `vault.write` keeps `grants:["write"]`, so granting
   it still pends (`UserConfirmAuthorizer`); the secret stays name-only in config; the
   self-signed cert is accepted only because the host is loopback (unchanged transport
   policy).

The read-only `obsidian-fs` kind migrates identically (`--vault` → `obsidian-fs` config),
keeping its in-process path-confined handler.

---

## 7. Security invariants (must preserve) + flags

| Invariant | How this design preserves it |
|---|---|
| **Secrets by reference only** | `ConfiguredSource.secretRef` is a NAME; the value lives in `~/.plexus/secrets/<name>`. `sources.json` is asserted to contain no secret values. The ONLY value-ingress is `POST /admin/api/secrets/:name`; it is write-only (never echoed in any GET). `resolveSecret` is unchanged and still hands the value only to the owning transport at dispatch. Add a `name` safety check (reuse `isSafeSecretName` from `extension.ts`) on the secret-write route to block path traversal. |
| **Write-capable add/enable routes through human confirm** | `ManagedSources` classifies write-capability (any materialized entry with `write`/`execute` grants, or `isWriteCapable`). On the **agent/wire** path (`POST /extensions`) it PENDS via the existing `makeRegisterPending` channel — unchanged linchpin. On the **trusted local** path (admin UI/CLI, connection-key authenticated) the local user IS the human approver, so it auto-approves (same precedent as `admin.ts` grant issuance via `AutoApproveAuthorizer`). Enabling a *persisted-but-disabled* write source from the UI is a deliberate human click ⇒ approved; from the agent path ⇒ pends. |
| **Default-deny + per-capability grants + audit** | Unchanged. Registering a source makes it DISCOVERABLE only; invoking still needs a grant (the authorizer + grant store are untouched). Every add/remove/enable/disable/reconfigure writes a `source.install` audit event (reuse the existing audit type + outcomes: `committed`/`pending`/`unregistered`, add `reconfigured`/`enabled`/`disabled` as `detail` discriminators — no new audit *type* needed). |
| **Egress/loopback confinement** | Unchanged. Detection rides loopback-only `locateLocalService`; the `local-rest` transport still re-validates the resolved + final URL host. A non-loopback `baseUrl` in `sources.json` is still denied `host_forbidden` at dispatch and the secret is never attached. The config layer adds NO new egress path. |
| **Grant purge on surface change** | `remove`/`disable` purge grants (reuse `removeForCapability`). `reconfigure` purges grants for affected ids when the security surface (baseUrl/host, secretRef, transport) changes (§4.2) so a stale approval can't carry to a new endpoint. |
| **No function over the wire** | Unchanged. `materializeExtension` still strips `route.handler` from wire manifests; trusted in-process handlers (obsidian-fs) are bound only via the kind adapter's `handlers` map (the trusted boot/UI/CLI path), never from `sources.json` (which carries data, not functions). |

**Things that could WEAKEN security — flagged:**

- **W-1 (config tamper).** `sources.json` is plaintext under `~/.plexus/`. A local attacker
  who can write it could pre-stage a write-capable source that loads at boot WITHOUT a
  pend (boot uses the trusted path). Mitigation: boot-load is no more privileged than the
  flags it replaces (same trust boundary as anyone who can write `~/.plexus/` already has,
  e.g. `connection-key`). Recommended: at boot, a write-capable source loaded from config
  is registered DISABLED-for-write until first surfaced in the Sources panel? — **No**,
  too surprising; instead **log every write-capable boot-load to audit** so it is visible.
  Document that `~/.plexus/` is the trust root (it already is). Flag for owner: F-4.
- **W-2 (secret-write route).** `POST /admin/api/secrets/:name` is a new value-ingress.
  Must be (a) same-origin + connection-key guarded like every `/admin` route, (b) name
  validated with `isSafeSecretName`, (c) never readable back. Asserted above; called out
  so reviewers verify it.
- **W-3 (agent-persisted sources).** Letting an approved `POST /extensions` persist (§3c)
  means an agent-proposed, human-approved source now survives restart. This is *intended*
  parity, but it widens "what an approval grants" from one session to permanent. Mitigation:
  the approval prompt (PendingRegisterSurface) should say "and persist this source"; audit
  records it. Flag F-5.

---

## 8. Forks for the owner (with recommended defaults)

- **F-1 — Keep vs deprecate `--vault`/`--obsidian-rest` flags.**
  Recommend **keep as persisting shortcuts** (one code path via `manage.add`), add a
  `--ephemeral` opt-out, print a "managed at /admin" note. Deprecation can come later once
  the Sources panel is the obvious path. (Pure deprecation now would break the
  `min-agent` demo + `GETTING-STARTED-macos.md`.)

- **F-2 — Admin CLI home: extend `plexus-cli.ts` vs new `plexus-source.ts`.**
  Recommend a **`source` subcommand dispatched from `plexus-cli.ts`** (one binary, one
  install) but implemented in a separate `integrations/cli/source-commands.ts` module so
  the agent-driver code stays clean. (Avoids a second binary while keeping concerns split.)

- **F-3 — Persist live status in config vs derive at runtime.**
  `ConfiguredSource` deliberately stores only intent (`enabled`), not live status
  (`registered`/`scanning`/`unavailable`). Recommend **derive live status at runtime**
  (from the registry) and never persist it — config = desired state, registry = actual
  state. (Avoids a stale-status frozen-type temptation; this is the one place an
  implementer might want a new field — don't add it.)

- **F-4 — Boot-load of write-capable sources: silent vs audited vs disabled-until-confirmed.**
  Recommend **audited but not re-confirmed** (W-1): boot loads what the user persisted,
  logs write-capable loads to audit. Re-confirming every write source at every boot is
  hostile UX and `~/.plexus/` is already the trust root.

- **F-5 — Should an approved agent-`POST /extensions` persist?**
  Recommend **yes, persist on approve** (parity: an agent-installed source behaves like a
  UI-added one) — with the approval prompt stating persistence and an audit record. If the
  owner prefers stricter semantics, make persistence a separate explicit UI action and keep
  `/extensions` session-scoped (then agent-installed sources vanish on restart until the
  user "pins" them in the Sources panel).

---

## 9. What this design explicitly does NOT change

- The wire protocol, `ExtensionManifest`, `SourceModule`, `SourceRegistry`,
  `ExtensionSecretRef`, and every frozen type — untouched.
- `registerExtension` / `unregister` / `validateRegistration` semantics — reused as-is
  (the only behavioral *addition* is "persist after a clean register", done in the new
  `ManagedSources` wrapper, not in the registry).
- The authorizer, grant store, audit redaction, loopback bind, egress confinement — all
  unchanged.
- The Obsidian manifest builders (`openVault*`) and the cc-master install action — reused
  verbatim as the kind materializers.

This is a config + management + scan layer **above** the existing runtime mechanism, as
required.
