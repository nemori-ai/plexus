/**
 * Workspace FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is the local filesystem; the SOURCE exposes exactly ONE authorized
 * directory as a path-confined surface:
 *   - READ/LIST — `workspace.list`, `workspace.read` (grants:["read"], auto-grant).
 *   - WRITE     — `workspace.write` (grants:["write"]). Because it is a write grant on a
 *     FIRST-PARTY source, it PENDS for the owner automatically via `UserConfirmAuthorizer`
 *     (this source writes NO authz code).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link WorkspaceSource} (lifecycle): `checkRequirements()` + `health()` probe the
 *    authorized directory via the injected provider's `available()` (real ⇒ exists+is-dir;
 *    fake ⇒ ok). Availability is reported via HEALTH — it does NOT gate registration or
 *    hide entries (a missing/unconfigured dir still registers; it shows unavailable).
 *    `scan()` always returns the full UNGATED entry set.
 *  - {@link WorkspaceBridge} (per-session): in-process handlers drive the injected
 *    WorkspaceProvider directly (confined fs list/read/write).
 *
 * Registered in `src/sources/index.ts` MODULES; first-party via the reserved source id
 * (derived from MODULES). The fs-access provider is INJECTABLE: real by default, the FAKE
 * (temp dir) when `PLEXUS_FAKE_WORKSPACE=1` or via an explicit constructor arg — so tests
 * + the e2e probe never reach a real user dir.
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilitySource,
  PlatformServices,
  SourceHealth,
  SourceModule,
  SourceRequirementResult,
} from "@plexus/protocol";
import { BaseCapabilitySource } from "../base.ts";
import { WorkspaceBridge } from "./bridge.ts";
import { WORKSPACE_SOURCE_ID, workspaceEntries } from "./entries.ts";
import { selectWorkspaceProvider, type WorkspaceProvider } from "./provider.ts";

/**
 * Lifecycle-layer source for the workspace. `checkRequirements()` + `health()` derive
 * from the injected provider's `available()` (the authorized dir exists + is a directory
 * in real; always-ok in fake). Availability is HEALTH-only — it never hides entries or
 * blocks registration.
 */
export class WorkspaceSource extends BaseCapabilitySource {
  readonly id = WORKSPACE_SOURCE_ID;
  readonly label = "Workspace";
  // The capabilities are local in-process (ipc); the source-level transport advertises it.
  readonly transport = "ipc" as const;

  private readonly provider: WorkspaceProvider;

  /** `_platform` kept for the SourceModule shape; the fs seam lives in the provider. */
  constructor(_platform: PlatformServices, provider?: WorkspaceProvider) {
    super();
    // Real confined-fs provider by default (root from PLEXUS_WORKSPACE_DIR); fake (temp
    // dir) when PLEXUS_FAKE_WORKSPACE=1; or an explicit injected provider (tests).
    this.provider = selectWorkspaceProvider(provider);
  }

  /**
   * Probe the authorized directory via the provider. `ok` reflects availability, but this
   * is NOT a registration gate — `scan()` always returns the full entry set; an
   * unavailable/unconfigured dir surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, ...(a.reason ? { resolved: a.reason } : {}) }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe via provider `available()`: reachable ⇒ ok; missing/unconfigured dir ⇒
   * unavailable with a precise reason. The fake provider is always ok. Reported via HEALTH
   * only — it never blocks registration.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /** The full UNGATED entry set (list + read + write + the how-to skill). */
  async scan(): Promise<CapabilityEntry[]> {
    return workspaceEntries();
  }
}

/**
 * The workspace SourceModule. Registered in `src/sources/index.ts` MODULES; discovery /
 * availability / scan / invoke routing flow automatically (no core branching).
 */
export const workspaceSourceModule: SourceModule = {
  id: WORKSPACE_SOURCE_ID,
  label: "Workspace",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    return new WorkspaceSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts the workspace capability ids and drives the injected provider
    // directly (fake when PLEXUS_FAKE_WORKSPACE=1, else real); the skill takes the base path.
    return new WorkspaceBridge(deps, sessionId, workspaceEntries());
  },
};
