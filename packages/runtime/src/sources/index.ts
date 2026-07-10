/**
 * Source module registry — the MODULES map (≈ pneuma `backends/index.ts`).
 *
 * This is the ONLY place capability source modules are aggregated. Each source
 * ships a `SourceModule` (from `sources/<id>/manifest.ts`); add it to MODULES and
 * discovery / availability / scan / invoke routing all flow automatically. NO
 * `if (id === ...)` branching lives outside a source module (§6b).
 *
 * Registered first-party sources today: apple-calendar, apple-reminders,
 * things, workspace, claudecode, codex, sysinfo, browser. User extensions register at runtime via
 * `POST /extensions` and are materialized into additional `SourceModule`s by the
 * extension subsystem. (A generic "wrap an MCP server as a source" path is roadmap,
 * not yet a registered module — MCP is just one transport carrier alongside http/cli.)
 */

import type { SourceModule, SourceId, PlatformServices } from "@plexus/protocol";
import { appleCalendarSourceModule } from "./apple-calendar/manifest.ts";
import { appleRemindersSourceModule } from "./apple-reminders/manifest.ts";
import { thingsSourceModule } from "./things/manifest.ts";
import { workspaceSourceModule } from "./workspace/manifest.ts";
import { claudecodeSourceModule } from "./claudecode/manifest.ts";
import { codexSourceModule } from "./codex/manifest.ts";
import { sysinfoSourceModule } from "./sysinfo/manifest.ts";
import { browserSourceModule } from "./browser/manifest.ts";

/**
 * The compile-time registered PRODUCTION source modules. Adding one here is all it
 * takes — discovery / availability / scan / invoke routing flow automatically, and
 * the source id becomes reserved (first-party provenance). User extensions register
 * at runtime via `POST /extensions` (materialized into additional `SourceModule`s by
 * the extension subsystem).
 */
export const MODULES: SourceModule[] = [
  appleCalendarSourceModule,
  appleRemindersSourceModule,
  thingsSourceModule,
  workspaceSourceModule,
  claudecodeSourceModule,
  codexSourceModule,
  sysinfoSourceModule,
  browserSourceModule,
];

/**
 * LINUX-PORTABLE module allowlist (P3-1). On a Linux gateway these first-party modules
 * are ALWAYS PORTABLE and therefore ACTIVE (registered → scanned → advertised):
 *  - `workspace`  — path-confined fs access, portable across platforms;
 *  - `sysinfo`    — `ps`/`df`/`os` system reads + pure-code path-jailed log tail, portable
 *                   across Linux + macOS (this is the Linux child's system-resource/syslog API).
 * The macOS-native sources are ALWAYS gated OUT on Linux (no portable backing):
 *  - `apple-calendar` / `apple-reminders` / `things` — macOS osascript/JXA only.
 * An ALLOWLIST (not a denylist) is deliberate: a NEW first-party source defaults to
 * gated-OUT on Linux until it is proven portable, so we never "advertise but dead".
 */
export const LINUX_PORTABLE_MODULE_IDS: ReadonlySet<SourceId> = new Set<SourceId>([
  "workspace",
  "sysinfo",
]);

/**
 * LINUX EXEC sources (P3-5). The exec sources whose confinement is a KERNEL SANDBOX. On
 * macOS that is `sandbox-exec`; on Linux it is `bwrap` (the `LinuxSandboxBackend`). These
 * are active on Linux ONLY when a working `bwrap` jail is available (the availability
 * gate) — when `bwrap` is absent they stay gated OUT exactly like before P3-5
 * (anti-"advertised but unjailed"). See `docs/design/linux-confinement.md`.
 */
export const LINUX_EXEC_MODULE_IDS: ReadonlySet<SourceId> = new Set<SourceId>([
  "codex",
  "claudecode",
]);

/** Options steering the Linux active-module filter (P3-5 exec-confinement gate). */
export interface ActiveModulesOptions {
  /**
   * Whether a real Linux exec-confinement backend (`bwrap`) is available. When true the
   * exec sources (`codex`/`claudecode`) re-join the Linux active set; when false (the
   * default today — bwrap absent) they stay gated OUT. Ignored off Linux.
   */
  execConfinementAvailable?: boolean;
}

/**
 * The platform-FILTERED ACTIVE module set (P3-1/P3-5) — consumed by `createSourceRegistry`
 * with the resolved `PlatformServices` in hand. This is the "active module set" half of
 * the reserved-vs-active split: EVERY id in `MODULES` stays RESERVED on every platform
 * (anti-squat — see `RESERVED_SOURCE_IDS` in `core/capability-registry.ts`, which keys on
 * the full `MODULES` set, NOT on this subset), but only the modules that actually run on
 * the host platform are ACTIVE (scanned/advertised). `darwin`/`win32` keep the full set
 * (unchanged); `linux` keeps the portable allowlist, PLUS the exec sources when (and only
 * when) a working `bwrap` confinement backend is available.
 */
export function activeModulesForPlatform(
  platform: PlatformServices["platform"],
  opts: ActiveModulesOptions = {},
): SourceModule[] {
  if (platform === "linux") {
    const active = new Set<SourceId>(LINUX_PORTABLE_MODULE_IDS);
    if (opts.execConfinementAvailable) {
      for (const id of LINUX_EXEC_MODULE_IDS) active.add(id);
    }
    return MODULES.filter((m) => active.has(m.id));
  }
  return MODULES;
}

// Re-export the two-layer adapter base helpers a source author subclasses.
export {
  BaseCapabilitySource,
  BaseCapabilityBridge,
  normalizeResult,
} from "./base.ts";

