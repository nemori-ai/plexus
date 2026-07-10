/**
 * browser provider — the INJECTABLE seam (hermetic tests + live Safari/Chrome reads).
 *
 * The browser source reads the user's browsers three ways, STRICTLY READ-ONLY; this
 * provider abstracts each behind one interface so the source/bridge never touch the OS
 * directly:
 *   - TABS: shell `osascript -l JavaScript` with FIXED JXA scripts (no agent-controlled
 *     body, mirrors apple-calendar) asking Safari / Google Chrome for their open tabs.
 *     A browser that is not installed or not running contributes an EMPTY list with a
 *     per-browser note — never an error.
 *   - BOOKMARKS: Safari from `~/Library/Safari/Bookmarks.plist` (binary plist, converted
 *     via the first-party `plutil -convert json`), Chrome from
 *     `~/Library/Application Support/Google/Chrome/Default/Bookmarks` (plain JSON).
 *   - HISTORY: both are sqlite. Safari `~/Library/Safari/History.db` (Core Data epoch:
 *     seconds since 2001-01-01; needs Full Disk Access), Chrome `.../Default/History`
 *     (WebKit epoch: MICROSECONDS since 1601-01-01; LOCKED while Chrome runs). EVERY
 *     sqlite read is COPY-BEFORE-OPEN: the db (+ its -wal/-shm sidecars) is copied to an
 *     OS temp dir, opened there with bun:sqlite read-only, and the copy is deleted in a
 *     `finally`. The ORIGINAL file is never opened by sqlite — no lock contention, no
 *     corruption risk, and read-only holds at the seam (there is no write path anywhere).
 *
 * DEGRADE PER-BROWSER, always: each per-browser read is independently wrapped, so Safari
 * being unreadable (no Full Disk Access) can NEVER break Chrome results — the merged
 * result carries a per-browser `{ status: "ok" | "unavailable", count, note? }` section.
 * Provider methods never throw for a per-browser failure.
 *
 * TWO IMPLEMENTATIONS:
 *   - {@link RealBrowserProvider}: osascript + fs + bun:sqlite against the live home dir
 *     (paths injectable so tests can point at fixture profiles).
 *   - {@link FakeBrowserProvider}: deterministic in-memory tabs/bookmarks/history, no
 *     macOS, no permission. Can force a per-browser unavailable state for tests.
 *
 * SELECTION ({@link selectBrowserProvider}): real by default; the FAKE when
 * `process.env.PLEXUS_FAKE_BROWSER === "1"` (mirrors PLEXUS_FAKE_APPLE), or an explicit
 * provider injected via the source/bridge constructor.
 */

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

// ── Result shapes ─────────────────────────────────────────────────────────────

/** Which browser a row came from. */
export type BrowserName = "safari" | "chrome";

/**
 * Per-browser degradation section. `status:"ok"` with a `note` covers the benign
 * empty cases (browser not running / not installed); `status:"unavailable"` carries
 * the precise reason a browser's data could not be read (e.g. no Full Disk Access).
 */
export interface BrowserSectionStatus {
  status: "ok" | "unavailable";
  /** How many rows this browser contributed to the merged result. */
  count: number;
  /** Human-readable per-browser note ("Safari is not running", the FDA reason, …). */
  note?: string;
}

/** The per-browser sections attached to every result. */
export interface BrowserSections {
  safari: BrowserSectionStatus;
  chrome: BrowserSectionStatus;
}

/** One open tab. `window` is 1-based per browser. */
export interface BrowserTab {
  browser: BrowserName;
  window: number;
  title: string;
  url: string;
}

export interface TabsListResult {
  tabs: BrowserTab[];
  browsers: BrowserSections;
}

/** One bookmark. `folder` is the "/"-joined folder path (may be ""). */
export interface BrowserBookmark {
  browser: BrowserName;
  title: string;
  url: string;
  folder: string;
}

export interface BookmarksSearchResult {
  bookmarks: BrowserBookmark[];
  browsers: BrowserSections;
}

/** One history row. `lastVisited` is ISO-8601 UTC (converted from each browser's epoch). */
export interface BrowserVisit {
  browser: BrowserName;
  title: string;
  url: string;
  lastVisited: string;
}

export interface HistorySearchResult {
  visits: BrowserVisit[];
  browsers: BrowserSections;
}

