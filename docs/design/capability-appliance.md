# Plexus Capability-Exposure Appliance — Design

> **The official, hardened, single-purpose container that is ITSELF the confinement
> boundary.** The operator mounts ONLY the data to expose, declares a curated capability
> set in a manifest, and the appliance exposes those capabilities (standalone, or as a
> mesh proxy) and **nothing else of the host.**
>
> SSOT for the exposure/security model: [`federated-mesh-domain-model.md`](./federated-mesh-domain-model.md).
> Containerization context: [`phase-4-impl-plan.md`](./phase-4-impl-plan.md).
> Implements: `docker/Dockerfile.appliance`, `packages/runtime/src/appliance/*`, `examples/appliance/*`.

## 1. The scenario

A user does **not** want to expose their whole machine. They want to stand up an official
Plexus container that exposes **only a curated, confined set of capabilities** — e.g. "an
agent may list and read this one folder, and that is all." The appliance is the productized
answer: a least-privilege image whose entrypoint is **manifest-driven**, so the surface is a
declarative allowlist rather than whatever the host happens to have.

## 2. Threat model — "expose a capability, not a system"

The asset is **the host**. The adversary is **a compromised or over-eager agent** (or a
leaked connection-key / mesh join-token) that, given any seam, will try to reach beyond the
capability it was meant to use — read other files, run other tools, pivot to the host.

The appliance's stance is **least privilege + default-deny**, enforced in layers so no single
control is load-bearing:

| Layer | Control | Defeats |
| --- | --- | --- |
| **Host ↔ container** | `docker run` flags: non-root `--user`, `--read-only`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, no host mounts beyond the declared exposure dir(s), `--tmpfs`/small volume for state | container escape, privilege escalation, writing the host, reading un-mounted host paths |
| **Image** | minimal base (no `git`/login-shell tooling, **no `claude`/`codex` binaries**); Linux portable registry gate (P3-1) means only `{cc-master, workspace}` are even scannable; a repo-root **`.dockerignore`** keeps the `COPY . .` build context lean | exec sources (`sandbox-exec`-confined on macOS) are simply **absent** — there is nothing to run; secrets/`.git`/host `node_modules` are **not baked** into the world-readable `/app` layer |
| **Manifest (curation)** | the operator declares the exact sources + capability globs + exposed path(s); the boot wrapper **default-denies** every advertised capability the manifest does not name | an agent discovering/invoking a capability the operator never intended to expose |
| **Data** | only the declared folder(s) are bind-mounted (`:ro` for a read appliance); the `workspace` source is additionally path-confined (lexical `..` reject + `realpath` symlink re-check) | reading/writing outside the one exposed folder, even within the container |
| **Existing gates** | unchanged: connection-key is the agent trust boundary, grants gate invocation, the Host guard pins the loopback authority | unauthenticated/cross-origin access (orthogonal, already in the gateway) |

**Effective exposure = (manifest curates it) ∧ (source is Linux-portable & present) ∧
(exposure not disabled) ∧ (existing granted ∧ exposed gates).** The appliance only ever
*narrows* the stock gateway; it never widens it.

**Default-deny is a STANDING resolver, not a boot-time snapshot.** The boot wrapper installs a
per-id default-exposure resolver (`setDefaultResolver`) so a capability is hidden-by-default
*at the moment it is queried*, not merely disabled if present at boot. This closes the
scan-race / `POST /extensions` / `list_changed` leak where a cap appearing after a one-shot
snapshot would otherwise inherit the local default-**enabled** posture (see §4 step 5).

Residual risks (documented, accepted for v1): the exposed-folder contents themselves are
trusted to the agent within the curated verbs; `/state` on tmpfs means the mesh identity is
ephemeral (use a named volume for a stable proxy identity); the boot wrapper enforces
default-deny at the **exposure** layer, not yet the **registry** layer (see §7 Follow-ups).

## 3. How curation works

The operator writes a **manifest** (JSON) and mounts it read-only. Schema
(`packages/runtime/src/appliance/manifest.ts`):

