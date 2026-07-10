/**
 * browser FIRST-PARTY source (READ-ONLY) — entries, epoch converters, bookmark walkers,
 * copy-before-open sqlite queries, the fake-provider happy paths through the invoke
 * pipeline, bounds, per-browser degradation shape, and health.
 *
 * The browser source exposes Safari + Google Chrome, strictly read-only:
 *   - `browser.tabs.list`        (grants:["read"], osascript/JXA)
 *   - `browser.bookmarks.search` (grants:["read"], plist/JSON, bounded)
 *   - `browser.history.search`   (grants:["read"], copied sqlite, bounded, newest first)
 *
 * Proves (HERMETICALLY — the fake provider, fixture profile dirs + fixture sqlite dbs
 * built with bun:sqlite; NO osascript, NO ~/Library, NO real browser):
 *  - the module registers as FIRST-PARTY and scan() yields 3 READ caps + the skill;
 *  - the REAL epoch converters are correct for known WebKit / Core Data timestamps;
 *  - the Chrome/Safari bookmark tree walkers match by title/url substring and bound;
 *  - queryChromeHistoryDb / querySafariHistoryDb read a COPY (original untouched), filter
 *    by substring + date range, sort newest first, and convert epochs to ISO;
 *  - each capability's happy path + bounds through the bridge (fake provider);
 *  - PER-BROWSER DEGRADATION: a Safari-unavailable state yields ok:true with Chrome rows
 *    plus browsers.safari = { status:"unavailable", note } — never an error;
 *  - input validation fails closed (missing query / bad dates → schema_validation_failed);
 *  - health(): fake ⇒ ok; a real provider with NEITHER browser reachable ⇒ unavailable
 *    with a detail naming Full Disk Access; ONE reachable browser ⇒ ok.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { createCapabilityRegistry, provenanceFor } from "@plexus/runtime/core/capability-registry.ts";
import {
  browserSourceModule,
  BrowserSource,
  BrowserBridge,
  browserEntries,
  validateHistoryInput,
  FakeBrowserProvider,
  RealBrowserProvider,
  selectBrowserProvider,
  clampBrowserLimit,
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
  SAFARI_FDA_MESSAGE,
  BROWSER_SOURCE_ID,
  BROWSER_TABS_LIST_ID,
  BROWSER_BOOKMARKS_SEARCH_ID,
  BROWSER_HISTORY_SEARCH_ID,
  BROWSER_HOW_TO_USE_ID,
  type BrowserSections,
  type BrowserTab,
  type BrowserBookmark,
  type BrowserVisit,
} from "@plexus/runtime/sources/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  EntryKind,
  GrantVerb,
  InvokeContext,
  PlatformServices,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function platformStub(): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary() {
      return undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function testRegistry(modules: SourceModule[]): SourceRegistry {
  const transports = buildTransports(platformStub());
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport => transports[kind],
  };
}

/** A bridge deps stub that records audit events + serves entries from a snapshot. */
function bridgeDeps(entries = browserEntries()): { deps: BridgeDeps; events: AuditEventInput[] } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
  };
  const transports = buildTransports(platformStub());
  const deps: BridgeDeps = {
    audit,
    getTransport: (k: TransportKind): Transport => transports[k],
    getEntry: (id) => byId.get(id),
    invokeById: async (req) => ({ id: req.id, ok: true, output: {}, auditId: "x" }),
  };
  return { deps, events };
}

const CTX: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

// ── entries + provenance ──────────────────────────────────────────────────────