/** A validated history query (the bridge validates + converts before the provider). */
export interface HistoryQuery {
  /** Substring matched against title OR url (case-insensitive). */
  query: string;
  /** Optional inclusive lower bound, epoch ms UTC. */
  startMs?: number;
  /** Optional inclusive upper bound, epoch ms UTC. */
  endMs?: number;
  /** Max merged rows (already clamped by the bridge). */
  limit: number;
}

/** Availability probe result (drives source HEALTH). */
export interface BrowserAvailability {
  ok: boolean;
  reason?: string;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 200;

/** Clamp a search `limit` into 1..SEARCH_LIMIT_MAX (default 20 when absent). */
export function clampLimit(limit: unknown): number {
  const n =
    typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : SEARCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, n));
}

// ── Epoch converters (unit-tested with known timestamps) ─────────────────────

/** Seconds between 1601-01-01 (WebKit/Chrome epoch) and 1970-01-01 (Unix epoch). */
export const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
/** Seconds between 1970-01-01 (Unix epoch) and 2001-01-01 (Core Data / Safari epoch). */
export const CORE_DATA_EPOCH_OFFSET_SECONDS = 978_307_200;

/** Chrome: WebKit-epoch MICROSECONDS (since 1601-01-01) → ISO-8601 UTC. */
export function webkitMicrosToIso(micros: number): string {
  return new Date(micros / 1000 - WEBKIT_EPOCH_OFFSET_SECONDS * 1000).toISOString();
}

/** Epoch-ms UTC → WebKit-epoch microseconds (for Chrome date-range predicates). */
export function epochMsToWebkitMicros(ms: number): number {
  return (ms + WEBKIT_EPOCH_OFFSET_SECONDS * 1000) * 1000;
}

/** Safari: Core-Data-epoch SECONDS (since 2001-01-01, may be fractional) → ISO-8601 UTC. */
export function coreDataSecondsToIso(seconds: number): string {
  return new Date((seconds + CORE_DATA_EPOCH_OFFSET_SECONDS) * 1000).toISOString();
}

/** Epoch-ms UTC → Core-Data-epoch seconds (for Safari date-range predicates). */
export function epochMsToCoreDataSeconds(ms: number): number {
  return ms / 1000 - CORE_DATA_EPOCH_OFFSET_SECONDS;
}

// ── Command runner seam (osascript + plutil; injectable for hermetic tests) ────

/** The result of running a command: exit code + captured stdout/stderr. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a fixed program with a fixed argv (no shell, nothing interpolated). */
export type CommandRunner = (command: string, args: string[]) => Promise<RunResult>;

/** REAL runner over `execFile`. Never rejects — a spawn failure degrades to code 127. */
export const realCommandRunner: CommandRunner = (command, args) =>
  new Promise<RunResult>((resolve) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        resolve({
          code: typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 127,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || err.message,
        });
        return;
      }
      resolve({
        code: err ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });

// ── FIXED JXA tab scripts (no agent-controlled body, mirrors apple-calendar) ──
//
// These are CONSTANT `osascript -l JavaScript` programs. They take NO input — nothing is
// ever interpolated into them — and only read window/tab properties (no navigation, no
// close, no execute-JS-in-page). A missing app or a not-running app is detected INSIDE
// the script and reported as structured JSON, so those states are data, not errors.

function tabsScript(appName: string, titleProp: "name" | "title"): string {
  return `
function run() {
  var app;
  try { app = Application(${JSON.stringify(appName)}); }
  catch (e) { return JSON.stringify({ installed: false, running: false, tabs: [] }); }
  var running = false;
  try { running = app.running(); }
  catch (e) { return JSON.stringify({ installed: false, running: false, tabs: [] }); }
  if (!running) return JSON.stringify({ installed: true, running: false, tabs: [] });
  var out = [];
  var wins = app.windows();
  for (var i = 0; i < wins.length; i++) {
    var tabs;
    try { tabs = wins[i].tabs(); } catch (e) { tabs = null; }
    if (!tabs) continue;
    for (var j = 0; j < tabs.length; j++) {
      var title = ""; var url = "";
      try { title = tabs[j].${titleProp}() || ""; } catch (e) {}
      try { url = tabs[j].url() || ""; } catch (e) {}
      out.push({ window: i + 1, title: title, url: url });
    }
  }
  return JSON.stringify({ installed: true, running: true, tabs: out });
}
`.trim();
}

/** READ-ONLY: Safari open tabs (tab title property is \`name\` in Safari's dictionary). */
export const SAFARI_TABS_JXA = tabsScript("Safari", "name");
/** READ-ONLY: Google Chrome open tabs (tab title property is \`title\`). */
export const CHROME_TABS_JXA = tabsScript("Google Chrome", "title");

