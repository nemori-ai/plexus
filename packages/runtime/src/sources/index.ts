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
import { appleCalendarSourceModule } from "./apple-calendar/manifest.ts";
import { appleRemindersSourceModule } from "./apple-reminders/manifest.ts";
import { thingsSourceModule } from "./things/manifest.ts";
import { workspaceSourceModule } from "./workspace/manifest.ts";

/**
 * The compile-time registered PRODUCTION source modules. Still EMPTY in t7: the
 * two-layer adapter base + transports + platform seam are now real, but the first
 * concrete first-party sources (cc-master in t8, obsidian in t9) and the
 * MCP-ingestion source land in later tasks. User extensions register at runtime
 * via `POST /extensions` and are materialized into additional `SourceModule`s by
 * the extension subsystem.
 */
export const MODULES: SourceModule[] = [
  ccMasterSourceModule,
  appleCalendarSourceModule,
  appleRemindersSourceModule,
  thingsSourceModule,
  workspaceSourceModule,
];

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

// apple-calendar first-party READ-ONLY source (macOS Calendar via osascript/JXA; fake
// provider under PLEXUS_FAKE_APPLE=1). Read-only by construction (grants ["read"]).
export { appleCalendarSourceModule, AppleCalendarSource } from "./apple-calendar/manifest.ts";
export {
  appleCalendarEntries,
  APPLE_CALENDAR_SOURCE_ID,
  CALENDARS_LIST_ID,
  EVENTS_LIST_ID,
  CALENDAR_SKILL_ID,
} from "./apple-calendar/entries.ts";

// apple-reminders first-party read+write adapter (macOS Reminders via osascript / fake).
export { appleRemindersSourceModule, AppleRemindersSource } from "./apple-reminders/manifest.ts";
export {
  appleRemindersEntries,
  APPLE_REMINDERS_SOURCE_ID,
  REMINDERS_LIST_ID,
  REMINDERS_CREATE_ID,
} from "./apple-reminders/entries.ts";

// Things 3 first-party adapter — AppleScript READ + URL-scheme WRITE (a distinct
// surface class). The OS-access provider is injectable (fake when PLEXUS_FAKE_APPLE=1).
export { thingsSourceModule, ThingsSource } from "./things/manifest.ts";
export {
  thingsEntries,
  THINGS_SOURCE_ID,
  TODOS_LIST_ID,
  PROJECTS_LIST_ID,
  TODOS_ADD_ID,
  HOW_TO_USE_ID,
} from "./things/entries.ts";
export {
  FakeThingsProvider,
  RealThingsProvider,
  selectThingsProvider,
  buildAddUrl,
  type ThingsProvider,
  type ThingsTodo,
  type ThingsProject,
  type AddTodoArgs,
} from "./things/provider.ts";
export { ThingsBridge } from "./things/bridge.ts";

// workspace first-party adapter — ONE authorized directory, path-confined list/read/write.
// Reads auto-grant; write PENDS for the owner (write grant on a first-party source). The
// fs-access provider is injectable (fake temp-dir when PLEXUS_FAKE_WORKSPACE=1).
export { workspaceSourceModule, WorkspaceSource } from "./workspace/manifest.ts";
export {
  workspaceEntries,
  WORKSPACE_SOURCE_ID,
  WORKSPACE_LIST_ID,
  WORKSPACE_READ_ID,
  WORKSPACE_WRITE_ID,
  WORKSPACE_HOW_TO_USE_ID,
} from "./workspace/entries.ts";
export {
  FakeWorkspaceProvider,
  RealWorkspaceProvider,
  selectWorkspaceProvider,
  resolveWorkspaceRoot,
  WorkspaceConfinementError,
  type WorkspaceProvider,
  type WorkspaceReadResult,
  type WorkspaceWriteResult,
} from "./workspace/provider.ts";
export { WorkspaceBridge } from "./workspace/bridge.ts";