// The reference/example source — used by `tests/adapter-*` and as the worked
// example real sources are built against. NOT in production MODULES.
export { mockSourceModule, MockSource, mockEntries, MOCK_SOURCE_ID } from "./mock/manifest.ts";

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
// workspace-dir MANAGED multi-instance builder — expose ANY directory under its own
// source id (`<id>.list|read|write`), path-confined to its own root. The managed kind
// adapter (`sources/config/kinds.ts` → "workspace-dir") materializes through these.
export {
  workspaceDirManifest,
  workspaceDirHandlers,
  workspaceDirHealth,
  normalizeWorkspaceDirRoot,
  manifestWorkspaceDirLiveness,
  WORKSPACE_DIR_KIND,
} from "./workspace/open-dir.ts";
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

// sysinfo first-party READ-ONLY source — a Unix host's system-resource + syslog API.
// processes.list (`ps`) + resources.read (`os`+`df`) + log.read (path-jailed tail). All
// grants:["read"]. PORTABLE (in LINUX_PORTABLE_MODULE_IDS) — the Linux child's surface. The
// system-read provider is injectable (fake canned data when PLEXUS_FAKE_SYSINFO=1).
export { sysinfoSourceModule, SysinfoSource } from "./sysinfo/manifest.ts";
export {
  sysinfoEntries,
  SYSINFO_SOURCE_ID,
  SYSINFO_PROCESSES_LIST_ID,
  SYSINFO_RESOURCES_READ_ID,
  SYSINFO_LOG_READ_ID,
  SYSINFO_HOW_TO_USE_ID,
} from "./sysinfo/entries.ts";
export {
  FakeSysinfoProvider,
  RealSysinfoProvider,
  selectSysinfoProvider,
  resolveLogRoot,
  parsePsOutput,
  parseDfOutput,
  tailLines,
  readLogTail,
  LOG_TAIL_MAX_BYTES,
  clampTop,
  clampLines,
  realCommandRunner,
  SysinfoConfinementError,
  SysinfoUnavailableError,
  type SysinfoProvider,
  type CommandRunner,
  type ProcessRow,
  type ResourceSnapshot,
  type LogTailResult,
} from "./sysinfo/provider.ts";
export { SysinfoBridge } from "./sysinfo/bridge.ts";

// browser first-party READ-ONLY source — the user's browsers (Safari + Google Chrome).
// tabs.list (osascript/JXA) + bookmarks.search (plist/JSON) + history.search (sqlite,
// ALWAYS copy-before-open; WebKit-µs / Core-Data-s epochs → ISO). All grants:["read"];
// per-browser degradation sections (Safari without Full Disk Access never breaks Chrome).
// macOS-only (NOT in LINUX_PORTABLE_MODULE_IDS). Fake provider when PLEXUS_FAKE_BROWSER=1.
export { browserSourceModule, BrowserSource } from "./browser/manifest.ts";
export {
  browserEntries,
  BROWSER_SOURCE_ID,
  BROWSER_TABS_LIST_ID,
  BROWSER_BOOKMARKS_SEARCH_ID,
  BROWSER_HISTORY_SEARCH_ID,
  BROWSER_HOW_TO_USE_ID,
} from "./browser/entries.ts";
export {
  FakeBrowserProvider,
  RealBrowserProvider,
  selectBrowserProvider,
  clampLimit as clampBrowserLimit,
  webkitMicrosToIso,
  epochMsToWebkitMicros,
  coreDataSecondsToIso,
  epochMsToCoreDataSeconds,
  collectChromeBookmarks,
  collectSafariBookmarks,
  copySqliteToTemp,
  queryChromeHistoryDb,
  querySafariHistoryDb,
  likePattern,
  parseTabsScriptResult,
  SAFARI_TABS_JXA,
  CHROME_TABS_JXA,
  SAFARI_FDA_MESSAGE,
  FAKE_TABS,
  FAKE_BOOKMARKS,
  FAKE_HISTORY,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type BrowserProvider,
  type BrowserTab,
  type BrowserBookmark,
  type BrowserVisit,
  type BrowserSections,
  type BrowserSectionStatus,
  type HistoryQuery,
} from "./browser/provider.ts";
export { BrowserBridge, validateHistoryInput } from "./browser/bridge.ts";

// claudecode first-party adapter — NATIVELY-sandboxed headless Claude Code (CC's own
// sandbox write-confines it; Plexus does not wrap it), invoked ONLY via the claudecode.run
// capability (execute grant -> PENDS for the owner; never a raw shell). Gated by
// PLEXUS_CC_HEADLESS_LAUNCH (default record-mode).
export { claudecodeSourceModule } from "./claudecode/manifest.ts";

// codex first-party adapter — NATIVELY-sandboxed headless Codex CLI (`codex exec
// --sandbox workspace-write`; Codex's own sandbox write-confines it; Plexus does not wrap
// it), invoked ONLY via the codex.run capability (execute grant -> PENDS for the owner;
// never a raw shell). Gated by PLEXUS_CODEX_HEADLESS_LAUNCH (default record-mode). A missing
// `codex` binary degrades to source_unavailable (advisory), not a crash.
export { codexSourceModule, CodexSource } from "./codex/manifest.ts";
export { codexEntries, CODEX_SOURCE_ID, CODEX_RUN_ID, HOW_TO_USE_ID as CODEX_HOW_TO_USE_ID } from "./codex/entries.ts";
export { CodexBridge } from "./codex/bridge.ts";
export {
  SandboxedCodexLauncher,
  buildNativeArgv as buildCodexNativeArgv,
  buildCodexArgs,
  CODEX_SANDBOX_FLAGS,
  CODEX_BINARY,
  CODEX_WORKSPACE_WRITE_MECHANISM,
  defaultAuthorizedDir as defaultCodexAuthorizedDir,
  type SandboxedRunResult as CodexRunResult,
} from "./codex/launcher.ts";