/** The parsed shape a tabs script emits. */
export interface TabsScriptResult {
  installed: boolean;
  running: boolean;
  tabs: { window: number; title: string; url: string }[];
}

/** Parse + defensively shape a tabs script's JSON stdout. */
export function parseTabsScriptResult(stdout: string): TabsScriptResult {
  const parsed = JSON.parse(stdout.trim()) as Partial<TabsScriptResult>;
  const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
  return {
    installed: parsed.installed === true,
    running: parsed.running === true,
    tabs: rawTabs.map((t) => ({
      window: typeof t?.window === "number" ? t.window : 0,
      title: typeof t?.title === "string" ? t.title : "",
      url: typeof t?.url === "string" ? t.url : "",
    })),
  };
}

/** Recognize a macOS Automation/TCC denial in an osascript failure (mirrors apple-calendar). */
export function isAutomationDenied(res: RunResult): boolean {
  const blob = res.stderr.toLowerCase();
  return (
    res.stderr.includes("-1743") ||
    blob.includes("not authorized") ||
    blob.includes("not allowed to send apple events") ||
    blob.includes("not been granted")
  );
}

// ── Substring → SQL LIKE pattern (escaped; used with `ESCAPE '\'`) ────────────

/** Build a `%…%` LIKE pattern with `%`/`_`/`\` escaped so the query is a literal substring. */
export function likePattern(query: string): string {
  return "%" + query.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** Case-insensitive substring test shared by the in-memory (fake / bookmarks) filters. */
function matches(query: string, ...haystacks: string[]): boolean {
  const q = query.toLowerCase();
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

// ── Bookmark tree walkers (pure; unit-tested) ─────────────────────────────────

/** A node of Chrome's `Bookmarks` JSON (`roots.bookmark_bar/other/synced`). */
export interface ChromeBookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

/**
 * Walk Chrome's parsed `Bookmarks` JSON and collect leaves whose title or url contains
 * `query` (case-insensitive), up to `limit`. Pure — no fs.
 */
export function collectChromeBookmarks(
  roots: Record<string, ChromeBookmarkNode | undefined> | undefined,
  query: string,
  limit: number,
): BrowserBookmark[] {
  const out: BrowserBookmark[] = [];
  const walk = (node: ChromeBookmarkNode, folder: string): void => {
    if (out.length >= limit) return;
    if (node.type === "url" && typeof node.url === "string") {
      const title = typeof node.name === "string" ? node.name : "";
      if (matches(query, title, node.url)) {
        out.push({ browser: "chrome", title, url: node.url, folder });
      }
      return;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const label =
      typeof node.name === "string" && node.name ? (folder ? `${folder}/${node.name}` : node.name) : folder;
    for (const c of children) {
      if (out.length >= limit) return;
      walk(c ?? {}, label);
    }
  };
  for (const key of ["bookmark_bar", "other", "synced"]) {
    const root = roots?.[key];
    if (root) walk(root, "");
  }
  return out;
}

/** A node of Safari's Bookmarks.plist (as converted to JSON by `plutil`). */
export interface SafariBookmarkNode {
  WebBookmarkType?: string;
  Title?: string;
  URLString?: string;
  URIDictionary?: { title?: string };
  Children?: SafariBookmarkNode[];
}

/**
 * Walk Safari's plutil-converted Bookmarks.plist JSON and collect
 * `WebBookmarkTypeLeaf` nodes matching `query`, up to `limit`. Pure — no fs, no plutil.
 */
export function collectSafariBookmarks(
  root: SafariBookmarkNode | undefined,
  query: string,
  limit: number,
): BrowserBookmark[] {
  const out: BrowserBookmark[] = [];
  const walk = (node: SafariBookmarkNode, folder: string): void => {
    if (out.length >= limit) return;
    if (node.WebBookmarkType === "WebBookmarkTypeLeaf" && typeof node.URLString === "string") {
      const title = typeof node.URIDictionary?.title === "string" ? node.URIDictionary.title : "";
      if (matches(query, title, node.URLString)) {
        out.push({ browser: "safari", title, url: node.URLString, folder });
      }
      return;
    }
    // Containers are WebBookmarkTypeList (and the unlabeled top). Proxy/other nodes have
    // no Children and fall through harmlessly.
    const children = Array.isArray(node.Children) ? node.Children : [];
    const label =
      typeof node.Title === "string" && node.Title ? (folder ? `${folder}/${node.Title}` : node.Title) : folder;
    for (const c of children) {
      if (out.length >= limit) return;
      walk(c ?? {}, label);
    }
  };
  if (root) walk(root, "");
  return out;
}

// ── COPY-BEFORE-OPEN sqlite (the lock/corruption story) ───────────────────────

/**
 * Copy a sqlite db (and its `-wal`/`-shm` sidecars when present) into a fresh OS temp
 * dir. The caller opens the COPY and MUST call `cleanup()` in a `finally`. Copying (a
 * plain fs read) never takes sqlite locks on the original, so a Chrome-held LOCKED db
 * is still readable and the original can never be corrupted by us.
 */
export function copySqliteToTemp(src: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "plexus-browser-sqlite-"));
  const dest = join(dir, basename(src));
  copyFileSync(src, dest);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, dest + suffix);
    } catch {
      // A sidecar that vanished mid-copy is fine — the main file is what matters.
    }
  }
  return {
    path: dest,
    cleanup: (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    },
  };
}

