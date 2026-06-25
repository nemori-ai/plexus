# `src/sources/` — capability source modules

A **source** is one adapter-managed origin of capabilities: a first-party adapter
(e.g. `obsidian`, `cc-master`), an ingested MCP server (`mcp:<serverId>`), or a
user extension. Every source is reached through the same two-layer adapter model
(`CapabilitySource` + `CapabilityBridge`, protocol §6) and is a **black box** to
the gateway core — the core never branches on source type.

## The `SourceModule` contract

Each source ships a `SourceModule` (canonically from `sources/<id>/manifest.ts`):

```ts
interface SourceModule {
  readonly id: SourceId;            // unique source id, e.g. "obsidian", "mcp:github"
  readonly label: string;
  readonly transport: TransportKind;
  createSource(deps: PlatformServices): CapabilitySource;        // lifecycle layer
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge; // per-session
}
```

- **`createSource(platform)`** builds the **lifecycle-layer** `CapabilitySource`:
  `checkRequirements()` (cheap availability probe via the platform seam), `scan()`
  (enumerate/project entries; for MCP it runs initialize → `*/list` paged to
  exhaustion → re-project verbatim; for a first-party orchestration like cc-master
  it returns the workflow **and** its member entries so transitive grants have real
  targets), `start()`/`stop()` (owns any persistent client), optional
  `onEntriesChanged()` and audited `install()`.
- **`createBridge(deps, sessionId)`** builds a **per-session** `CapabilityBridge`
  that closes over the adapter so the adapter type stays private: `getCapabilities()`,
  `invoke(req, ctx)`, `route(id) → "handled" | "unsupported" | "passthrough"`,
  `disconnect()`. The gateway enforces grants BEFORE calling `invoke()`; the bridge
  translates to the owning `Transport` and normalizes the result, and MUST emit an
  audit event.

## Two-layer base helpers (subclass these — `base.ts`)

t7 ships concrete base classes so a source author writes only what differs:

- **`BaseCapabilitySource`** (lifecycle): implement `scan()`; optionally override
  `checkRequirements()`, and the `onStart()` / `onStop()` hooks (idempotent
  `start()`/`stop()` bookkeeping is handled for you). Call the protected
  `emitEntriesChanged(entries)` when the underlying source signals a live change
  (e.g. an MCP `notifications/tools/list_changed`); every `onEntriesChanged`
  subscriber — including the capability registry — is notified and the registry
  re-aggregates + bumps its revision.
- **`BaseCapabilityBridge`** (per-session): usually just construct it with
  `(sourceId, deps, sessionId, entries)`. Its uniform `invoke()` looks the full
  entry up via `deps.getEntry`, resolves the owning `Transport` via
  `deps.getTransport` (**no branching on transport kind**), threads the re-entrant
  `TransportDispatchContext` (so the `workflow` transport fans out through the same
  pipeline), normalizes the `TransportResult` (mapping MCP `isError:true` →
  `ok:false` + `mcp_tool_error`, preserving the verbatim `mcpResult`), and emits
  exactly **one** redaction-safe audit event. `kind:"skill"` is short-circuited
  (read-as-context, never invoked).

The exported `normalizeResult(id, result, auditId)` helper centralizes the
TransportResult → InvokeResponse mapping for any custom bridge.

## Transport routing config (`entry.extras.route`)

Leaf transports read their per-entry routing from `entry.extras` — a field core
**never** reads. Each transport owns its own `route` shape:

- **cli**: `{ bin, args?, argsFrom?, json?, cwd?, env? }` — `{token}` substitution
  from input; `json:true` appends `--format json` and parses stdout.
- **local-rest**: `{ app?|baseUrl?, defaultPort?, method?, path, bodyFrom?,
  secret? }` — base URL via `PlatformServices.locateLocalService`, secret resolved
  via `PlatformServices.resolveSecret` and attached per its `ExtensionSecretRef`.
- **stdio**: `{ command, args?, cwd?, env? }` — one NDJSON request line in, first
  JSON response line out.
- **ipc**: `{ mode:"unix-socket", socketPath }` (named-pipe / osascript are
  post-v1 honest stubs).
- **mcp**: routing comes from `entry.mcp` (`serverId` + `primitive` + `originName`);
  an optional `extras.mcpLaunch` (`{ command, args, cwd?, env? }`) tells the
  transport how to spawn a stdio server.
- **workflow**: no `route` — fans out over `entry.members[]` via the re-entrant
  pipeline.

## Registering a source

The registry (`src/sources/index.ts`) exports a single `MODULES: SourceModule[]`.
Adding a source =

1. implement `createSource` / `createBridge` under `sources/<id>/` (subclassing the
   `base.ts` helpers),
2. add the module to `MODULES`.

That is the **only** wiring required — `SourceRegistry` (`src/core/registry.ts`)
aggregates `MODULES` and every caller goes through `registry.get(id)` /
`registry.all()` / `registry.getTransport(kind)`. The capability registry
(`src/core/capability-registry.ts`) iterates the modules, calls each `scan()`,
dedupes by id, bumps a monotonic revision on change, and fans changes to
`subscribe()`rs (the core's `/events`).

`MODULES` is **empty after t7** by design — the two-layer base, all transports,
and the macOS platform seam are real, but the first concrete first-party sources
(**cc-master** in t8, **obsidian** in t9) and the MCP-ingestion source land later.
The reference `mockSourceModule` (`sources/mock/manifest.ts`) is the worked example
and the fixture the `tests/adapter-*` suite drives.
