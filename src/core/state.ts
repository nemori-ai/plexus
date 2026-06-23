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

import type { SourceRegistry } from "../protocol/index.ts";
import type { GatewayConfig } from "../config.ts";
import { getPlatformServices } from "../platform/index.ts";
import { createSourceRegistry } from "./registry.ts";
import {
  createCapabilityRegistry,
  type CapabilityRegistry,
} from "./capability-registry.ts";
import { createAuditWriter, type AuditWriter } from "../audit/index.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";
import { createGrantStore, type GrantStore } from "./grants.ts";
import { createRevocationRegistry, type RevocationRegistry } from "../auth/index.ts";
import { createEventBus, type EventBus } from "./events.ts";
import {
  createConnectionKeyStore,
  type ConnectionKeyStore,
} from "./connection-key.ts";

export interface GatewayState {
  readonly config: GatewayConfig;
  readonly sources: SourceRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly audit: AuditWriter;
  readonly sessions: SessionStore;
  readonly grants: GrantStore;
  readonly revocation: RevocationRegistry;
  readonly events: EventBus;
  readonly connectionKey: ConnectionKeyStore;
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
  },
): GatewayState {
  const platform = getPlatformServices();
  const sources = overrides?.sources ?? createSourceRegistry(platform);
  const capabilities = overrides?.capabilities ?? createCapabilityRegistry(sources);

  const state: GatewayState = {
    config,
    sources,
    capabilities,
    audit: createAuditWriter(),
    sessions: createSessionStore(),
    grants: createGrantStore(),
    revocation: createRevocationRegistry(),
    events: createEventBus(),
    connectionKey: createConnectionKeyStore(),
  };

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

/** Bounded await for the initial boot scan (cc-master's PATH probe is a login-shell
 * hit; keep startup from hanging unreasonably). On timeout we proceed serving — the
 * scan keeps running and will emit `manifest_changed` when it lands. */
const BOOT_SCAN_TIMEOUT_MS = 5000;

/**
 * FIRST-RUN BOOT SCAN (m5fix). Start + scan the capability registry once at gateway
 * boot so the available first-party `MODULES` sources (cc-master when `claude` is on
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
 * when cc-master/`claude` is absent).
 */
export async function bootScanCapabilities(state: GatewayState): Promise<void> {
  const scan = state.capabilities.start().catch(() => {
    /* a source that fails to start/scan contributes no entries; never abort boot */
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((res) => {
    timer = setTimeout(res, BOOT_SCAN_TIMEOUT_MS);
  });
  await Promise.race([scan, bound]);
  if (timer) clearTimeout(timer);
}