/**
 * Open a sqlite file read-only and run `fn`. If the read-only open/query fails (a
 * WAL-mode db can need write access to its sidecars to recover), retry ONCE writable —
 * ONLY ever against the throwaway temp COPY, never the original.
 */
function withSqlite<T>(path: string, fn: (db: Database) => T): T {
  let db = new Database(path, { readonly: true });
  try {
    return fn(db);
  } catch {
    db.close();
    db = new Database(path);
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // Already closed by the retry path.
    }
  }
}

/**
 * Query a COPY of Chrome's `History` db: `urls(url, title, last_visit_time)` where
 * `last_visit_time` is WebKit-epoch MICROSECONDS. Newest first, bounded.
 */
export function queryChromeHistoryDb(dbPath: string, q: HistoryQuery): BrowserVisit[] {
  return withSqlite(dbPath, (db) => {
    let sql =
      "SELECT url, title, last_visit_time AS t FROM urls " +
      "WHERE (url LIKE $q ESCAPE '\\' OR ifnull(title,'') LIKE $q ESCAPE '\\') AND last_visit_time > 0";
    const params: Record<string, string | number> = { $q: likePattern(q.query), $limit: q.limit };
    if (q.startMs !== undefined) {
      sql += " AND last_visit_time >= $start";
      params.$start = epochMsToWebkitMicros(q.startMs);
    }
    if (q.endMs !== undefined) {
      sql += " AND last_visit_time <= $end";
      params.$end = epochMsToWebkitMicros(q.endMs);
    }
    sql += " ORDER BY last_visit_time DESC LIMIT $limit";
    const rows = db.query(sql).all(params) as { url: string; title: string | null; t: number }[];
    return rows.map((r) => ({
      browser: "chrome" as const,
      title: r.title ?? "",
      url: r.url,
      lastVisited: webkitMicrosToIso(r.t),
    }));
  });
}

/**
 * Query a COPY of Safari's `History.db`: `history_items(id, url)` joined to
 * `history_visits(history_item, title, visit_time)` where `visit_time` is
 * Core-Data-epoch SECONDS. Newest first, bounded.
 */
export function querySafariHistoryDb(dbPath: string, q: HistoryQuery): BrowserVisit[] {
  return withSqlite(dbPath, (db) => {
    let sql =
      "SELECT i.url AS url, v.title AS title, v.visit_time AS t " +
      "FROM history_visits v JOIN history_items i ON v.history_item = i.id " +
      "WHERE (i.url LIKE $q ESCAPE '\\' OR ifnull(v.title,'') LIKE $q ESCAPE '\\')";
    const params: Record<string, string | number> = { $q: likePattern(q.query), $limit: q.limit };
    if (q.startMs !== undefined) {
      sql += " AND v.visit_time >= $start";
      params.$start = epochMsToCoreDataSeconds(q.startMs);
    }
    if (q.endMs !== undefined) {
      sql += " AND v.visit_time <= $end";
      params.$end = epochMsToCoreDataSeconds(q.endMs);
    }
    sql += " ORDER BY v.visit_time DESC LIMIT $limit";
    const rows = db.query(sql).all(params) as { url: string; title: string | null; t: number }[];
    return rows.map((r) => ({
      browser: "safari" as const,
      title: r.title ?? "",
      url: r.url,
      lastVisited: coreDataSecondsToIso(r.t),
    }));
  });
}

// ── Per-browser degradation messages ──────────────────────────────────────────

