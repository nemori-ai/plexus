/**
 * GatewayState — the wired-together bundle of core stores/seams shared by the
 * endpoint handlers and the invoke pipeline. Constructed once per `createApp`.
 *
 * This is the composition root for the t6 core: it owns the source registry
 * (consumed read-only through its frozen interface), the capability registry, the
 * audit writer, the session/grant/revocation stores, the connection-key store, and
 * the event bus. The endpoint handlers in `server.ts` read from here; the invoke
 * pipeline closes over it.
 */

import type { SourceRegistry, GatewayMode, SourceId, SourceModule } from "@plexus/protocol";
import type { GatewayConfig } from "../config.ts";
import { getPlatformServices } from "../platform/index.ts";
import { createSourceRegistry } from "./registry.ts";
import {
  createMeshRuntime,
  createMeshBridgeModule,
  MESH_BRIDGE_SOURCE_ID,
  type MeshRuntime,
  type MeshRuntimeOptions,
} from "../mesh/runtime.ts";
import { MeshTransport } from "../transports/mesh.ts";
import {
  createCapabilityRegistry,
  type CapabilityRegistry,
} from "./capability-registry.ts";
import { createAuditWriter, type AuditWriter, type JsonlAuditWriterLike } from "../audit/index.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";
import { createGrantStore, type GrantStore } from "./grants.ts";
import { createExposureStore, type ExposureStore } from "./exposure.ts";
import { createAgentSubsetStore, type AgentSubsetStore } from "./agent-subset.ts";
import { createDefaultGrantStore, type DefaultGrantStore } from "./default-grant.ts";
import { createExtensionStore, type ExtensionStore } from "./extension-store.ts";
import {
  createRevocationRegistry,
  setConfiguredTokenLifetimeMs,
  type RevocationRegistry,
} from "../auth/index.ts";
import { createEventBus, type EventBus } from "./events.ts";
import {
  createConnectionKeyStore,
  type ConnectionKeyStore,
} from "./connection-key.ts";
import {
  createAgentEnrollmentRegistry,
  type AgentEnrollmentRegistry,
} from "./agent-enrollment.ts";
import {
  createManagedSources,
  type ManagedSources,
} from "../sources/config/manage.ts";