```jsonc
{
  "version": 1,                       // schema version (only 1 supported)
  "instance": "workspace-appliance",  // optional → PLEXUS_INSTANCE
  "tenant":   "acme",                 // optional → PLEXUS_TENANT
  "workload": "appliance-box",        // optional → PLEXUS_WORKLOAD (addressing segment)
  "sources": [                        // REQUIRED, non-empty — the curated allowlist
    {
      "source": "workspace",          // a first-party source id
      "capabilities": ["workspace.read", "workspace.list"],  // optional cap allowlist (exact or `*` glob); absent ⇒ all caps of the source
      "path": "/data/exposed"         // the confined host data path (workspace → PLEXUS_WORKSPACE_DIR)
    }
  ],
  "upstream": {                       // optional → boot as a mesh PROXY (dials out)
    "url": "wss://primary.example:8443",
    "pubkey": "<pinned-ed25519-key>"  // MANDATORY when upstream is set (no bare-TOFU)
  }
}
```

**Default-deny is the whole point.** `isCapabilityExposed(manifest, {source, id})` returns
true only if the source is curated AND (no cap filter ⇒ whole source, OR a glob matches the
id). Everything unlisted is denied. The manifest **must** name at least one source — an
appliance that exposes nothing is a misconfiguration, rejected at parse time. Any structural
defect (bad version, empty sources, a source with no id, a non-string cap list, an upstream
missing its pinned key, non-JSON) is **rejected fail-closed** with all reasons collected.

Two validation hardenings make the allowlist non-bypassable:

- **Strict unknown-key rejection.** Unknown top-level / per-source / upstream fields are
  rejected, not ignored. This kills the silent-bypass where a typo'd `"capabilites"` would
  leave `capabilities` undefined ⇒ the **whole source** exposed (match-all). The error names
  the offending key and the allowed set.
- **Sensitive-path rejection.** A source `path` equal to or inside a gateway-private container
  dir — `/state` (= `PLEXUS_HOME`: connection-key + token-signing secret + Ed25519 mesh
  identity), `/app` (source tree), `/etc/plexus` (the manifest), or a runtime `PLEXUS_HOME`
  override — is rejected with an actionable error. A `path:/state` would otherwise mount the
  gateway's own secrets into the exposed surface. Mount a **separate** data dir (e.g.
  `/data/exposed`).

## 4. How it boots (the wrapper, public seams only)

`docker/Dockerfile.appliance`'s entrypoint is **not** the stock `src/index.ts`. It is
`packages/runtime/src/appliance/boot.ts`, which:

1. reads the manifest path from the **new** env var `PLEXUS_APPLIANCE_MANIFEST`;
2. parses + validates it (fail-closed — a bad manifest aborts the boot with `exit 2`);
3. **translates** it into the env vars the stock gateway already reads
   (`manifestToEnv` → `PLEXUS_WORKSPACE_DIR`, `PLEXUS_INSTANCE/_TENANT/_WORKLOAD`, and for a
   proxy `PLEXUS_MODE=proxy` + `PLEXUS_UPSTREAM_URL` + `PLEXUS_UPSTREAM_PUBKEY`), applied to
   `process.env` **before** `loadConfig()`;
4. boots through the **same** supervised `startRuntime` seam the stock image uses;
5. **enforces default-deny as a STANDING policy**: it installs a per-id default-exposure
   **resolver** via the public `runtime.state.exposure.setDefaultResolver(...)` seam (the same
   hook mesh zero-exposure uses). The resolver returns `"hidden"` for every capability id whose
   `{source,id}` the manifest does not name (`isCapabilityExposed`), and `undefined` (built-in
   default) for curated ones. Because `.well-known` filters summaries by `exposure.isDisabled`
   (`core/server.ts`) and the invoke pipeline vetoes a disabled id even on the mesh tunnel path
   (`core/pipeline.ts`), the discovery doc and the invoke surface expose **only the curated
   capabilities** — now **and** for any cap that enters the registry *after* boot.

   **Why a resolver, not a one-shot loop (the critical fix).** An earlier version walked
   `capabilities.all()` once and `setEnabled(id, false)` on each non-curated cap. That was an
   *enumerate-and-disable* snapshot, not default-deny: the exposure store **defaults to enabled**
   for local sources, so any capability that landed in the registry *after* the snapshot was
   exposed + invokable, bypassing the allowlist. The leak vectors were all real — (a) the boot
   scan is bounded (`BOOT_SCAN_TIMEOUT_MS`) and finishes in the background, (b) an agent-driven
   `POST /extensions` registers new ids, (c) an MCP `list_changed` / managed-source advertises a
   new tool and re-aggregates. The standing resolver is the load-bearing control: a future cap is
   hidden-by-default unless the manifest names it. It supersedes the mesh resolver wired at state
   construction, which is **safe and strictly stronger** — a mesh-mounted address
   (`mesh:<workload>`) is never named by an appliance manifest, so it too resolves `"hidden"`
   (mesh zero-exposure preserved). The boot wrapper still classifies the already-present caps for
   the operator-facing log, but the resolver (not that loop) is what denies.