/** The precise Safari onboarding instruction (Full Disk Access gates ~/Library/Safari). */
export const SAFARI_FDA_MESSAGE =
  "Safari data unreadable — grant Plexus Full Disk Access in System Settings › Privacy & " +
  "Security › Full Disk Access, then retry.";

/** The Automation onboarding instruction for a tabs read denied by TCC. */
export function automationDeniedMessage(appLabel: string): string {
  return (
    `Automation access to ${appLabel} not granted — approve Plexus in System Settings › ` +
    "Privacy & Security › Automation, then retry."
  );
}

/** True for the fs error shapes a TCC-protected path produces (EPERM/EACCES). */
function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" || code === "EACCES") return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return msg.includes("operation not permitted") || msg.includes("permission");
}

/** Classify a Safari fs/read failure into the per-browser note. */
function safariReadNote(err: unknown, what: string): string {
  if (isPermissionError(err)) return SAFARI_FDA_MESSAGE;
  const msg = err instanceof Error ? err.message : String(err);
  return `Safari ${what} unreadable: ${msg}`;
}

const ok = (count: number, note?: string): BrowserSectionStatus => ({
  status: "ok",
  count,
  ...(note ? { note } : {}),
});
const unavailable = (note: string): BrowserSectionStatus => ({ status: "unavailable", count: 0, note });

// ── Provider interface ────────────────────────────────────────────────────────

/**
 * The browser-read seam. The source/bridge depend on THIS, never on osascript/fs/sqlite
 * directly — so tests inject the fake. Every method is READ-ONLY (there is no
 * open/navigate/write/delete anywhere on the interface) and NEVER throws for a
 * per-browser failure — degradation is data (the `browsers` sections).
 */
export interface BrowserProvider {
  /** Is ANY browser data reachable right now? Drives health(); never throws. */
  available(): Promise<BrowserAvailability>;
  /** READ-ONLY: currently open tabs from Safari + Chrome. */
  listTabs(): Promise<TabsListResult>;
  /** READ-ONLY: bookmarks whose title/url contains `query`, merged, bounded to `limit`. */
  searchBookmarks(query: string, limit: number): Promise<BookmarksSearchResult>;
  /** READ-ONLY: history rows matching `query` (+ optional date range), newest first, bounded. */
  searchHistory(q: HistoryQuery): Promise<HistorySearchResult>;
}

// ── Default live paths ────────────────────────────────────────────────────────

/** Default Safari data dir (`Bookmarks.plist`, `History.db`). */
export function defaultSafariDir(): string {
  return join(homedir(), "Library", "Safari");
}

/** Default Chrome profile dir (`Bookmarks`, `History`). */
export function defaultChromeProfileDir(): string {
  return join(homedir(), "Library", "Application Support", "Google", "Chrome", "Default");
}

// ── REAL provider ─────────────────────────────────────────────────────────────

/** Construction options — paths + runner injectable so tests use fixture profiles. */
export interface RealBrowserProviderOptions {
  safariDir?: string;
  chromeProfileDir?: string;
  run?: CommandRunner;
}

export class RealBrowserProvider implements BrowserProvider {
  private readonly safariDir: string;
  private readonly chromeDir: string;
  private readonly run: CommandRunner;

  constructor(opts: RealBrowserProviderOptions = {}) {
    this.safariDir = opts.safariDir ?? defaultSafariDir();
    this.chromeDir = opts.chromeProfileDir ?? defaultChromeProfileDir();
    this.run = opts.run ?? realCommandRunner;
  }

  /**
   * Reachability probe: ok when EITHER browser's data files are readable. Only when
   * NEITHER is reachable does it report not-ok, with a precise combined reason (the
   * Safari half names the Full Disk Access toggle). Never throws.
   */
  async available(): Promise<BrowserAvailability> {
    const safariReadable = this.canRead(join(this.safariDir, "Bookmarks.plist")) ||
      this.canRead(join(this.safariDir, "History.db"));
    const chromeReadable = this.canRead(join(this.chromeDir, "Bookmarks")) ||
      this.canRead(join(this.chromeDir, "History"));
    if (safariReadable || chromeReadable) return { ok: true, reason: "browser data reachable" };
    return {
      ok: false,
      reason:
        "no browser data reachable — Chrome profile not found (is Google Chrome installed?) and " +
        "Safari data unreadable (Safari bookmarks/history require Full Disk Access for Plexus in " +
        "System Settings › Privacy & Security › Full Disk Access). Open-tab listing via " +
        "AppleScript may still work per-call.",
    };
  }

