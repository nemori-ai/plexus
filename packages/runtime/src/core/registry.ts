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
} from "@plexus/protocol";
import type { PlatformServices } from "../platform/index.ts";
import {
  type SandboxBackend,
  selectSandboxBackend,
} from "../platform/sandbox-backend.ts";
import { activeModulesForPlatform } from "../sources/index.ts";
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

/** Options for `createSourceRegistry` (P3-5 — inject the exec-confinement backend). */
export interface SourceRegistryOptions {
  /**
   * The exec-source confinement backend whose availability gates the Linux exec sources
   * (`codex`/`claudecode`). Default: `selectSandboxBackend(platform.platform)` — on Linux
   * a `LinuxSandboxBackend` that probes for a working `bwrap`; on darwin/win32 the
   * sandbox-exec backend (consulted only for Linux gating). Tests inject a backend whose
   * `isAvailableSync()` is mocked, so they never depend on a real `bwrap`.
   */
  sandbox?: SandboxBackend;
}

/**
 * Build the registry from the PLATFORM-FILTERED active `MODULES` set + the transport
 * map for the given platform. The single sanctioned aggregation point.
 *
 * P3-1 — reserved-vs-active split: `activeModulesForPlatform` registers only the modules
 * that actually run on the host (on `linux` the portable allowlist `{cc-master,
 * workspace}`; on `darwin`/`win32` the full set), so a Linux gateway never SCANS or
 * ADVERTISES dead Apple/exec capabilities. The FULL `MODULES` id set stays RESERVED on
 * every platform (anti-squat) via `RESERVED_SOURCE_IDS` in `core/capability-registry.ts`
 * — gating is a registry-build filter, not an id change.
 *
 * P3-5 — exec-confinement gate: on Linux the exec sources (`codex`/`claudecode`) re-join
 * the active set ONLY when a working `bwrap` confinement backend is available
 * (`sandbox.isAvailableSync()`); when `bwrap` is absent they stay gated OUT exactly like
 * before P3-5 (anti-"advertised but unjailed"). The probe is consulted ONLY on Linux —
 * darwin/win32 keep the full set unchanged.
 */
export function createSourceRegistry(
  platform: PlatformServices,
  opts: SourceRegistryOptions = {},
): SourceRegistry {
  const execConfinementAvailable =
    platform.platform === "linux"
      ? (opts.sandbox ?? selectSandboxBackend(platform.platform)).isAvailableSync()
      : true;
  const modules = activeModulesForPlatform(platform.platform, { execConfinementAvailable });
  return new DefaultSourceRegistry(modules, platform);
}
