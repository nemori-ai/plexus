/**
 * PhotosProvider — the OS-ACCESS SEAM for the Apple Photos first-party source.
 *
 * Everything that touches macOS Photos.app lives behind this single interface so the
 * rest of the source (entries, bridge, health) is OS-agnostic and HERMETICALLY TESTABLE.
 * Two implementations:
 *
 *  - `RealPhotosProvider`: shells FIXED `osascript -l JavaScript` (JXA) templates
 *    against Photos.app. The FIRST such call triggers the macOS Automation (Apple
 *    Events) TCC prompt; a denial surfaces as a precise, actionable reason — never a
 *    crash. NO agent-controlled script body is ever executed: the templates are
 *    constants and every dynamic value (album name, query text, media-item id, the
 *    gateway-built export dir) crosses ONLY via the JXA `run(argv)` argument vector,
 *    never string-interpolated into the script.
 *
 *  - `FakePhotosProvider`: deterministic in-memory fixtures (albums/folders/items) and
 *    a fake export that writes a PLACEHOLDER file into the same jail directory the real
 *    provider uses. Needs NO macOS permission — the unit tests + hermetic e2e run on it.
 *
 * SELECTION (`selectPhotosProvider`): real by default; FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the existing apple-calendar/apple-reminders convention).
 * A provider can also be injected directly via the source/bridge constructors.
 *
 * READ-ONLY POSTURE + THE EXPORT JAIL: the seam has NO method that mutates the photo
 * library (no create/edit/delete/album-add — the JXA templates call only read APIs plus
 * the `export` command, which copies items OUT). The ONE disk side effect is
 * `exportItem`, which writes exactly one file into the gateway-owned jail directory
 * `~/.plexus/exports/photos/` (PLEXUS_HOME-relative; created if missing). The
 * destination is ALWAYS gateway-constructed (a fresh unique subdirectory of the jail);
 * agent input never becomes a path, and a post-write realpath containment check
 * (`assertInsideJail`) rejects anything that would land outside.
 *
 * PERFORMANCE / BOUNDS (JXA over huge libraries is SLOW): every enumeration is hard-
 * capped — albums/folders at {@link MAX_ALBUMS} per level, search candidate sets at
 * {@link SEARCH_SCAN_CAP} items (an over-cap set is REJECTED with a "scope by album"
 * message rather than hanging), results at {@link MAX_LIMIT}. Property reads use the
 * JXA BULK specifier form (one Apple Event per property across all items, never a
 * per-item round trip), and every osascript run has a kill-timeout.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { ensureDir, plexusHome } from "../../core/paths.ts";

// ── §1  Bounds (hard caps + timeouts — anti-runaway over huge libraries) ────────

/** Max albums/folders enumerated PER LEVEL by albums.list (anti-runaway). */
export const MAX_ALBUMS = 200;
/**
 * Max candidate items a search will scan. A candidate set larger than this (e.g. an
 * unscoped search over a big library) is REJECTED with a "scope by album" message
 * instead of grinding through Apple Events for minutes.
 */
export const SEARCH_SCAN_CAP = 5000;
/** Default number of search results when `limit` is omitted. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** Hard ceiling on `limit`. */
export const MAX_SEARCH_LIMIT = 100;
/** Kill-timeout for list/search osascript runs. */
export const OSASCRIPT_TIMEOUT_MS = 60_000;
/** Kill-timeout for an export run (Photos may need to render/convert the item). */
export const EXPORT_TIMEOUT_MS = 120_000;

// ── §2  Errors + the TCC onboarding message ────────────────────────────────────

/** Raised when input fails validation. Carries a stable, agent-legible message. */
export class PhotosInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotosInputError";
  }
}

/** Raised for a recognized macOS Automation (TCC) denial. */
export class PhotosNotAuthorizedError extends Error {
  constructor(message: string = USER_FACING_TCC_MESSAGE) {
    super(message);
    this.name = "PhotosNotAuthorizedError";
  }
}