  private canRead(path: string): boolean {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ── tabs ──

  async listTabs(): Promise<TabsListResult> {
    const [safari, chrome] = await Promise.all([
      this.tabsFor("safari", "Safari", SAFARI_TABS_JXA),
      this.tabsFor("chrome", "Google Chrome", CHROME_TABS_JXA),
    ]);
    return {
      tabs: [...safari.tabs, ...chrome.tabs],
      browsers: { safari: safari.section, chrome: chrome.section },
    };
  }

  private async tabsFor(
    browser: BrowserName,
    appLabel: string,
    script: string,
  ): Promise<{ tabs: BrowserTab[]; section: BrowserSectionStatus }> {
    let res: RunResult;
    try {
      res = await this.run("osascript", ["-l", "JavaScript", "-e", script]);
    } catch (err) {
      return { tabs: [], section: unavailable(`${appLabel} tabs unreadable: ${err instanceof Error ? err.message : String(err)}`) };
    }
    if (res.code !== 0) {
      if (isAutomationDenied(res)) {
        return { tabs: [], section: unavailable(automationDeniedMessage(appLabel)) };
      }
      return {
        tabs: [],
        section: unavailable(`${appLabel} tabs unreadable: ${res.stderr.trim().slice(0, 200) || `osascript exit ${res.code}`}`),
      };
    }
    let parsed: TabsScriptResult;
    try {
      parsed = parseTabsScriptResult(res.stdout);
    } catch {
      return { tabs: [], section: unavailable(`${appLabel} tabs: malformed osascript output`) };
    }
    if (!parsed.installed) return { tabs: [], section: ok(0, `${appLabel} is not installed`) };
    if (!parsed.running) return { tabs: [], section: ok(0, `${appLabel} is not running`) };
    const tabs = parsed.tabs.map((t) => ({ browser, ...t }));
    return { tabs, section: ok(tabs.length) };
  }

  // ── bookmarks ──

  async searchBookmarks(query: string, limit: number): Promise<BookmarksSearchResult> {
    const [safari, chrome] = await Promise.all([
      this.safariBookmarks(query, limit),
      this.chromeBookmarks(query, limit),
    ]);
    const bookmarks = [...safari.items, ...chrome.items].slice(0, limit);
    return {
      bookmarks,
      browsers: {
        safari: recount(safari.section, bookmarks, "safari"),
        chrome: recount(chrome.section, bookmarks, "chrome"),
      },
    };
  }

  private async safariBookmarks(
    query: string,
    limit: number,
  ): Promise<{ items: BrowserBookmark[]; section: BrowserSectionStatus }> {
    const plist = join(this.safariDir, "Bookmarks.plist");
    if (!this.canRead(plist)) {
      // A TCC-hidden ~/Library/Safari is indistinguishable from an absent one (both read as
      // ENOENT-ish), and Safari ships with macOS — so the FDA instruction is the right note.
      return { items: [], section: unavailable(SAFARI_FDA_MESSAGE) };
    }
    // Binary plist → JSON via the first-party `plutil` (fixed argv; path is ours, not agent input).
    const res = await this.run("plutil", ["-convert", "json", "-o", "-", "--", plist]);
    if (res.code !== 0 || !res.stdout.trim()) {
      const stderr = res.stderr.trim();
      const note = /permission|not permitted/i.test(stderr)
        ? SAFARI_FDA_MESSAGE
        : `Safari bookmarks unreadable: ${stderr.slice(0, 200) || "plutil produced no output"}`;
      return { items: [], section: unavailable(note) };
    }
    try {
      const root = JSON.parse(res.stdout) as SafariBookmarkNode;
      return { items: collectSafariBookmarks(root, query, limit), section: ok(0) };
    } catch (err) {
      return { items: [], section: unavailable(safariReadNote(err, "bookmarks")) };
    }
  }

  private async chromeBookmarks(
    query: string,
    limit: number,
  ): Promise<{ items: BrowserBookmark[]; section: BrowserSectionStatus }> {
    const file = join(this.chromeDir, "Bookmarks");
    if (!existsSync(file)) {
      return { items: [], section: unavailable("Chrome bookmarks not found (is Google Chrome installed?)") };
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        roots?: Record<string, ChromeBookmarkNode>;
      };
      return { items: collectChromeBookmarks(parsed.roots, query, limit), section: ok(0) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { items: [], section: unavailable(`Chrome bookmarks unreadable: ${msg}`) };
    }
  }

  // ── history ──

  async searchHistory(q: HistoryQuery): Promise<HistorySearchResult> {
    const [safari, chrome] = await Promise.all([this.safariHistory(q), this.chromeHistory(q)]);
    // Merge NEWEST FIRST across browsers, then bound.
    const visits = [...safari.items, ...chrome.items]
      .sort((a, b) => (a.lastVisited < b.lastVisited ? 1 : a.lastVisited > b.lastVisited ? -1 : 0))
      .slice(0, q.limit);
    return {
      visits,
      browsers: {
        safari: recount(safari.section, visits, "safari"),
        chrome: recount(chrome.section, visits, "chrome"),
      },
    };
  }

  private async safariHistory(
    q: HistoryQuery,
  ): Promise<{ items: BrowserVisit[]; section: BrowserSectionStatus }> {
    const db = join(this.safariDir, "History.db");
    if (!this.canRead(db)) {
      return { items: [], section: unavailable(SAFARI_FDA_MESSAGE) };
    }
    return this.copyAndQuery(db, q, querySafariHistoryDb, (err) => safariReadNote(err, "history"));
  }

  private async chromeHistory(
    q: HistoryQuery,
  ): Promise<{ items: BrowserVisit[]; section: BrowserSectionStatus }> {
    const db = join(this.chromeDir, "History");
    if (!existsSync(db)) {
      return { items: [], section: unavailable("Chrome history not found (is Google Chrome installed?)") };
    }
    return this.copyAndQuery(db, q, queryChromeHistoryDb, (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return `Chrome history unreadable: ${msg}`;
    });
  }

  /** COPY-BEFORE-OPEN wrapper: temp-copy the db, query the copy, ALWAYS clean up. */
  private async copyAndQuery(
    dbPath: string,
    q: HistoryQuery,
    queryFn: (path: string, q: HistoryQuery) => BrowserVisit[],
    noteFor: (err: unknown) => string,
  ): Promise<{ items: BrowserVisit[]; section: BrowserSectionStatus }> {
    let copy: { path: string; cleanup: () => void } | undefined;
    try {
      copy = copySqliteToTemp(dbPath);
      return { items: queryFn(copy.path, q), section: ok(0) };
    } catch (err) {
      return { items: [], section: unavailable(noteFor(err)) };
    } finally {
      copy?.cleanup();
    }
  }
}

/** Recompute a section's `count` from the browser's rows in the FINAL merged slice. */
function recount<T extends { browser: BrowserName }>(
  section: BrowserSectionStatus,
  rows: T[],
  browser: BrowserName,
): BrowserSectionStatus {
  if (section.status === "unavailable") return section;
  return { ...section, count: rows.filter((r) => r.browser === browser).length };
}

// ── FAKE provider (deterministic fixtures; no macOS, no permission) ───────────

/** Deterministic sample tabs. */
export const FAKE_TABS: BrowserTab[] = [
  { browser: "safari", window: 1, title: "Plexus — local capability gateway", url: "https://plexus.vibecoding.icu/" },
  { browser: "safari", window: 1, title: "MDN Web Docs", url: "https://developer.mozilla.org/" },
  { browser: "chrome", window: 1, title: "GitHub", url: "https://github.com/" },
  { browser: "chrome", window: 2, title: "Bun — bun:sqlite", url: "https://bun.sh/docs/api/sqlite" },
];

/** Deterministic sample bookmarks. */
export const FAKE_BOOKMARKS: BrowserBookmark[] = [
  { browser: "safari", title: "Apple Developer", url: "https://developer.apple.com/", folder: "BookmarksBar" },
  { browser: "safari", title: "Plexus docs", url: "https://plexus.vibecoding.icu/docs/", folder: "BookmarksBar/Dev" },
  { browser: "chrome", title: "TypeScript handbook", url: "https://www.typescriptlang.org/docs/", folder: "Bookmarks Bar" },
  { browser: "chrome", title: "Plexus repo", url: "https://github.com/plexus/plexus", folder: "Bookmarks Bar/Dev" },
];

/** Deterministic sample history (mid-2026, newest first when sorted). */
export const FAKE_HISTORY: BrowserVisit[] = [
  { browser: "chrome", title: "Bun docs", url: "https://bun.sh/docs", lastVisited: "2026-06-25T10:00:00.000Z" },
  { browser: "safari", title: "Plexus concepts", url: "https://plexus.vibecoding.icu/concepts", lastVisited: "2026-06-24T09:30:00.000Z" },
  { browser: "chrome", title: "SQLite WAL", url: "https://sqlite.org/wal.html", lastVisited: "2026-06-20T18:00:00.000Z" },
  { browser: "safari", title: "WebKit epoch notes", url: "https://webkit.org/", lastVisited: "2026-05-01T12:00:00.000Z" },
];

/** Construction options for the fake — force a per-browser unavailable state for tests. */
export interface FakeBrowserProviderOptions {
  tabs?: BrowserTab[];
  bookmarks?: BrowserBookmark[];
  history?: BrowserVisit[];
  /** When set, Safari degrades to `unavailable` with this note (fixtures filtered out). */
  safariUnavailable?: string;
  /** When set, Chrome degrades to `unavailable` with this note (fixtures filtered out). */
  chromeUnavailable?: string;
}

/**
 * In-memory fixture provider (selected by `PLEXUS_FAKE_BROWSER=1`). Honors query /
 * limit / date-range / per-browser-degradation semantics so the bridge behavior is
 * exercised deterministically with no macOS access.
 */
export class FakeBrowserProvider implements BrowserProvider {
  private readonly tabs: BrowserTab[];
  private readonly bookmarks: BrowserBookmark[];
  private readonly history: BrowserVisit[];
  private readonly down: Partial<Record<BrowserName, string>>;

