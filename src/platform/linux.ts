/**
 * Linux implementation of the PlatformServices seam — DEFERRED post-v1
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

export class LinuxPlatformServices implements PlatformServices {
  readonly platform = "linux" as const;

  async resolveBinary(_name: string): Promise<string | undefined> {
    throw new Error("not implemented: linux platform seam (post-v1)");
  }
  async getEnrichedPath(): Promise<string> {
    throw new Error("not implemented: linux platform seam (post-v1)");
  }
  async locateLocalService(_hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
    throw new Error("not implemented: linux platform seam (post-v1)");
  }
  spawnProcess(_spec: SpawnSpec): SpawnedProcess {
    throw new Error("not implemented: linux platform seam (post-v1)");
  }
  async resolveSecret(_name: string): Promise<string | undefined> {
    throw new Error("not implemented: linux platform seam (post-v1)");
  }
}