describe("browser source: provenance + scan() entries", () => {
  it("is FIRST-PARTY (reserved source id derived from MODULES)", () => {
    expect(provenanceFor(BROWSER_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields the three READ caps + the how-to skill", async () => {
    const source = new BrowserSource({ provider: new FakeBrowserProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    expect(byId.has(BROWSER_TABS_LIST_ID)).toBe(true);
    expect(byId.has(BROWSER_BOOKMARKS_SEARCH_ID)).toBe(true);
    expect(byId.has(BROWSER_HISTORY_SEARCH_ID)).toBe(true);
    expect(byId.has(BROWSER_HOW_TO_USE_ID)).toBe(true);

    expect(byId.get(BROWSER_TABS_LIST_ID)!.grants).toEqual(["read"]);
    expect(byId.get(BROWSER_BOOKMARKS_SEARCH_ID)!.grants).toEqual(["read"]);
    expect(byId.get(BROWSER_HISTORY_SEARCH_ID)!.grants).toEqual(["read"]);

    const skill = byId.get(BROWSER_HOW_TO_USE_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
    // The skill documents the bounded results + per-browser degradation semantics.
    expect(skill.body?.markdown).toContain("Bounded results");
    expect(skill.body?.markdown).toContain("Per-browser degradation");
    expect(skill.body?.markdown).toContain("Full Disk Access");
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const entries = browserEntries();
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];

    for (const e of entries) {
      expect(e.id.startsWith("browser.")).toBe(true);
      expect(e.source).toBe("browser");
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
      if (e.kind === "capability") {
        expect(e.transport).toBe("ipc");
        expect(e.grants).toEqual(["read"]); // NO write/exec anywhere in this source
        expect((e.extras as { firstParty?: boolean })?.firstParty).toBe(true);
        expect(e.io?.input).toBeDefined();
        expect(e.io?.output).toBeDefined();
      }
      if (e.kind === "skill") {
        expect(e.transport).toBe("skill");
        expect(e.body).toBeDefined();
      }
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the three capabilities appear in the registry after registering the module", async () => {
    const reg = createCapabilityRegistry(testRegistry([browserSourceModule]));
    await reg.refresh();
    const ids = reg.all().map((e) => e.id);
    expect(ids).toContain(BROWSER_TABS_LIST_ID);
    expect(ids).toContain(BROWSER_BOOKMARKS_SEARCH_ID);
    expect(ids).toContain(BROWSER_HISTORY_SEARCH_ID);
    for (const id of [BROWSER_TABS_LIST_ID, BROWSER_BOOKMARKS_SEARCH_ID, BROWSER_HISTORY_SEARCH_ID]) {
      const s = reg.summaries().find((x) => x.id === id)!;
      expect(s.grants).toEqual(["read"]);
    }
  });
});

// ── epoch converters (the REAL converters, known timestamps) ──────────────────

describe("browser epoch converters", () => {
  it("webkitMicrosToIso: WebKit µs since 1601 → ISO (known values)", () => {
    // 2020-01-01T00:00:00Z unix = 1_577_836_800 s; +11_644_473_600 s to 1601; ×1e6 → µs.
    expect(webkitMicrosToIso(13_222_310_400_000_000)).toBe("2020-01-01T00:00:00.000Z");
    // The WebKit epoch itself.
    expect(webkitMicrosToIso(0)).toBe("1601-01-01T00:00:00.000Z");
    // A real Chrome last_visit_time captured on this machine (2026-07).
    expect(webkitMicrosToIso(13_428_127_758_841_482).startsWith("2026-07-")).toBe(true);
  });

  it("epochMsToWebkitMicros is the exact inverse", () => {
    const ms = Date.parse("2026-06-24T15:00:00.000Z");
    expect(webkitMicrosToIso(epochMsToWebkitMicros(ms))).toBe("2026-06-24T15:00:00.000Z");
    expect(epochMsToWebkitMicros(Date.parse("2020-01-01T00:00:00Z"))).toBe(13_222_310_400_000_000);
  });

  it("coreDataSecondsToIso: Core Data s since 2001 → ISO (known values)", () => {
    // 2020-01-01T00:00:00Z unix = 1_577_836_800 s; −978_307_200 s to 2001 ⇒ 599_529_600.
    expect(coreDataSecondsToIso(599_529_600)).toBe("2020-01-01T00:00:00.000Z");
    // The Core Data epoch itself.
    expect(coreDataSecondsToIso(0)).toBe("2001-01-01T00:00:00.000Z");
    // Fractional seconds (Safari stores REAL) survive.
    expect(coreDataSecondsToIso(599_529_600.5)).toBe("2020-01-01T00:00:00.500Z");
  });

  it("epochMsToCoreDataSeconds is the exact inverse", () => {
    const ms = Date.parse("2026-06-24T15:00:00.000Z");
    expect(coreDataSecondsToIso(epochMsToCoreDataSeconds(ms))).toBe("2026-06-24T15:00:00.000Z");
    expect(epochMsToCoreDataSeconds(Date.parse("2020-01-01T00:00:00Z"))).toBe(599_529_600);
  });
});

// ── bounds + LIKE escaping + tab-script parsing ───────────────────────────────

describe("browser bounds + helpers", () => {
  it("clampBrowserLimit applies the default + hard caps", () => {
    expect(clampBrowserLimit(undefined)).toBe(20);
    expect(clampBrowserLimit(999_999)).toBe(200);
    expect(clampBrowserLimit(0)).toBe(1);
    expect(clampBrowserLimit(-3)).toBe(1);
    expect(clampBrowserLimit(7)).toBe(7);
  });

  it("likePattern escapes %/_/\\ so the query is a literal substring", () => {
    expect(likePattern("plain")).toBe("%plain%");
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });

  it("parseTabsScriptResult defensively shapes the JXA output", () => {
    const r = parseTabsScriptResult(
      '{"installed":true,"running":true,"tabs":[{"window":1,"title":"T","url":"https://x/"},{"bogus":1}]}\n',
    );
    expect(r.installed).toBe(true);
    expect(r.tabs).toHaveLength(2);
    expect(r.tabs[0]).toEqual({ window: 1, title: "T", url: "https://x/" });
    expect(r.tabs[1]).toEqual({ window: 0, title: "", url: "" });
    expect(() => parseTabsScriptResult("not json")).toThrow();
  });
});

// ── bookmark tree walkers (pure) ──────────────────────────────────────────────

describe("browser bookmark walkers", () => {
  const chromeRoots = {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks Bar",
      children: [
        { type: "url", name: "Bun docs", url: "https://bun.sh/docs" },
        {
          type: "folder",
          name: "Dev",
          children: [{ type: "url", name: "SQLite", url: "https://sqlite.org/" }],
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other Bookmarks",
      children: [{ type: "url", name: "Recipes", url: "https://cooking.example.com/" }],
    },
    synced: undefined,
  };

  it("collectChromeBookmarks matches title OR url (case-insensitive) with folder paths", () => {
    const byTitle = collectChromeBookmarks(chromeRoots, "sqlite", 20);
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]).toEqual({
      browser: "chrome",
      title: "SQLite",
      url: "https://sqlite.org/",
      folder: "Bookmarks Bar/Dev",
    });
    const byUrl = collectChromeBookmarks(chromeRoots, "COOKING.EXAMPLE", 20);
    expect(byUrl).toHaveLength(1);
    expect(byUrl[0]!.title).toBe("Recipes");
  });

  it("collectChromeBookmarks bounds at limit", () => {
    const all = collectChromeBookmarks(chromeRoots, "s", 20); // matches everything
    expect(all.length).toBeGreaterThan(1);
    expect(collectChromeBookmarks(chromeRoots, "s", 1)).toHaveLength(1);
  });

  const safariRoot = {
    Title: "",
    Children: [
      {
        WebBookmarkType: "WebBookmarkTypeProxy", // History proxy node — must be skipped
        Title: "History",
      },
      {
        WebBookmarkType: "WebBookmarkTypeList",
        Title: "BookmarksBar",
        Children: [
          {
            WebBookmarkType: "WebBookmarkTypeLeaf",
            URLString: "https://developer.apple.com/",
            URIDictionary: { title: "Apple Developer" },
          },
          {
            WebBookmarkType: "WebBookmarkTypeList",
            Title: "Dev",
            Children: [
              {
                WebBookmarkType: "WebBookmarkTypeLeaf",
                URLString: "https://webkit.org/",
                URIDictionary: { title: "WebKit" },
              },
            ],
          },
        ],
      },
    ],
  };

  it("collectSafariBookmarks walks WebBookmarkTypeLeaf nodes with folder paths", () => {
    const hits = collectSafariBookmarks(safariRoot, "webkit", 20);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      browser: "safari",
      title: "WebKit",
      url: "https://webkit.org/",
      folder: "BookmarksBar/Dev",
    });
    expect(collectSafariBookmarks(safariRoot, "apple", 20)).toHaveLength(1);
    expect(collectSafariBookmarks(safariRoot, "no-such-thing", 20)).toHaveLength(0);
  });
});

// ── copy-before-open sqlite queries (fixture dbs; the REAL query path) ─────────

/** Build a Chrome-shaped History db (urls table, WebKit-µs last_visit_time). */
function makeChromeHistoryDb(dir: string): string {
  const path = join(dir, "History");
  const db = new Database(path);
  db.run("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)");
  const ins = db.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)");
  ins.run("https://bun.sh/docs", "Bun docs", epochMsToWebkitMicros(Date.parse("2026-06-25T10:00:00Z")));
  ins.run("https://sqlite.org/wal.html", "SQLite WAL", epochMsToWebkitMicros(Date.parse("2026-06-20T18:00:00Z")));
  ins.run("https://old.example.com/", "Old bun page", epochMsToWebkitMicros(Date.parse("2020-01-05T00:00:00Z")));
  ins.run("https://never-visited.example.com/", "bun zero", 0); // must be filtered out
  db.close();
  return path;
}

/** Build a Safari-shaped History.db (history_items + history_visits, Core-Data-s). */
function makeSafariHistoryDb(dir: string): string {
  const path = join(dir, "History.db");
  const db = new Database(path);
  db.run("CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT)");
  db.run(
    "CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, title TEXT, visit_time REAL)",
  );
  const item = db.prepare("INSERT INTO history_items (id, url) VALUES (?, ?)");
  const visit = db.prepare("INSERT INTO history_visits (history_item, title, visit_time) VALUES (?, ?, ?)");
  item.run(1, "https://plexus.vibecoding.icu/concepts");
  visit.run(1, "Plexus concepts", epochMsToCoreDataSeconds(Date.parse("2026-06-24T09:30:00Z")));
  item.run(2, "https://webkit.org/");
  visit.run(2, "WebKit epoch notes", epochMsToCoreDataSeconds(Date.parse("2026-05-01T12:00:00Z")));
  db.close();
  return path;
}

describe("browser sqlite history queries (copy-before-open)", () => {
  it("queryChromeHistoryDb filters by substring, sorts newest first, converts WebKit µs → ISO", () => {
    const dir = tmp("plexus-browser-chrome-");
    const src = makeChromeHistoryDb(dir);
    const copy = copySqliteToTemp(src);
    try {
      const rows = queryChromeHistoryDb(copy.path, { query: "bun", limit: 20 });
      expect(rows.map((r) => r.url)).toEqual(["https://bun.sh/docs", "https://old.example.com/"]);
      expect(rows[0]!.lastVisited).toBe("2026-06-25T10:00:00.000Z");
      expect(rows[0]!.browser).toBe("chrome");
      // last_visit_time = 0 rows are excluded even though the title matches.
      expect(rows.some((r) => r.url.includes("never-visited"))).toBe(false);
    } finally {
      copy.cleanup();
    }
    expect(existsSync(copy.path)).toBe(false); // temp copy cleaned up
    expect(existsSync(src)).toBe(true); // original untouched
  });

  it("queryChromeHistoryDb honors the date range (inclusive bounds in WebKit µs)", () => {
    const dir = tmp("plexus-browser-chrome-range-");
    const copy = copySqliteToTemp(makeChromeHistoryDb(dir));
    try {
      const rows = queryChromeHistoryDb(copy.path, {
        query: "bun",
        startMs: Date.parse("2026-01-01T00:00:00Z"),
        limit: 20,
      });
      expect(rows.map((r) => r.url)).toEqual(["https://bun.sh/docs"]); // 2020 row excluded
      const upTo = queryChromeHistoryDb(copy.path, {
        query: "bun",
        endMs: Date.parse("2021-01-01T00:00:00Z"),
        limit: 20,
      });
      expect(upTo.map((r) => r.url)).toEqual(["https://old.example.com/"]);
    } finally {
      copy.cleanup();
    }
  });

  it("querySafariHistoryDb joins items↔visits and converts Core Data s → ISO", () => {
    const dir = tmp("plexus-browser-safari-");
    const copy = copySqliteToTemp(makeSafariHistoryDb(dir));
    try {
      const rows = querySafariHistoryDb(copy.path, { query: "webkit", limit: 20 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        browser: "safari",
        title: "WebKit epoch notes",
        url: "https://webkit.org/",
        lastVisited: "2026-05-01T12:00:00.000Z",
      });
      // Matches on URL too, newest first, bounded.
      const both = querySafariHistoryDb(copy.path, { query: "https://", limit: 20 });
      expect(both.map((r) => r.lastVisited)).toEqual([
        "2026-06-24T09:30:00.000Z",
        "2026-05-01T12:00:00.000Z",
      ]);
      expect(querySafariHistoryDb(copy.path, { query: "https://", limit: 1 })).toHaveLength(1);
    } finally {
      copy.cleanup();
    }
  });

  it("copySqliteToTemp copies -wal/-shm sidecars when present", () => {
    const dir = tmp("plexus-browser-wal-");
    const src = join(dir, "History.db");
    writeFileSync(src, "not-really-sqlite");
    writeFileSync(src + "-wal", "wal");
    writeFileSync(src + "-shm", "shm");
    const copy = copySqliteToTemp(src);
    try {
      expect(existsSync(copy.path)).toBe(true);
      expect(existsSync(copy.path + "-wal")).toBe(true);
      expect(existsSync(copy.path + "-shm")).toBe(true);
      expect(readFileSync(copy.path, "utf-8")).toBe("not-really-sqlite");
    } finally {
      copy.cleanup();
    }
    expect(existsSync(copy.path)).toBe(false);
  });
});

// ── REAL provider against fixture profile dirs (per-browser degradation, live shape) ──

describe("browser real provider: fixture Chrome profile + unreadable Safari", () => {
  function makeChromeProfile(): string {
    const dir = tmp("plexus-browser-profile-");
    makeChromeHistoryDb(dir);
    writeFileSync(
      join(dir, "Bookmarks"),
      JSON.stringify({
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks Bar",
            children: [{ type: "url", name: "Plexus repo", url: "https://github.com/plexus/plexus" }],
          },
        },
      }),
    );
    return dir;
  }

  it("bookmarks: Chrome rows return while Safari degrades to unavailable (FDA note)", async () => {
    const missingSafari = join(tmp("plexus-browser-nosafari-"), "Safari");
    const provider = new RealBrowserProvider({
      safariDir: missingSafari,
      chromeProfileDir: makeChromeProfile(),
    });
    const res = await provider.searchBookmarks("plexus", 20);
    expect(res.bookmarks).toHaveLength(1);
    expect(res.bookmarks[0]!.browser).toBe("chrome");
    expect(res.browsers.chrome.status).toBe("ok");
    expect(res.browsers.chrome.count).toBe(1);
    expect(res.browsers.safari.status).toBe("unavailable");
    expect(res.browsers.safari.note).toContain("Full Disk Access");
  });

  it("history: Chrome rows return (copy-before-open) while Safari degrades; bounded + newest first", async () => {
    const missingSafari = join(tmp("plexus-browser-nosafari2-"), "Safari");
    const provider = new RealBrowserProvider({
      safariDir: missingSafari,
      chromeProfileDir: makeChromeProfile(),
    });
    const res = await provider.searchHistory({ query: "bun", limit: 1 });
    expect(res.visits).toHaveLength(1); // bounded to 1
    expect(res.visits[0]!.url).toBe("https://bun.sh/docs"); // the newest match wins the slice
    expect(res.visits[0]!.lastVisited).toBe("2026-06-25T10:00:00.000Z");
    expect(res.browsers.safari.status).toBe("unavailable");
    expect(res.browsers.safari.note).toContain("Full Disk Access");
    expect(res.browsers.chrome.status).toBe("ok");
  });

  it("history: a Safari fixture db is read through the SAME per-browser path (Core Data → ISO)", async () => {
    const safariDir = tmp("plexus-browser-safaridir-");
    makeSafariHistoryDb(safariDir);
    const provider = new RealBrowserProvider({
      safariDir,
      chromeProfileDir: join(tmp("plexus-browser-nochrome-"), "Default"),
    });
    const res = await provider.searchHistory({ query: "plexus", limit: 20 });
    expect(res.visits).toHaveLength(1);
    expect(res.visits[0]!.browser).toBe("safari");
    expect(res.visits[0]!.lastVisited).toBe("2026-06-24T09:30:00.000Z");
    expect(res.browsers.safari.status).toBe("ok");
    expect(res.browsers.chrome.status).toBe("unavailable");
    expect(res.browsers.chrome.note).toContain("Chrome history not found");
  });
});