  constructor(opts: FakeBrowserProviderOptions = {}) {
    this.tabs = opts.tabs ?? FAKE_TABS;
    this.bookmarks = opts.bookmarks ?? FAKE_BOOKMARKS;
    this.history = opts.history ?? FAKE_HISTORY;
    this.down = {
      ...(opts.safariUnavailable ? { safari: opts.safariUnavailable } : {}),
      ...(opts.chromeUnavailable ? { chrome: opts.chromeUnavailable } : {}),
    };
  }

  async available(): Promise<BrowserAvailability> {
    return { ok: true, reason: "fake browser provider" };
  }

  private section(browser: BrowserName, count: number): BrowserSectionStatus {
    const note = this.down[browser];
    return note ? unavailable(note) : ok(count);
  }

  private alive<T extends { browser: BrowserName }>(rows: T[]): T[] {
    return rows.filter((r) => !this.down[r.browser]);
  }

  async listTabs(): Promise<TabsListResult> {
    const tabs = this.alive(this.tabs);
    return {
      tabs,
      browsers: {
        safari: this.section("safari", tabs.filter((t) => t.browser === "safari").length),
        chrome: this.section("chrome", tabs.filter((t) => t.browser === "chrome").length),
      },
    };
  }

  async searchBookmarks(query: string, limit: number): Promise<BookmarksSearchResult> {
    const bookmarks = this.alive(this.bookmarks)
      .filter((b) => matches(query, b.title, b.url))
      .slice(0, limit);
    return {
      bookmarks,
      browsers: {
        safari: this.section("safari", bookmarks.filter((b) => b.browser === "safari").length),
        chrome: this.section("chrome", bookmarks.filter((b) => b.browser === "chrome").length),
      },
    };
  }

