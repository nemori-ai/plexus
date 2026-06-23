/**
 * SourceRegistry — the aggregate registry contract (§6b). The ONLY place source
 * modules and transports are looked up. Every caller goes through `get(id)` /
 * `all()` / `getTransport(kind)`; no `if (id === ...)` / `switch (kind)` lives
 * outside this module + the source modules themselves.
 *
 * The SHAPE is real and typed against the contract; it wraps the (empty in M0)
 * `MODULES` map and the transport map. No business logic beyond lookup.
 */

import type {
  SourceRegistry,
  SourceModule,
  SourceId,
  Transport,
  TransportKind,
} from "../protocol/index.ts";
import type { PlatformServices } from "../platform/index.ts";
import { MODULES } from "../sources/index.ts";
import { buildTransports } from "../transports/index.ts";

class DefaultSourceRegistry implements SourceRegistry {
  private readonly byId: Map<SourceId, SourceModule>;
  private readonly transports: Record<TransportKind, Transport>;

  constructor(modules: SourceModule[], platform: PlatformServices) {
    this.byId = new Map(modules.map((m) => [m.id, m]));
    this.transports = buildTransports(platform);
  }

  all(): SourceModule[] {
    return [...this.byId.values()];
  }

  get(id: SourceId): SourceModule | undefined {
    return this.byId.get(id);
  }

  getTransport(kind: TransportKind): Transport {
    return this.transports[kind];
  }
}

/**
 * Build the registry from the compile-time `MODULES` map (empty in M0) + the
 * transport map for the given platform. The single sanctioned aggregation point.
 */
export function createSourceRegistry(platform: PlatformServices): SourceRegistry {
  return new DefaultSourceRegistry(MODULES, platform);
}