// ── bridge happy paths + bounds + degradation (fake provider) ─────────────────

describe("browser bridge: happy paths through the fake provider", () => {
  it("browser.tabs.list returns tabs from both browsers + ok sections", async () => {
    const { deps, events } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), new FakeBrowserProvider());

    expect(bridge.route(BROWSER_TABS_LIST_ID)).toBe("handled");
    const res = await bridge.invoke({ id: BROWSER_TABS_LIST_ID, input: {} }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { tabs: BrowserTab[]; browsers: BrowserSections };
    expect(out.tabs.length).toBeGreaterThan(0);
    expect(out.tabs.some((t) => t.browser === "safari")).toBe(true);
    expect(out.tabs.some((t) => t.browser === "chrome")).toBe(true);
    for (const t of out.tabs) {
      expect(typeof t.title).toBe("string");
      expect(typeof t.url).toBe("string");
      expect(t.window).toBeGreaterThan(0);
    }
    expect(out.browsers.safari.status).toBe("ok");
    expect(out.browsers.chrome.status).toBe("ok");

    // Audited once, with the READ verb.
    const a = events.find((e) => e.capabilityId === BROWSER_TABS_LIST_ID);
    expect(a?.verbs).toEqual(["read"]);
    expect(a?.outcome).toBe("ok");
  });

  it("browser.bookmarks.search matches by substring and respects the bound", async () => {
    const { deps } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), new FakeBrowserProvider());

    const res = await bridge.invoke({ id: BROWSER_BOOKMARKS_SEARCH_ID, input: { query: "plexus" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { bookmarks: BrowserBookmark[]; browsers: BrowserSections };
    expect(out.bookmarks.length).toBe(2); // one per browser in the fixtures
    expect(out.bookmarks.every((b) => (b.title + b.url).toLowerCase().includes("plexus"))).toBe(true);

    const bounded = await bridge.invoke(
      { id: BROWSER_BOOKMARKS_SEARCH_ID, input: { query: "plexus", limit: 1 } },
      CTX,
    );
    expect((bounded.output as { bookmarks: BrowserBookmark[] }).bookmarks).toHaveLength(1);
  });

  it("browser.history.search returns newest-first ISO rows and honors the date range", async () => {
    const { deps } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), new FakeBrowserProvider());

    const res = await bridge.invoke({ id: BROWSER_HISTORY_SEARCH_ID, input: { query: "e" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { visits: BrowserVisit[]; browsers: BrowserSections };
    const times = out.visits.map((v) => Date.parse(v.lastVisited));
    expect([...times].sort((a, b) => b - a)).toEqual(times); // newest first

    // Date range: only the June 2026 rows.
    const ranged = await bridge.invoke(
      {
        id: BROWSER_HISTORY_SEARCH_ID,
        input: { query: "e", start: "2026-06-01T00:00:00Z", end: "2026-06-30T00:00:00Z" },
      },
      CTX,
    );
    const rangedOut = ranged.output as { visits: BrowserVisit[] };
    expect(rangedOut.visits.length).toBeGreaterThan(0);
    for (const v of rangedOut.visits) {
      expect(v.lastVisited >= "2026-06-01").toBe(true);
      expect(v.lastVisited < "2026-07-01").toBe(true);
    }

    // Bound.
    const bounded = await bridge.invoke(
      { id: BROWSER_HISTORY_SEARCH_ID, input: { query: "e", limit: 1 } },
      CTX,
    );
    expect((bounded.output as { visits: BrowserVisit[] }).visits).toHaveLength(1);
  });
});

// ── per-browser degradation SHAPE through the invoke pipeline ─────────────────

describe("browser bridge: per-browser degradation (Safari down ≠ call failure)", () => {
  const downProvider = (): FakeBrowserProvider =>
    new FakeBrowserProvider({ safariUnavailable: SAFARI_FDA_MESSAGE });

  it("history: ok:true with Chrome rows + browsers.safari unavailable + FDA note", async () => {
    const { deps, events } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), downProvider());

    const res = await bridge.invoke({ id: BROWSER_HISTORY_SEARCH_ID, input: { query: "e" } }, CTX);
    expect(res.ok).toBe(true); // NOT an error — degradation is data
    const out = res.output as { visits: BrowserVisit[]; browsers: BrowserSections };
    expect(out.visits.length).toBeGreaterThan(0);
    expect(out.visits.every((v) => v.browser === "chrome")).toBe(true);
    expect(out.browsers.safari).toEqual({
      status: "unavailable",
      count: 0,
      note: SAFARI_FDA_MESSAGE,
    });
    expect(out.browsers.chrome.status).toBe("ok");
    expect(out.browsers.chrome.count).toBe(out.visits.length);
    expect(events.find((e) => e.capabilityId === BROWSER_HISTORY_SEARCH_ID)?.outcome).toBe("ok");
  });

  it("tabs + bookmarks carry the same section shape", async () => {
    const { deps } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), downProvider());

    const tabs = await bridge.invoke({ id: BROWSER_TABS_LIST_ID, input: {} }, CTX);
    const tabsOut = tabs.output as { tabs: BrowserTab[]; browsers: BrowserSections };
    expect(tabs.ok).toBe(true);
    expect(tabsOut.tabs.every((t) => t.browser === "chrome")).toBe(true);
    expect(tabsOut.browsers.safari.status).toBe("unavailable");

    const bm = await bridge.invoke({ id: BROWSER_BOOKMARKS_SEARCH_ID, input: { query: "plexus" } }, CTX);
    const bmOut = bm.output as { bookmarks: BrowserBookmark[]; browsers: BrowserSections };
    expect(bm.ok).toBe(true);
    expect(bmOut.bookmarks.every((b) => b.browser === "chrome")).toBe(true);
    expect(bmOut.browsers.safari.note).toContain("Full Disk Access");
  });
});

