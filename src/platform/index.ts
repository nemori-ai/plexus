/**
 * Platform-abstraction seam selector (§6b).
 *
 * Selects the PlatformServices implementation by `process.platform` so the core
 * and adapters depend ONLY on the `PlatformServices` interface — no
 * `process.platform` checks leak past this module. v1 ships a concrete macOS impl;
 * Windows/Linux are deferred typed stubs that implement the same seam.
 */

import type { PlatformServices } from "../protocol/index.ts";
import { DarwinPlatformServices } from "./darwin.ts";
import { Win32PlatformServices } from "./win32.ts";
import { LinuxPlatformServices } from "./linux.ts";

export type { PlatformServices };

let _instance: PlatformServices | null = null;

/** Resolve the PlatformServices impl for the current OS (cached singleton). */
export function getPlatformServices(): PlatformServices {
  if (_instance) return _instance;
  switch (process.platform) {
    case "win32":
      _instance = new Win32PlatformServices();
      break;
    case "linux":
      _instance = new LinuxPlatformServices();
      break;
    default:
      // darwin (v1 target) and any other posix — use the macOS impl.
      _instance = new DarwinPlatformServices();
      break;
  }
  return _instance;
}

export { DarwinPlatformServices, Win32PlatformServices, LinuxPlatformServices };
