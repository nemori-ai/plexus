/**
 * Core barrel — server bootstrap, registries, discovery builder, security guard,
 * and the t6 request-pipeline/state/store seams.
 */

export { createApp, createAppWithState, type AppOverrides } from "./server.ts";
export { createSourceRegistry } from "./registry.ts";
export {
  createCapabilityRegistry,
  toSummary,
  type CapabilityRegistry,
} from "./capability-registry.ts";
export { buildWellKnown, gatewayInfo, authAdvertisement } from "./well-known.ts";
export {
  hostOriginGuard,
  buildHostOriginPolicy,
  checkHostOrigin,
} from "./security.ts";

// t6 request-pipeline + state seams.
export { createGatewayState, type GatewayState } from "./state.ts";
export { Handlers } from "./handlers.ts";
export { InvokePipeline, PipelineError } from "./pipeline.ts";
export { GrantService } from "./grant-service.ts";
export { buildManifest } from "./manifest.ts";
export { deriveSource } from "./registry-helpers.ts";
export { scopesCover, requiredVerbs } from "./scope.ts";

// Stores.
export { createSessionStore, type SessionStore, type Session, SESSION_LIFETIME_MS } from "./sessions.ts";
export {
  createGrantStore,
  type GrantStore,
  type PersistedGrant,
  normalizeDecision,
  resolveVerbs,
  synthesizeTransitive,
  GRANT_VALIDITY_MS,
} from "./grants.ts";
export { createEventBus, type EventBus } from "./events.ts";
export { createConnectionKeyStore, type ConnectionKeyStore } from "./connection-key.ts";
export {
  plexusHome,
  ensureDir,
  homePath,
  atomicWrite,
  appendLine,
  readFileBestEffort,
} from "./paths.ts";