// ── input validation fails closed ─────────────────────────────────────────────

describe("browser bridge: input validation", () => {
  it("bookmarks.search without `query` fails schema_validation_failed", async () => {
    const { deps } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), new FakeBrowserProvider());
    const res = await bridge.invoke({ id: BROWSER_BOOKMARKS_SEARCH_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("history.search rejects a bad date and a reversed range", async () => {
    const { deps } = bridgeDeps();
    const bridge = new BrowserBridge(deps, "s1", browserEntries(), new FakeBrowserProvider());

    const bad = await bridge.invoke(
      { id: BROWSER_HISTORY_SEARCH_ID, input: { query: "x", start: "not-a-date" } },
      CTX,
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("schema_validation_failed");

    const reversed = await bridge.invoke(
      {
        id: BROWSER_HISTORY_SEARCH_ID,
        input: { query: "x", start: "2026-06-02T00:00:00Z", end: "2026-06-01T00:00:00Z" },
      },
      CTX,
    );
    expect(reversed.ok).toBe(false);
    expect(reversed.error?.code).toBe("schema_validation_failed");
  });

  it("validateHistoryInput unit: clamps limit + carries validated epoch-ms bounds", () => {
    const v = validateHistoryInput({
      query: "q",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T00:00:00Z",
      limit: 999_999,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.q.limit).toBe(200);
      expect(v.q.startMs).toBe(Date.parse("2026-06-01T00:00:00Z"));
      expect(v.q.endMs).toBe(Date.parse("2026-06-30T00:00:00Z"));
    }
    expect(validateHistoryInput({ query: "  " }).ok).toBe(false);
  });
});

// ── health + selection ────────────────────────────────────────────────────────

describe("browser source: health reflects provider.available()", () => {
  it("fake provider ⇒ ok", async () => {
    const source = new BrowserSource({ provider: new FakeBrowserProvider() });
    expect((await source.health()).status).toBe("ok");
    expect((await source.checkRequirements()).ok).toBe(true);
  });

  it("NEITHER browser reachable ⇒ unavailable with a Full Disk Access detail (never throws)", async () => {
    const ghost = tmp("plexus-browser-ghost-");
    const source = new BrowserSource({
      provider: new RealBrowserProvider({
        safariDir: join(ghost, "no-safari"),
        chromeProfileDir: join(ghost, "no-chrome"),
      }),
    });
    const h = await source.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("Full Disk Access");
    expect(h.detail).toContain("Privacy & Security");
  });

  it("ONE reachable browser (Chrome fixture) ⇒ ok — partial availability is per-call data", async () => {
    const dir = tmp("plexus-browser-halfok-");
    makeChromeHistoryDb(dir);
    const source = new BrowserSource({
      provider: new RealBrowserProvider({
        safariDir: join(dir, "no-safari"),
        chromeProfileDir: dir,
      }),
    });
    expect((await source.health()).status).toBe("ok");
  });

  it("PLEXUS_FAKE_BROWSER=1 selects the fake provider (mirrors PLEXUS_FAKE_APPLE)", () => {
    const prev = process.env.PLEXUS_FAKE_BROWSER;
    try {
      process.env.PLEXUS_FAKE_BROWSER = "1";
      expect(selectBrowserProvider() instanceof FakeBrowserProvider).toBe(true);
      delete process.env.PLEXUS_FAKE_BROWSER;
      expect(selectBrowserProvider() instanceof RealBrowserProvider).toBe(true);
      // An injected provider always wins.
      const injected = new FakeBrowserProvider();
      expect(selectBrowserProvider(injected)).toBe(injected);
    } finally {
      if (prev === undefined) delete process.env.PLEXUS_FAKE_BROWSER;
      else process.env.PLEXUS_FAKE_BROWSER = prev;
    }
  });
});
