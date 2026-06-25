/**
 * Source module registry — the MODULES map (≈ pneuma `backends/index.ts`).
 *
 * This is the ONLY place capability source modules are aggregated. Each source
 * ships a `SourceModule` (from `sources/<id>/manifest.ts`); add it to MODULES and
 * discovery / availability / scan / invoke routing all flow automatically. NO
 * `if (id === ...)` branching lives outside a source module (§6b).
 *
 * EMPTY for now — first-party adapters (obsidian, cc-master) and the MCP-ingestion
 * source land in t7. User extensions register at runtime via `POST /extensions`
 * and are materialized into additional `SourceModule`s by the extension subsystem.
 */

import type { SourceModule } from "@plexus/protocol";
import { ccMasterSourceModule } from "./cc-master/manifest.ts";
import { appleRemindersSourceModule } from "./apple-reminders/manifest.ts";

/**
 * The compile-time registered PRODUCTION source modules. Still EMPTY in t7: the
 * two-layer adapter base + transports + platform seam are now real, but the first
 * concrete first-party sources (cc-master in t8, obsidian in t9) and the
 * MCP-ingestion source land in later tasks. User extensions register at runtime
 * via `POST /extensions` and are materialized into additional `SourceModule`s by
 * the extension subsystem.
 */
export const MODULES: SourceModule[] = [ccMasterSourceModule, appleRemindersSourceModule];

// Re-export the two-layer adapter base helpers a source author subclasses.
export {
  BaseCapabilitySource,
  BaseCapabilityBridge,
  normalizeResult,
} from "./base.ts";

// The reference/example source — used by `tests/adapter-*` and as the worked
// example real sources are built against. NOT in production MODULES.
export { mockSourceModule, MockSource, mockEntries, MOCK_SOURCE_ID } from "./mock/manifest.ts";

// cc-master first-party orchestration adapter (Acceptance Scenario A / Flow A).
export { ccMasterSourceModule, CcMasterSource } from "./cc-master/manifest.ts";
export { ccMasterEntries, CC_MASTER_SOURCE_ID, ORCHESTRATION_RUN_ID } from "./cc-master/entries.ts";

// apple-reminders first-party read+write adapter (macOS Reminders via osascript / fake).
export { appleRemindersSourceModule, AppleRemindersSource } from "./apple-reminders/manifest.ts";
export {
  appleRemindersEntries,
  APPLE_REMINDERS_SOURCE_ID,
  REMINDERS_LIST_ID,
  REMINDERS_CREATE_ID,
} from "./apple-reminders/entries.ts";