  async searchHistory(q: HistoryQuery): Promise<HistorySearchResult> {
    const visits = this.alive(this.history)
      .filter((v) => matches(q.query, v.title, v.url))
      .filter((v) => {
        const t = Date.parse(v.lastVisited);
        if (q.startMs !== undefined && t < q.startMs) return false;
        if (q.endMs !== undefined && t > q.endMs) return false;
        return true;
      })
      .sort((a, b) => (a.lastVisited < b.lastVisited ? 1 : a.lastVisited > b.lastVisited ? -1 : 0))
      .slice(0, q.limit);
    return {
      visits,
      browsers: {
        safari: this.section("safari", visits.filter((v) => v.browser === "safari").length),
        chrome: this.section("chrome", visits.filter((v) => v.browser === "chrome").length),
      },
    };
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────

/** The env var that selects the FAKE provider (mirrors PLEXUS_FAKE_APPLE). */
export const FAKE_BROWSER_ENV = "PLEXUS_FAKE_BROWSER" as const;

/** True when the fake provider is forced via env (`PLEXUS_FAKE_BROWSER=1`). */
export function fakeBrowserForced(): boolean {
  return process.env[FAKE_BROWSER_ENV] === "1";
}

/**
 * Pick the provider: an explicitly injected one wins; else the FAKE when
 * `PLEXUS_FAKE_BROWSER=1`; else the REAL provider against the live home dir.
 */
export function selectBrowserProvider(injected?: BrowserProvider): BrowserProvider {
  if (injected) return injected;
  if (fakeBrowserForced()) return new FakeBrowserProvider();
  return new RealBrowserProvider();
}
