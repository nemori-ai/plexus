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