/** Raised when a referenced album/media item does not exist. */
export class PhotosNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotosNotFoundError";
  }
}

/** Raised when an export would land OUTSIDE the jail directory (never allowed). */
export class PhotosConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotosConfinementError";
  }
}

/**
 * The precise onboarding instruction surfaced for an un-granted TCC state. Photos.app
 * scripting is gated by the AUTOMATION (Apple Events) bucket — plus, on first library
 * access, the Photos bucket — so we point the user at both.
 */
export const USER_FACING_TCC_MESSAGE =
  "Photos access not granted — approve Plexus (or its host terminal) in System Settings ▸ " +
  "Privacy & Security ▸ Automation ▸ allow control of Photos (and, if listed, Privacy & " +
  "Security ▸ Photos ▸ Full Access), then retry.";

// ── §3  Domain shapes (provider-neutral; both impls return these) ──────────────

/** One album (top-level or inside a folder). */
export interface PhotosAlbum {
  id: string;
  name: string;
  /** Number of media items in the album; -1 when the count could not be read. */
  itemCount: number;
}

/** One top-level folder with its (first-level) child albums. */
export interface PhotosFolder {
  id: string;
  name: string;
  albums: PhotosAlbum[];
}

export interface AlbumsListResult {
  albums: PhotosAlbum[];
  folders: PhotosFolder[];
  /** True when a level was cut off at {@link MAX_ALBUMS}. */
  truncated: boolean;
}

/** One media item projected to safe metadata. */
export interface PhotoItem {
  id: string;
  filename: string;
  /** ISO-8601 capture date, or null when Photos has none. */
  date: string | null;
  width: number | null;
  height: number | null;
  favorite: boolean;
}

export interface SearchResult {
  items: PhotoItem[];
  /** How many candidate items were scanned (post album-scoping). */
  scanned: number;
  /** True when more items matched than `limit` allowed. */
  truncated: boolean;
}

export interface ExportResult {
  /** ABSOLUTE path of the exported file — always inside the export jail. */
  path: string;
  filename: string;
}

/** Availability probe result (drives source health()). */
export interface PhotosAvailability {
  ok: boolean;
  /** Precise, actionable reason when `ok:false` (e.g. the TCC onboarding message). */
  reason?: string;
}

/** A VALIDATED search query — only this shape ever reaches a provider. */
export interface PhotosSearchQuery {
  /** Album name to scope to (strongly preferred on large libraries). */
  album?: string;
  /** Inclusive lower bound on the capture date, epoch ms. */
  startMs?: number;
  /** Inclusive upper bound on the capture date, epoch ms. */
  endMs?: number;
  /** Case-insensitive substring matched against filename + keywords. */
  query?: string;
  /** Max results (1..MAX_SEARCH_LIMIT). Always present after validation. */
  limit: number;
}

/** The OS-access seam. Read-only toward Photos; the ONE disk write is the jailed export. */
export interface PhotosProvider {
  /** Is Photos reachable + permitted RIGHT NOW? Never throws — degrades to a reason. */
  available(): Promise<PhotosAvailability>;
  /** READ-ONLY: albums + folders with item counts (capped at MAX_ALBUMS per level). */
  listAlbums(): Promise<AlbumsListResult>;
  /** READ-ONLY: bounded metadata search over media items. */
  search(query: PhotosSearchQuery): Promise<SearchResult>;
  /**
   * Export ONE media item by id into the jail dir. Reads the library; writes exactly
   * one file INSIDE `~/.plexus/exports/photos/` (never anywhere else).
   */
  exportItem(id: string): Promise<ExportResult>;
}

// ── §4  Input validation (bridge calls these BEFORE the provider) ──────────────

/**
 * Validate a raw `{ album?, start?, end?, query?, limit? }` search input. Dates are
 * parsed + re-serialized to epoch-ms (the agent's raw strings never flow onward);
 * `limit` is clamped-by-rejection to 1..MAX_SEARCH_LIMIT (default DEFAULT_SEARCH_LIMIT).
 */