This is deliberately self-contained: it edits **no** file owned by another track (`config.ts`,
`core/registry.ts`, `core/exposure.ts`, `sources/index.ts`, `mesh/*`, `platform/*` are all
untouched). It consumes only public seams — the env contract, `startRuntime`, and the public
`CapabilityRegistry` / `ExposureStore` interfaces on `state`. The gating env var
(`PLEXUS_APPLIANCE_MANIFEST`) is new and owned entirely here.

## 5. Standalone vs mesh-proxy

- **Standalone** (no `upstream`): boots as a `primary` (default mode) — its own loopback
  agent surface on `:7077` exposing the curated caps. The agent connects directly. This is
  the "expose one folder to a local agent" case (`examples/appliance/`).
- **Mesh proxy** (`upstream` present): the wrapper sets `PLEXUS_MODE=proxy` +
  `PLEXUS_UPSTREAM_URL` + `PLEXUS_UPSTREAM_PUBKEY`, so the appliance dials a primary
  (NAT-friendly: outbound only, no inbound ports) and ascends its curated caps INTO the mesh,
  where they appear under `tenant/<workload>/source.capability` and default **hidden** until
  the primary's owner enables them (`join ≠ access`, per the domain model §7 Q3). The join
  token is still supplied out-of-band via `PLEXUS_JOIN_TOKEN` (the stock A6 env-enroll path),
  unchanged.

## 6. How this differs from the general `docker/Dockerfile`

| | General gateway (`Dockerfile`) | Appliance (`Dockerfile.appliance`) |
| --- | --- | --- |
| **Purpose** | the stock binary a real VM runs; primary or proxy via `PLEXUS_MODE` | single-purpose, curated exposure boundary |
| **Entrypoint** | `src/index.ts` (stock headless gateway) | `appliance/boot.ts` (manifest-driven wrapper) |
| **Surface** | whatever the operator wires via env | exactly the manifest's allowlist; default-deny |
| **User / fs** | root, writable root fs, `git`+bash tooling | non-root `plexus` (uid 10001), `--read-only`-compatible, minimal deps |
| **Run posture** | publishes mesh ports; broad | `--cap-drop=ALL` + `no-new-privileges` + only the exposure dir mounted |
| **Image tag** | `plexus-gateway:latest` | `plexus-appliance:latest` (never clobbers the shared tag) |

The appliance reuses the stock boot seam and config path verbatim — it is the general image
**minus** privilege **plus** a manifest gate. No behavior of the general image changes.

## 7. Follow-ups (deeper integration, out of scope here)

1. **Registry-level gating.** Today curation is enforced at the *exposure* layer (a
   non-curated cap is scanned then hidden) plus the Linux portable gate. The stronger form is
   to gate the **source registry** so a non-curated source is never even instantiated/scanned.
   That requires a seam in `core/registry.ts` / `sources/index.ts` (owned by another track):
   pass `curatedSourceIds(manifest)` into `activeModulesForPlatform` so only curated modules
   register. The appliance module already exports `curatedSourceIds` for this.
2. **Multi-path sources.** `manifestToEnv` maps a `workspace` source's `path` to
   `PLEXUS_WORKSPACE_DIR`. A second path-bearing source would need either multiple workspace
   instances or a per-source confined-path env; the wrapper currently warns (never silently
   drops) on a non-workspace `path`.
3. **Manifest-as-config-file.** Persisting the manifest into `~/.plexus` and surfacing it in
   the admin UI / `GET /v1/status` so the curated posture is introspectable at runtime.
4. **Signed manifests.** Optionally require the manifest to be signed by the operator's key so
   a tampered mount is rejected, closing the "attacker swaps the mounted manifest" gap.