export interface GatewayState {
  readonly config: GatewayConfig;
  /**
   * THE AUTHORITY MODE (mesh §0, Invariant A) — surfaced from `config.mode` and
   * boot-fixed (read once at `loadConfig`, never mutated). `"primary"` is today's
   * behavior exactly; `"proxy"` is a subordinate that dials an upstream. Exposed as a
   * first-class field on the wired state so downstream subsystems read the mode
   * directly without reaching through `config`. The actual mesh subsystem (tunnel
   * dial/enrollment) is built in T4+; here it is purely the boot-fixed intent.
   */
  readonly mode: GatewayMode;
  readonly sources: SourceRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly audit: AuditWriter;
  readonly sessions: SessionStore;
  readonly grants: GrantStore;
  /**
   * Top-level capability EXPOSURE policy ("What I expose") — the owner's per-capability
   * enable/disable switch. The OUTERMOST gate, intersected with the grant model:
   * effective access = granted ∧ exposed. A disabled capability is invisible in
   * discovery, ungrantable, and uninvokable (even with a still-valid token); the grant
   * record is preserved so re-enabling restores access. Persisted to `exposure.json`.
   */
  readonly exposure: ExposureStore;
  /**
   * Per-agent AUTHORIZED-SUBSET store (`docs/design/agent-authorized-subset.md`) — the
   * owner-declared set of capabilities ONE agent may reach, written at connect. The
   * agent's discovered manifest is scoped to this subset, and a `PUT /grants` outside it
   * is DENIED. An agent with NO record is UN-SCOPED (legacy behavior preserved); every
   * new connect writes a record. Persisted to `~/.plexus/agent-subsets.json`.
   */
  readonly agentSubsets: AgentSubsetStore;
  /**
   * `default-grant` policy ("pre-check this capability at connect") — the owner's
   * per-capability default for the connect wizard (`docs/design/agent-authorized-subset.md`
   * §3.1). Orthogonal to exposure; a default for the UI only, never a runtime authorization.
   * Persisted to `~/.plexus/default-grants.json`.
   */
  readonly defaultGrants: DefaultGrantStore;
  readonly revocation: RevocationRegistry;
  readonly events: EventBus;
  readonly connectionKey: ConnectionKeyStore;
  /**
   * Per-agent ENROLLMENT ledger (agent-skill-compile §3, Inv III/ADR-3/4) — the
   * agent-facing trust boundary. Mints one-time enrollment codes, redeems them for
   * durable per-agent bearer PATs (stored hashed), verifies PATs → agentId, and
   * revokes a single agent. Distinct from `connectionKey` (admin-only) and the mesh
   * enrollment ledger (proxy keys). Persisted to `~/.plexus/agent-enrollments.json`.
   */
  readonly agentEnrollment: AgentEnrollmentRegistry;
  /**
   * Managed capability-sources service (DESIGN §3) — persists sources to
   * `~/.plexus/sources.json` and keeps them in lockstep with the live registry
   * (register-then-persist with rollback). The single shared instance for
   * handlers, admin, the boot loader, and the flag bridge.
   */
  readonly managedSources: ManagedSources;
  /**
   * Installed-EXTENSION manifest store (`~/.plexus/extensions.json`) — the durable
   * record of ADMIN-installed user extensions (`POST /admin/api/extensions`), so they
   * SURVIVE a gateway restart. The admin install/remove endpoints are the ONLY writers
   * (never the raw `registerExtension`, which also serves non-persistable bundle/tunnel
   * sources); `bootScanCapabilities` REPLAYS each manifest through `registerExtension`
   * after the first-party sources come up. The extension-side mirror of `sources.json`.
   */
  readonly installedExtensions: ExtensionStore;
  /**
   * THE MESH SUBSYSTEM (federated-mesh §3.4, T7). The wired tunnel lifecycle + (on a
   * `primary`) the forward boundary that sends authorized invokes DOWN a proxy's
   * tunnel. Constructed here as an OBJECT only; `mesh.start()` binds the socket (the
   * supervised entrypoint / a test calls it). Absent semantics never change a no-mesh
   * boot — the runtime is inert until started + until an address is mounted.
   */
  readonly mesh: MeshRuntime;
  /**
   * The ACTUAL bound loopback port, set by the supervised entrypoint AFTER the
   * socket binds (REDESIGN-ARCHITECTURE §3.4 / the P0 ephemeral-port gotcha).
   * Until then it is `undefined` and consumers fall back to `config.port`. The
   * `.well-known` baseUrl + `GET /v1/status` report this so an ephemeral `port:0`
   * bind advertises the REAL port, not the requested `0`.
   */
  boundPort?: number;
  /**
   * The interface addresses the listener ACTUALLY bound to (FEAT configurable-
   * binding), set by the supervised entrypoint AFTER the socket binds. `["127.0.0.1"]`
   * for the default loopback-only path; `["0.0.0.0"]` when bound to all interfaces;
   * a list of specific IPs when the user selected interfaces. `GET /admin/api/network`
   * reports this as `active`. Until set it is `undefined` and consumers fall back to
   * `config.bindAddresses`.
   */
  boundAddresses?: readonly string[];
}

/**
 * BOOT REPLAY of admin-installed extensions (restart-survival). After the first-party
 * MODULES + persisted managed sources are up, re-register every extension the admin
 * installed in a prior run (persisted to `~/.plexus/extensions.json`), re-applying the
 * SAME cross-source-attach gate. FAIL-OPEN: a stored manifest that now fails validation
 * (schema drift, a renamed dependency) is logged + SKIPPED — one bad stored extension
 * must never brick boot. A backing service being DOWN never blocks: `registerExtension`
 * projects the manifest's static entries (health probes are separate + background), so
 * the cap enters `.well-known` and health just reports unavailable.
 */