export function validateSearchInput(input: Record<string, unknown>): PhotosSearchQuery {
  const out: PhotosSearchQuery = { limit: DEFAULT_SEARCH_LIMIT };

  if (input.album !== undefined && input.album !== null) {
    if (typeof input.album !== "string" || input.album.trim() === "") {
      throw new PhotosInputError("`album`, when present, must be a non-empty string");
    }
    out.album = input.album;
  }
  if (input.query !== undefined && input.query !== null) {
    if (typeof input.query !== "string" || input.query.trim() === "") {
      throw new PhotosInputError("`query`, when present, must be a non-empty string");
    }
    if (input.query.length > 200) {
      throw new PhotosInputError("`query` too long (max 200 chars)");
    }
    out.query = input.query;
  }
  const parseDate = (v: unknown, field: "start" | "end"): number => {
    if (typeof v !== "string" || v.trim() === "") {
      throw new PhotosInputError(`\`${field}\`, when present, must be an ISO date string`);
    }
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) {
      throw new PhotosInputError(`\`${field}\` is not a valid date: ${JSON.stringify(v)}`);
    }
    return ms;
  };
  if (input.start !== undefined && input.start !== null) out.startMs = parseDate(input.start, "start");
  if (input.end !== undefined && input.end !== null) out.endMs = parseDate(input.end, "end");
  if (out.startMs !== undefined && out.endMs !== undefined && out.endMs <= out.startMs) {
    throw new PhotosInputError("`end` must be after `start`");
  }
  if (input.limit !== undefined && input.limit !== null) {
    const n = input.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_SEARCH_LIMIT) {
      throw new PhotosInputError(`\`limit\` must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
    }
    out.limit = n;
  }
  return out;
}

/**
 * Validate a media-item id for export. Photos ids look like
 * `9C1B…-…/L0/001` — UUID-ish segments joined by `/`. The id is NEVER used as a
 * filesystem path (the export destination is always gateway-constructed), but we still
 * reject anything path-shaped (`..`, leading `/` or `~`, backslash, whitespace, control
 * chars) so a traversal attempt dies at the front door with a clear message.
 */
export function validateExportId(input: Record<string, unknown>): string {
  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new PhotosInputError("`id` is required — a media-item id from apple-photos.search");
  }
  if (id.length > 300) throw new PhotosInputError("`id` too long");
  if (id.includes("..") || /^[/~\\.]/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9/\-+=._]*$/.test(id)) {
    throw new PhotosInputError(`\`id\` is not a valid Photos media-item id: ${JSON.stringify(id)}`);
  }
  return id;
}

// ── §5  The export jail ─────────────────────────────────────────────────────────

/**
 * The confined export directory: `<plexusHome>/exports/photos` (i.e.
 * `~/.plexus/exports/photos/`, or under PLEXUS_HOME when overridden — tests sandbox
 * there). Every export lands in a fresh unique subdirectory of this jail.
 */
export function resolveExportJail(): string {
  return join(plexusHome(), "exports", "photos");
}

