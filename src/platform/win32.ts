/**
 * Windows implementation of the PlatformServices seam — DEFERRED post-v1
 * (DECISIONS: only the macOS impl ships in v1; interfaces are multi-platform).
 * Typed throw-stubs; the interface shape is real.
 */

import type {
  PlatformServices,
  LocalServiceHint,
  LocalServiceLocation,
  SpawnSpec,
  SpawnedProcess,
} from "@plexus/protocol";

export class Win32PlatformServices implements PlatformServices {
  readonly platform = "win32" as const;

  async resolveBinary(_name: string): Promise<string | undefined> {
    throw new Error("not implemented: win32 platform seam (post-v1)");
  }
  async getEnrichedPath(): Promise<string> {
    throw new Error("not implemented: win32 platform seam (post-v1)");
  }
  async locateLocalService(_hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
    throw new Error("not implemented: win32 platform seam (post-v1)");
  }
  spawnProcess(_spec: SpawnSpec): SpawnedProcess {
    throw new Error("not implemented: win32 platform seam (post-v1)");
  }
  async resolveSecret(_name: string): Promise<string | undefined> {
    throw new Error("not implemented: win32 platform seam (post-v1)");
  }
}