async function replayInstalledExtensions(state: GatewayState): Promise<void> {
  if (typeof state.capabilities.registerExtension !== "function") return;
  for (const ext of state.installedExtensions.list()) {
    const source = ext.manifest?.source ?? "(unknown)";
    try {
      const res = await state.capabilities.registerExtension(ext.manifest, {
        allowCrossSource: ext.allowCrossSource === true,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[extensions] boot-replay: "${source}" did not register — ${res.reason ?? "no entries"}`,
        );
      }
    } catch (err) {
      // A single stored extension failing to replay must NEVER abort boot.
      // eslint-disable-next-line no-console
      console.warn(
        `[extensions] boot-replay: "${source}" failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The startup uptime anchor (process boot) — `GET /v1/status` reports `now - this`. */
const STATE_BORN_AT = Date.now();

/** Set the actual bound port post-listen (REDESIGN-ARCHITECTURE §3.4). */
export function setBoundPort(state: GatewayState, port: number): void {
  (state as { boundPort?: number }).boundPort = port;
}

/** Set the actual bound interface addresses post-listen (FEAT configurable-binding). */
export function setBoundAddresses(state: GatewayState, addresses: readonly string[]): void {
  (state as { boundAddresses?: readonly string[] }).boundAddresses = addresses;
}

/** The wall-clock ms the runtime process has been up (for `GET /v1/status`). */
export function uptimeMs(): number {
  return Date.now() - STATE_BORN_AT;
}

/**
 * Build the gateway state bundle. Accepts an optional pre-built capability
 * registry / source registry so tests can inject a fake in-memory source set
 * (the registry seam is the in-test injection point — t6 has no real sources).
 */
export function createGatewayState(
  config: GatewayConfig,
  overrides?: {
    sources?: SourceRegistry;
    capabilities?: CapabilityRegistry;
    /** Mesh identity/join-token injection (T12) — distinct keys for in-process primary+proxy. */
    mesh?: MeshRuntimeOptions;
  },
): GatewayState {
  const platform = getPlatformServices();
  // Install the clamped, configured token lifetime as `signToken`'s default (ADR-018).
  setConfiguredTokenLifetimeMs(config.auth.tokenLifetimeMs);
  const sources = overrides?.sources ?? createSourceRegistry(platform);
  const capabilities = overrides?.capabilities ?? createCapabilityRegistry(sources);
  const grants = createGrantStore();
  const exposure = createExposureStore();
  const agentSubsets = createAgentSubsetStore();
  const defaultGrants = createDefaultGrantStore();
  const audit = createAuditWriter();

  const state: GatewayState = {
    config,
    // Boot-fixed authority mode (Invariant A): surfaced from config, never mutated.
    mode: config.mode,
    sources,
    capabilities,
    audit,
    sessions: createSessionStore(),
    grants,
    exposure,
    agentSubsets,
    defaultGrants,
    revocation: createRevocationRegistry(),
    events: createEventBus(),
    connectionKey: createConnectionKeyStore(),
    agentEnrollment: createAgentEnrollmentRegistry(),
    // Managed sources share the SAME capability registry + grant store as the rest
    // of the gateway (register-then-persist + grant-purge seam over those stores).
    // The audit writer is shared so write-capable boot-loads are logged (W-1/F-4).
    managedSources: createManagedSources({ capabilities, grants, platform, audit }),
    // Durable record of admin-installed extensions (replayed at boot; §restart-survival).
    installedExtensions: createExtensionStore(),
    // Attached just below (needs `state` by reference); never read before assignment.
    mesh: undefined as unknown as MeshRuntime,
  };

  // Wire the unified-trust posture inputs (ADR-018): the registry derives the
  // `managed` source-class from the LIVE managed-source list, and reads the
  // config-backed default-trust-window table. Injected here so the registry stays
  // decoupled from `managedSources` / config.
  if (typeof capabilities.setPostureInputs === "function") {
    capabilities.setPostureInputs({
      managedSourceIds: () => new Set(state.managedSources.list().map((s) => s.id)),
      defaultTrustWindows: config.auth.defaultTrustWindows,
    });
  }

  // ZERO-EXPOSURE FOR MESH (T6, §7 Q3, plan risk #4) — give the exposure store a per-id
  // default hook keyed on the registry's mesh provenance, so a mesh-MOUNTED address defaults
  // HIDDEN (invisible in discovery until the owner enables it) WITHOUT bloating `exposure.json`
  // and WITHOUT touching local-source default-exposed semantics.
  if (typeof exposure.setDefaultResolver === "function") {
    exposure.setDefaultResolver((id) =>
      typeof capabilities.exposureDefaultFor === "function" ? capabilities.exposureDefaultFor(id) : undefined,
    );
  }

  // GAP A — wire the capability registry's entry-set change subscription onto the
  // event bus so `GET /events` subscribers receive capability-set changes. The
  // registry emits an `EntrySetChange` (revision bump + added/removed/updated ids)
  // on every live re-aggregate (MCP list_changed, a source coming online, an
  // extension registering); we project it to the protocol's `manifest_changed`
  // PlexusEvent (§3b ADR-014) carrying the new revision + the changed-id hint so an
  // agent knows to re-fetch `GET /manifest`.
  if (typeof capabilities.subscribe === "function") {
    capabilities.subscribe((change) => {
      state.events.publish({
        type: "manifest_changed",
        revision: change.revision,
        changed: {
          ...(change.added.length ? { added: change.added } : {}),
          ...(change.removed.length ? { removed: change.removed } : {}),
          ...(change.updated.length ? { updated: change.updated } : {}),
        },
      });
    });
  }

  // GAP P1 (REDESIGN-ARCHITECTURE §2.3) — project every audit append to the
  // management event stream as `audit_appended`. The hook receives the REDACTED,
  // persisted record (the single audit write path already scrubbed it); we publish
  // ONLY id/type/timestamp + correlation ids (never the `detail` blob) so no
  // secret/input material can ride the stream even by accident. The agent stream
  // `GET /events` filters this variant out; only `GET /v1/events` re-emits it.
  if (typeof (audit as JsonlAuditWriterLike).setOnAppend === "function") {
    (audit as JsonlAuditWriterLike).setOnAppend((event) => {
      state.events.publish({
        type: "audit_appended",
        id: event.id,
        auditType: event.type,
        at: event.at,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}),
      });
    });
  }

  // ── MESH (federated-mesh §3.4, T7) ─────────────────────────────────────────────
  // (1) ROUTE mounted addresses to a bridge: a mesh-mounted entry's source is the
  //     synthetic `mesh:<workload>`; wrap `sources.get` so any such id resolves to the
  //     generic mesh bridge (which dispatches the entry through the `mesh` transport).
  //     Composes with the extension overlay (each chains the prior `get`).
  const baseSourcesGet = sources.get.bind(sources);
  const meshBridgeModule: SourceModule = createMeshBridgeModule();
  sources.get = (id: SourceId): SourceModule | undefined =>
    baseSourcesGet(id) ?? (id === MESH_BRIDGE_SOURCE_ID || id.startsWith(`${MESH_BRIDGE_SOURCE_ID}:`) ? meshBridgeModule : undefined);

  // (2) Build the mesh runtime (object only — `mesh.start()` binds the tunnel) and
  //     attach it to the wired state.
  (state as { mesh: MeshRuntime }).mesh = createMeshRuntime(state, overrides?.mesh ?? {});

  // (3) CONFIGURE the `mesh` transport's forward boundary: translate a mounted address
  //     back to its bare id (the registry's authoritative inverse) and forward down the
  //     enrolled proxy's tunnel via the runtime. Inert on a proxy (no server) + until a
  //     primary's tunnel is started — a dispatch then returns a clean capability_unavailable.
  const meshTransport = sources.getTransport("mesh");
  if (meshTransport instanceof MeshTransport && typeof capabilities.forwardAddress === "function") {
    meshTransport.configure({
      resolveTarget: (address) => capabilities.forwardAddress(address),
      forwarder: state.mesh.forwarder,
    });
  }

  // Connection-key rotation invalidates sessions under the old key and enqueues
  // their tokens' jtis for revocation (review #8), pushing a token_revoked event.
  state.connectionKey.onRotate((oldKey) => {
    const jtis = state.sessions.invalidateByKey(oldKey);
    for (const jti of jtis) {
      state.revocation.revoke(jti, "connection-key rotated");
      state.events.publish({ type: "token_revoked", jti, reason: "connection-key rotated" });
    }
  });

  return state;
}

/** Bounded await for the initial boot scan (a source's PATH probe can be a login-shell
 * hit; keep startup from hanging unreasonably). On timeout we proceed serving — the
 * scan keeps running and will emit `manifest_changed` when it lands. */
const BOOT_SCAN_TIMEOUT_MS = 5000;

/**
 * FIRST-RUN BOOT SCAN (m5fix). Start + scan the capability registry once at gateway
 * boot so the available first-party `MODULES` sources (claudecode when `claude` is on
 * PATH) populate `.well-known` + the `/admin` manifest immediately on a plain boot —
 * no `--vault`/extension needed.
 *
 * SECURITY: scanning makes capabilities DISCOVERABLE only; it does NOT auto-grant
 * anything. Grants are still required to invoke (the authorizer + per-capability
 * grants are unchanged), and `.well-known` still serves SUMMARIES only.
 *
 * Awaits the initial scan (bounded) so the FIRST `.well-known` GET is correct/
 * deterministic; if the (slow) login-shell PATH probe exceeds the bound we serve
 * immediately and let the in-flight scan populate + emit `manifest_changed`.
 * Idempotent: `start()` is safe to call once at boot. Best-effort — a scan failure
 * must never abort startup (the registry simply stays empty, degrading gracefully
 * when e.g. `claude` is absent).
 */
export async function bootScanCapabilities(state: GatewayState): Promise<void> {
  // Phase 1 (unchanged): start + scan the compile-time MODULES sources, THEN
  // additively load persisted enabled managed sources (DESIGN §2). Both are part of
  // the bounded `start` phase so a slow REST source can't hang startup, and a single
  // source failing to register never aborts boot.
  const scan = state.capabilities
    .start()
    .then(() => state.managedSources.loadPersisted())
    .then(() => replayInstalledExtensions(state))
    .then(() => {
      /* loaded ids are best-effort; nothing further to do at boot */
    })
    .catch(() => {
      /* a source that fails to start/scan/load contributes no entries; never abort boot */
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((res) => {
    timer = setTimeout(res, BOOT_SCAN_TIMEOUT_MS);
  });
  await Promise.race([scan, bound]);
  if (timer) clearTimeout(timer);
}