/** Create (if missing) and return a fresh unique export subdirectory inside the jail. */
function makeExportDir(jail: string): string {
  const dir = join(jail, `export-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Assert `candidate` (absolute) is INSIDE `jail` — lexically AND after symlink
 * resolution of the containing directory. Throws {@link PhotosConfinementError}
 * otherwise. This is the belt-and-braces backstop behind the gateway-constructed
 * destination: even a hostile filename coming back from Photos/fixtures cannot land a
 * write outside the jail.
 */
export function assertInsideJail(jail: string, candidate: string): void {
  const jailAbs = resolve(jail);
  const lexical = relative(jailAbs, resolve(candidate));
  if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) {
    throw new PhotosConfinementError(
      `apple-photos: export path escapes the jail (${jailAbs}): refused`,
    );
  }
  // realpath the jail + the candidate's parent (both exist by the time we check) to
  // defeat a symlinked segment pointing outside.
  try {
    const realJail = realpathSync(jailAbs);
    const realParent = realpathSync(resolve(candidate, ".."));
    const rel = relative(realJail, realParent);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new PhotosConfinementError(
        `apple-photos: export path resolves outside the jail (${realJail}): refused`,
      );
    }
  } catch (err) {
    if (err instanceof PhotosConfinementError) throw err;
    throw new PhotosConfinementError(
      `apple-photos: could not verify export confinement: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── §6  FIXED JXA script templates (no agent-controlled body — argv only) ───────
//
// Constant `osascript -l JavaScript` programs. Dynamic values cross ONLY via the JXA
// `run(argv)` argument vector (osascript passes trailing args as strings) — never
// string-interpolated into the script text. On a TCC denial osascript itself prints the
// -1743 / "Not authorized to send Apple events" error to stderr and exits non-zero,
// which `isNotAuthorized()` detects. Property reads use the BULK specifier form
// (`col.filename()` = ONE Apple Event returning a parallel array) — never a per-item
// round trip — and candidate sets are counted (`.length` = one count event) and
// rejected BEFORE any bulk fetch when they exceed the scan cap.

/**
 * argv = [maxAlbumsPerLevel]. Emits
 * `{ albums:[{id,name,itemCount}], folders:[{id,name,albums:[…]}], truncated }`.
 * Top-level albums + top-level folders with ONE level of child albums (deeper nesting
 * is deliberately not walked — bounded, honest). Read-only.
 */
export const PHOTOS_LIST_ALBUMS_JS = `
function run(argv) {
  var max = parseInt(argv[0], 10);
  var app = Application("Photos");
  var truncated = false;

  function readAlbums(albumsSpec) {
    var names = albumsSpec.name();
    var ids = albumsSpec.id();
    var n = Math.min(names.length, max);
    if (names.length > max) truncated = true;
    var out = [];
    for (var i = 0; i < n; i++) {
      var count = -1;
      try { count = albumsSpec[i].mediaItems.length; } catch (e) { count = -1; }
      out.push({ id: String(ids[i]), name: String(names[i]), itemCount: count });
    }
    return out;
  }

  var albums = readAlbums(app.albums);

  var folders = [];
  var fNames = app.folders.name();
  var fIds = app.folders.id();
  var fn = Math.min(fNames.length, max);
  if (fNames.length > max) truncated = true;
  for (var j = 0; j < fn; j++) {
    var children = [];
    try { children = readAlbums(app.folders[j].albums); } catch (e2) { children = []; }
    folders.push({ id: String(fIds[j]), name: String(fNames[j]), albums: children });
  }

  return JSON.stringify({ albums: albums, folders: folders, truncated: truncated });
}
`.trim();

/**
 * argv = [albumNameOrEmpty, startMsOr-1, endMsOr-1, queryLowerOrEmpty, limit, scanCap].
 * Emits `{ items:[{id,filename,date,width,height,favorite}], scanned, truncated }`.
 * Album resolution checks top-level albums first, then one folder level. A candidate
 * set larger than scanCap throws (bounded by construction — the error tells the agent
 * to scope by album). METADATA-ONLY: matches filename/keywords/date; no content/ML
 * search exists in the scripting bridge. Read-only.
 */
export const PHOTOS_SEARCH_JS = `
function run(argv) {
  var albumName = argv[0];
  var startMs = parseInt(argv[1], 10);
  var endMs = parseInt(argv[2], 10);
  var query = argv[3] || "";
  var limit = parseInt(argv[4], 10);
  var scanCap = parseInt(argv[5], 10);
  var app = Application("Photos");

  var col = null;
  if (albumName !== "") {
    var names = app.albums.name();
    for (var a = 0; a < names.length && col === null; a++) {
      if (names[a] === albumName) col = app.albums[a].mediaItems;
    }
    if (col === null) {
      var fCount = app.folders.length;
      for (var f = 0; f < fCount && col === null; f++) {
        var subNames = app.folders[f].albums.name();
        for (var s = 0; s < subNames.length && col === null; s++) {
          if (subNames[s] === albumName) col = app.folders[f].albums[s].mediaItems;
        }
      }
    }
    if (col === null) throw new Error("apple-photos: album not found: " + albumName);
  } else {
    col = app.mediaItems;
  }

  var total = col.length;
  if (total > scanCap) {
    throw new Error("apple-photos: too many items to scan (" + total + " > " + scanCap +
      ") - scope the search with \`album\` (see albums.list)");
  }

  var ids = col.id();
  var files = col.filename();
  var dates = col.date();
  var widths = col.width();
  var heights = col.height();
  var favs = col.favorite();
  var kws = null;
  try { kws = col.keywords(); } catch (e) { kws = null; }

  var items = [];
  var i = 0;
  for (i = 0; i < ids.length && items.length < limit; i++) {
    var d = dates[i];
    var dms = (d && d.getTime) ? d.getTime() : NaN;
    if (startMs >= 0 && !(dms >= startMs)) continue;
    if (endMs >= 0 && !(dms <= endMs)) continue;
    if (query !== "") {
      var hay = String(files[i] || "").toLowerCase();
      if (kws && kws[i]) {
        try { hay += " " + kws[i].join(" ").toLowerCase(); } catch (e2) {}
      }
      if (hay.indexOf(query) === -1) continue;
    }
    items.push({
      id: String(ids[i]),
      filename: String(files[i] || ""),
      date: isNaN(dms) ? null : new Date(dms).toISOString(),
      width: (typeof widths[i] === "number") ? widths[i] : null,
      height: (typeof heights[i] === "number") ? heights[i] : null,
      favorite: favs[i] === true
    });
  }
  return JSON.stringify({ items: items, scanned: total, truncated: items.length >= limit && i < ids.length });
}
`.trim();

/**
 * argv = [mediaItemId, destDirAbsolute]. Exports ONE media item (current/rendered
 * version, not the original) into the gateway-built destination directory, then emits
 * `{ ok: true }`. The destination is ALWAYS a fresh subdirectory of the jail built by
 * the provider — agent input never becomes a path. Read-only toward the library.
 */
export const PHOTOS_EXPORT_JS = `
function run(argv) {
  var id = argv[0];
  var dest = argv[1];
  var app = Application("Photos");
  var item = null;
  try {
    item = app.mediaItems.byId(id);
    item.filename(); // force resolution — throws if the id does not exist
  } catch (e) {
    throw new Error("apple-photos: no media item with id " + id);
  }
  app.export([item], { to: Path(dest) });
  return JSON.stringify({ ok: true });
}
`.trim();

// ── §7  Command runner (injectable; timeout-killed) ─────────────────────────────

/** The result of running a command: exit code + captured stdout/stderr. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a fixed program with a fixed argv and a kill-timeout. Injected so tests simulate
 * osascript WITHOUT Photos/TCC. Command + argv array — no shell, nothing interpolated.
 */
export type PhotosCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<RunResult>;

/** Default runner: spawn real `osascript`; SIGKILL past the deadline. */
export const spawnOsascript: PhotosCommandRunner = (command, args, timeoutMs) =>
  new Promise<RunResult>((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (res: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(res);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ code: -1, stdout, stderr: `${stderr}\napple-photos: osascript timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

/**
 * Recognize the macOS TCC denial in a runner result (`errAEEventNotPermitted` -1743 and
 * its textual variants on stderr).
 */
export function isNotAuthorized(res: RunResult): boolean {
  const blob = res.stderr.toLowerCase();
  return (
    res.stderr.includes("-1743") ||
    blob.includes("not authorized") ||
    blob.includes("not allowed to send apple events") ||
    blob.includes("not permitted") ||
    blob.includes("not been granted")
  );
}

/** Parse + defensively shape the JSON a JXA script emitted on stdout. */
function parseJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new Error("apple-photos: empty output from osascript");
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(`apple-photos: could not parse osascript output as JSON: ${trimmed.slice(0, 200)}`);
  }
}

// ── §8  REAL provider ───────────────────────────────────────────────────────────

/**
 * The REAL provider — shells the fixed JXA templates via the injectable runner (every
 * path is unit-testable against a fake runner without Photos/TCC). The live path is
 * exercised only as a documented spot check — a real run needs an interactive TCC grant.
 */
export class RealPhotosProvider implements PhotosProvider {
  constructor(private readonly run: PhotosCommandRunner = spawnOsascript) {}

  private async osascript(script: string, args: string[], timeoutMs: number): Promise<RunResult> {
    return this.run("osascript", ["-l", "JavaScript", "-e", script, ...args], timeoutMs);
  }

  /**
   * Liveness probe: read the (cheap) top-level album count. TCC denial ⇒ `{ok:false,
   * reason: onboarding}`; missing app / failed osascript ⇒ `{ok:false, reason}`.
   * NEVER throws — health must always resolve to a status.
   */
  async available(): Promise<PhotosAvailability> {
    try {
      const res = await this.osascript(
        `function run() { return String(Application("Photos").albums.length); }`,
        [],
        OSASCRIPT_TIMEOUT_MS,
      );
      if (isNotAuthorized(res)) return { ok: false, reason: USER_FACING_TCC_MESSAGE };
      if (res.code !== 0) {
        return {
          ok: false,
          reason: `Photos unavailable — osascript failed (code ${res.code}): ${res.stderr.trim().slice(0, 160)}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `Photos unavailable — could not run osascript: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private failFrom(res: RunResult, op: string): never {
    if (isNotAuthorized(res)) throw new PhotosNotAuthorizedError();
    const msg = res.stderr.trim().slice(0, 300);
    if (msg.includes("album not found")) throw new PhotosNotFoundError(msg);
    if (msg.includes("no media item with id")) throw new PhotosNotFoundError(msg);
    throw new Error(`apple-photos ${op} failed (code ${res.code}): ${msg}`);
  }

  async listAlbums(): Promise<AlbumsListResult> {
    const res = await this.osascript(PHOTOS_LIST_ALBUMS_JS, [String(MAX_ALBUMS)], OSASCRIPT_TIMEOUT_MS);
    if (res.code !== 0) this.failFrom(res, "albums.list");
    const parsed = parseJsonStdout(res.stdout);
    if (!Array.isArray(parsed.albums) || !Array.isArray(parsed.folders)) {
      throw new Error("apple-photos: malformed albums payload");
    }
    return {
      albums: parsed.albums as PhotosAlbum[],
      folders: parsed.folders as PhotosFolder[],
      truncated: parsed.truncated === true,
    };
  }

  async search(query: PhotosSearchQuery): Promise<SearchResult> {
    const res = await this.osascript(
      PHOTOS_SEARCH_JS,
      [
        query.album ?? "",
        String(query.startMs ?? -1),
        String(query.endMs ?? -1),
        (query.query ?? "").toLowerCase(),
        String(query.limit),
        String(SEARCH_SCAN_CAP),
      ],
      OSASCRIPT_TIMEOUT_MS,
    );
    if (res.code !== 0) this.failFrom(res, "search");
    const parsed = parseJsonStdout(res.stdout);
    if (!Array.isArray(parsed.items)) throw new Error("apple-photos: malformed search payload");
    return {
      items: parsed.items as PhotoItem[],
      scanned: typeof parsed.scanned === "number" ? parsed.scanned : (parsed.items as unknown[]).length,
      truncated: parsed.truncated === true,
    };
  }

  async exportItem(id: string): Promise<ExportResult> {
    const jail = ensureDir(resolveExportJail());
    const dir = makeExportDir(jail);
    const res = await this.osascript(PHOTOS_EXPORT_JS, [id, dir], EXPORT_TIMEOUT_MS);
    if (res.code !== 0) {
      try {
        rmdirSync(dir); // best-effort: remove the empty dir a failed export left behind
      } catch {
        /* non-empty or already gone — leave it */
      }
      this.failFrom(res, "export");
    }
    const files = readdirSync(dir);
    if (files.length === 0) {
      throw new Error("apple-photos: export completed but produced no file");
    }
    const filename = files[0]!;
    const path = join(dir, filename);
    assertInsideJail(jail, path);
    return { path, filename };
  }
}

// ── §9  FAKE provider (deterministic fixtures; placeholder export into the jail) ─

/** A fake media item — the fixture shape (album is a fake-only association). */
export interface FakePhotoItem extends PhotoItem {
  album?: string;
  keywords?: string[];
}

/** Deterministic sample albums (top-level). */
export const FAKE_ALBUMS: PhotosAlbum[] = [
  { id: "alb-vacation", name: "Vacation 2026", itemCount: 3 },
  { id: "alb-screens", name: "Screenshots", itemCount: 1 },
];

/** Deterministic sample folders (one, with one child album). */
export const FAKE_FOLDERS: PhotosFolder[] = [
  {
    id: "fld-family",
    name: "Family",
    albums: [{ id: "alb-kids", name: "Kids", itemCount: 0 }],
  },
];

/** Deterministic sample media items spanning albums, dates, and a favorite. */
export const FAKE_ITEMS: FakePhotoItem[] = [
  {
    id: "9C1B2E30-0001/L0/001",
    filename: "IMG_0001.HEIC",
    date: "2026-06-20T10:15:00.000Z",
    width: 4032,
    height: 3024,
    favorite: true,
    album: "Vacation 2026",
    keywords: ["beach", "sunset"],
  },
  {
    id: "9C1B2E30-0002/L0/001",
    filename: "IMG_0002.HEIC",
    date: "2026-06-21T18:40:00.000Z",
    width: 4032,
    height: 3024,
    favorite: false,
    album: "Vacation 2026",
  },
  {
    id: "9C1B2E30-0003/L0/001",
    filename: "harbor-pano.jpg",
    date: "2026-06-22T09:05:00.000Z",
    width: 8192,
    height: 2048,
    favorite: false,
    album: "Vacation 2026",
  },
  {
    id: "9C1B2E30-0004/L0/001",
    filename: "screenshot-invoice.png",
    date: "2026-07-01T14:00:00.000Z",
    width: 1920,
    height: 1080,
    favorite: false,
    album: "Screenshots",
  },
  {
    id: "9C1B2E30-0005/L0/001",
    filename: "old-scan.tiff",
    date: "2020-01-15T00:00:00.000Z",
    width: 2400,
    height: 1600,
    favorite: false,
  },
];

/** Construction options for the fake provider. */
export interface FakePhotosProviderOptions {
  albums?: PhotosAlbum[];
  folders?: PhotosFolder[];
  items?: FakePhotoItem[];
  /** Force the un-granted (TCC) state — available() reports the reason, reads throw. */
  notAuthorized?: boolean;
}

/**
 * In-memory fixture provider. Deterministic, permission-free. Honors the SAME bounds as
 * the real provider (MAX_ALBUMS, SEARCH_SCAN_CAP, limit) so bound behavior is testable,
 * and its export writes a PLACEHOLDER file through the SAME jail + confinement checks.
 */
export class FakePhotosProvider implements PhotosProvider {
  private readonly albums: PhotosAlbum[];
  private readonly folders: PhotosFolder[];
  private readonly items: FakePhotoItem[];
  private readonly notAuthorized: boolean;

  constructor(opts: FakePhotosProviderOptions = {}) {
    this.albums = opts.albums ?? FAKE_ALBUMS.map((a) => ({ ...a }));
    this.folders = opts.folders ?? FAKE_FOLDERS.map((f) => ({ ...f, albums: f.albums.map((a) => ({ ...a })) }));
    this.items = opts.items ?? FAKE_ITEMS.map((i) => ({ ...i }));
    this.notAuthorized = opts.notAuthorized ?? false;
  }

  async available(): Promise<PhotosAvailability> {
    return this.notAuthorized ? { ok: false, reason: USER_FACING_TCC_MESSAGE } : { ok: true };
  }

  async listAlbums(): Promise<AlbumsListResult> {
    if (this.notAuthorized) throw new PhotosNotAuthorizedError();
    const truncated = this.albums.length > MAX_ALBUMS || this.folders.length > MAX_ALBUMS;
    return {
      albums: this.albums.slice(0, MAX_ALBUMS).map((a) => ({ ...a })),
      folders: this.folders.slice(0, MAX_ALBUMS).map((f) => ({ ...f, albums: f.albums.map((a) => ({ ...a })) })),
      truncated,
    };
  }

  async search(query: PhotosSearchQuery): Promise<SearchResult> {
    if (this.notAuthorized) throw new PhotosNotAuthorizedError();
    let candidates = this.items;
    if (query.album !== undefined) {
      const known =
        this.albums.some((a) => a.name === query.album) ||
        this.folders.some((f) => f.albums.some((a) => a.name === query.album));
      if (!known) throw new PhotosNotFoundError(`apple-photos: album not found: ${query.album}`);
      candidates = candidates.filter((i) => i.album === query.album);
    }
    if (candidates.length > SEARCH_SCAN_CAP) {
      throw new Error(
        `apple-photos: too many items to scan (${candidates.length} > ${SEARCH_SCAN_CAP}) - scope the search with \`album\` (see albums.list)`,
      );
    }
    const q = query.query?.toLowerCase();
    const matched = candidates.filter((i) => {
      const ms = i.date ? Date.parse(i.date) : NaN;
      if (query.startMs !== undefined && !(ms >= query.startMs)) return false;
      if (query.endMs !== undefined && !(ms <= query.endMs)) return false;
      if (q !== undefined) {
        const hay = `${i.filename.toLowerCase()} ${(i.keywords ?? []).join(" ").toLowerCase()}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const items = matched.slice(0, query.limit).map(({ album: _a, keywords: _k, ...item }) => ({ ...item }));
    return { items, scanned: candidates.length, truncated: matched.length > query.limit };
  }

  async exportItem(id: string): Promise<ExportResult> {
    if (this.notAuthorized) throw new PhotosNotAuthorizedError();
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new PhotosNotFoundError(`apple-photos: no media item with id ${id}`);
    // A filename must be a bare basename — a fixture (or, in the real world, a hostile
    // library entry) carrying path separators / traversal is REFUSED, not sanitized.
    const filename = item.filename;
    if (filename === "" || filename !== basename(filename) || filename.includes("..")) {
      throw new PhotosConfinementError(
        `apple-photos: refusing to export item with a path-shaped filename: ${JSON.stringify(filename)}`,
      );
    }
    const jail = ensureDir(resolveExportJail());
    const dir = makeExportDir(jail);
    const path = join(dir, filename);
    assertInsideJail(jail, path);
    writeFileSync(path, `PLEXUS FAKE EXPORT\nid: ${id}\nfilename: ${filename}\n`, "utf-8");
    return { path, filename };
  }
}

// ── §10  Selection ──────────────────────────────────────────────────────────────

/**
 * SELECT the provider: an explicitly-injected one wins; otherwise the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the shared apple-* convention — hermetic tests + e2e),
 * else the REAL osascript provider. Selection lives here so the source/bridge never
 * branch on the env var themselves.
 */
export function selectPhotosProvider(injected?: PhotosProvider): PhotosProvider {
  if (injected) return injected;
  if (process.env.PLEXUS_FAKE_APPLE === "1") return new FakePhotosProvider();
  return new RealPhotosProvider();
}
