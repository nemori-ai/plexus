/**
 * Apple Photos FIRST-PARTY source — scan/health unit + END-TO-END through the gateway.
 *
 * The source is registered in `MODULES` (⇒ reserved in `RESERVED_SOURCE_IDS`), so it
 * boots as a first-party source with NO `registerExtension` call. Under
 * `PLEXUS_FAKE_APPLE=1` the OS-access seam selects the FAKE provider, so the whole flow
 * is hermetic (no macOS, no TCC, no real photo library). Asserts:
 *   - the source registers as FIRST-PARTY; scan() yields the three read capabilities + skill;
 *   - every capability is grants ["read"] (no write/execute anywhere), skill attached,
 *     and the export entry DECLARES the disk side effect + the jail path;
 *   - health() reflects provider.available() (ok under fake; unavailable + the precise
 *     Automation onboarding reason when denied) and NEVER throws;
 *   - through the real pipeline (handshake → grant read → invoke): albums.list returns
 *     the fixtures; search honors album/date/query filters, the default limit (20), the
 *     max limit (100) and the scan cap; bad input is rejected BEFORE the provider;
 *   - export writes EXACTLY ONE placeholder file INSIDE the jail
 *     (`$PLEXUS_HOME/exports/photos/`) and NEVER outside — a traversal-shaped id is
 *     rejected as invalid_input before the provider, and a path-shaped fixture filename
 *     is refused with a confinement error;
 *   - the REAL provider's runner seam: TCC denial detection, JSON parsing, and the
 *     export dir/containment flow — all against a stubbed CommandRunner (no osascript).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, basename } from "node:path";
import { writeFileSync } from "node:fs";

import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  HandshakeResponse,
  InvokeContext,
  InvokeResponse,
  ScopedToken,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { provenanceFor } from "@plexus/runtime/core/capability-registry.ts";
import {
  ApplePhotosSource,
  APPLE_PHOTOS_SOURCE_ID,
  PHOTOS_ALBUMS_LIST_ID,
  PHOTOS_SEARCH_ID,
  PHOTOS_EXPORT_ID,
  PHOTOS_SKILL_ID,
  applePhotosEntries,
  resolveExportJail,
  DEFAULT_SEARCH_LIMIT,
  SEARCH_SCAN_CAP,
} from "@plexus/runtime/sources/index.ts";
import { ApplePhotosBridge } from "@plexus/runtime/sources/apple-photos/bridge.ts";
import {
  FakePhotosProvider,
  RealPhotosProvider,
  isNotAuthorized,
  type FakePhotoItem,
  type PhotosCommandRunner,
  type RunResult,
} from "@plexus/runtime/sources/apple-photos/provider.ts";

/** A minimal BridgeDeps stub (the bridge serves the ops in-process; no transports needed). */
function stubDeps(): { deps: BridgeDeps; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  const byId = new Map(applePhotosEntries().map((e) => [e.id, e]));
  const deps: BridgeDeps = {
    audit: async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
    },
    getTransport: () => {
      throw new Error("not used by the in-process handlers");
    },
    getEntry: (id) => byId.get(id),
    invokeById: async (req) => ({ id: req.id, ok: true, output: {}, auditId: "x" }),
  };
  return { deps, events };
}

const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-applephotos-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  return dir;
}

function freshApp() {
  freshHome();
  _resetSecretCacheForTests();
  const { app, state } = createAppWithState(config);
  return { app, state };
}

async function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId: "agent-1" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grant(app: ReturnType<typeof freshApp>["app"], sessionId: string, id: string): Promise<ScopedToken> {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

async function invoke(
  app: ReturnType<typeof freshApp>["app"],
  token: string,
  id: string,
  input: Record<string, unknown>,
): Promise<InvokeResponse> {
  const res = await req(app, "/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, input }),
  });
  return (await res.json()) as InvokeResponse;
}

beforeEach(() => {
  _resetSecretCacheForTests();
  process.env.PLEXUS_FAKE_APPLE = "1";
});

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
  delete process.env.PLEXUS_FAKE_APPLE;
});

// ── First-party provenance + scan/health (unit) ───────────────────────────────
describe("apple-photos: first-party provenance + scan/health", () => {
  it("is reserved as a FIRST-PARTY source id", () => {
    expect(provenanceFor(APPLE_PHOTOS_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields the three read capabilities + the how-to-use skill, all grants ['read']", async () => {
    const source = new ApplePhotosSource({ provider: new FakePhotosProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const albums = byId.get(PHOTOS_ALBUMS_LIST_ID)!;
    const search = byId.get(PHOTOS_SEARCH_ID)!;
    const exp = byId.get(PHOTOS_EXPORT_ID)!;
    const skill = byId.get(PHOTOS_SKILL_ID)!;

    expect(albums.kind).toBe("capability");
    expect(albums.grants).toEqual(["read"]);
    expect(search.grants).toEqual(["read"]);
    expect(exp.grants).toEqual(["read"]);
    expect(skill.kind).toBe("skill");
    expect(skill.body?.markdown).toContain("metadata");

    // The export entry DECLARES the disk side effect + the jail, honestly.
    expect(exp.describe).toContain("SIDE EFFECT");
    expect(exp.describe).toContain("~/.plexus/exports/photos/");
    // Search is honest about being metadata-only (no ML/content search).
    expect(search.describe).toContain("METADATA ONLY");

    // The skill is attached to ALL THREE capabilities.
    for (const cap of [albums, search, exp]) {
      expect(cap.skills?.some((s) => s.id === PHOTOS_SKILL_ID)).toBe(true);
    }

    // READ posture: no entry requires write/execute.
    for (const e of entries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    expect(entries.filter((e) => e.kind === "capability").length).toBe(3);
  });

  it("health() reflects provider.available(): ok under fake, unavailable + precise Automation reason when denied — never throws", async () => {
    const okSource = new ApplePhotosSource({ provider: new FakePhotosProvider() });
    expect(await okSource.health()).toEqual({ status: "ok" });

    const denied = new ApplePhotosSource({ provider: new FakePhotosProvider({ notAuthorized: true }) });
    const h = await denied.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("Photos access not granted");
    expect(h.detail).toContain("Automation");
  });
});

// ── End-to-end through the gateway pipeline (fake provider via env) ────────────
describe("apple-photos: end-to-end through the gateway (PLEXUS_FAKE_APPLE=1)", () => {
  it("boots as first-party, appears in the handshake manifest read-only, with the skill", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();

    const hs = await handshake(app, state);
    const photosEntries = hs.manifest.entries.filter((e) => e.source === APPLE_PHOTOS_SOURCE_ID);
    const albums = photosEntries.find((e) => e.id === PHOTOS_ALBUMS_LIST_ID);
    const skill = photosEntries.find((e) => e.id === PHOTOS_SKILL_ID);

    expect(albums?.provenance).toBe("first-party");
    expect(albums?.grants).toEqual(["read"]);
    expect(skill?.kind).toBe("skill");
    for (const e of photosEntries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    expect(photosEntries.filter((e) => e.kind === "capability").length).toBe(3);
  });

  it("albums.list returns the fake albums + folders with item counts", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_ALBUMS_LIST_ID);

    const out = await invoke(app, token.token, PHOTOS_ALBUMS_LIST_ID, {});
    expect(out.ok).toBe(true);
    const data = out.output as {
      albums: { name: string; itemCount: number }[];
      folders: { name: string; albums: unknown[] }[];
      truncated: boolean;
    };
    expect(data.albums.map((a) => a.name)).toEqual(["Vacation 2026", "Screenshots"]);
    expect(data.albums[0]?.itemCount).toBe(3);
    expect(data.folders.map((f) => f.name)).toEqual(["Family"]);
    expect(data.truncated).toBe(false);
  });

  it("search scoped by album returns only that album's items", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_SEARCH_ID);

    const out = await invoke(app, token.token, PHOTOS_SEARCH_ID, { album: "Vacation 2026" });
    expect(out.ok).toBe(true);
    const data = out.output as { items: { filename: string; favorite: boolean }[]; scanned: number };
    expect(data.items.map((i) => i.filename)).toEqual(["IMG_0001.HEIC", "IMG_0002.HEIC", "harbor-pano.jpg"]);
    expect(data.items[0]?.favorite).toBe(true);
    expect(data.scanned).toBe(3);
  });

  it("search filters by date range and by filename/keyword substring", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_SEARCH_ID);

    // Date range: only the 2026-06-21 item.
    const byDate = await invoke(app, token.token, PHOTOS_SEARCH_ID, {
      start: "2026-06-21T00:00:00Z",
      end: "2026-06-21T23:59:59Z",
    });
    expect(byDate.ok).toBe(true);
    expect((byDate.output as { items: { filename: string }[] }).items.map((i) => i.filename)).toEqual([
      "IMG_0002.HEIC",
    ]);

    // Keyword substring: "beach" matches only via keywords metadata.
    const byKeyword = await invoke(app, token.token, PHOTOS_SEARCH_ID, { query: "beach" });
    expect(byKeyword.ok).toBe(true);
    expect((byKeyword.output as { items: { filename: string }[] }).items.map((i) => i.filename)).toEqual([
      "IMG_0001.HEIC",
    ]);
  });

  it("search REJECTS a bad limit (0 and 101) as invalid_input BEFORE the provider", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_SEARCH_ID);

    for (const limit of [0, 101]) {
      const out = await invoke(app, token.token, PHOTOS_SEARCH_ID, { limit });
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe("transport_error");
      expect((out.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
      expect(out.error?.message).toMatch(/limit/);
    }
  });

  it("search on an unknown album fails with not_found", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_SEARCH_ID);

    const out = await invoke(app, token.token, PHOTOS_SEARCH_ID, { album: "No Such Album" });
    expect(out.ok).toBe(false);
    expect((out.error?.detail as { reason?: string })?.reason).toBe("not_found");
  });

  it("export writes ONE placeholder file INSIDE the jail and returns its absolute path", async () => {
    const { app, state } = freshApp();
    const home = process.env.PLEXUS_HOME!;
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_EXPORT_ID);

    const out = await invoke(app, token.token, PHOTOS_EXPORT_ID, { id: "9C1B2E30-0001/L0/001" });
    expect(out.ok).toBe(true);
    const data = out.output as { path: string; filename: string };
    expect(data.filename).toBe("IMG_0001.HEIC");

    // The path is absolute, INSIDE the jail under this test's PLEXUS_HOME, and real.
    const jail = join(home, "exports", "photos");
    expect(isAbsolute(data.path)).toBe(true);
    const rel = relative(jail, data.path);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(existsSync(data.path)).toBe(true);
    expect(readFileSync(data.path, "utf-8")).toContain("PLEXUS FAKE EXPORT");
  });

  it("export REJECTS a traversal-shaped id as invalid_input BEFORE the provider is touched", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_EXPORT_ID);

    for (const id of ["../../../etc/passwd", "/etc/passwd", "~/secrets", "a/../../b", "9C1B\\evil"]) {
      const out = await invoke(app, token.token, PHOTOS_EXPORT_ID, { id });
      expect(out.ok).toBe(false);
      expect((out.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
    }
  });

  it("export of an unknown id fails with not_found (and writes nothing)", async () => {
    const { app, state } = freshApp();
    const home = process.env.PLEXUS_HOME!;
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, PHOTOS_EXPORT_ID);

    const out = await invoke(app, token.token, PHOTOS_EXPORT_ID, { id: "DOES-NOT-EXIST/L0/001" });
    expect(out.ok).toBe(false);
    expect((out.error?.detail as { reason?: string })?.reason).toBe("not_found");
    expect(existsSync(join(home, "exports", "photos"))).toBe(false);
  });
});

// ── Bridge-level bounds + confinement (injected fake fixtures) ──────────────────
describe("apple-photos: bounds + confinement via the bridge", () => {
  it("search is bounded to the default limit (20) with truncated:true when more match", async () => {
    freshHome();
    const items: FakePhotoItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: `BULK-${String(i).padStart(3, "0")}/L0/001`,
      filename: `bulk-${i}.jpg`,
      date: "2026-06-01T00:00:00.000Z",
      width: 100,
      height: 100,
      favorite: false,
      album: "Big",
    }));
    const provider = new FakePhotosProvider({
      albums: [{ id: "alb-big", name: "Big", itemCount: items.length }],
      folders: [],
      items,
    });
    const { deps } = stubDeps();
    const bridge = new ApplePhotosBridge(deps, "s1", applePhotosEntries(), provider);

    const out = await bridge.invoke({ id: PHOTOS_SEARCH_ID, input: { album: "Big" } }, ctx);
    expect(out.ok).toBe(true);
    const data = out.output as { items: unknown[]; scanned: number; truncated: boolean };
    expect(data.items.length).toBe(DEFAULT_SEARCH_LIMIT);
    expect(data.scanned).toBe(50);
    expect(data.truncated).toBe(true);
  });

  it("an over-cap unscoped scan is REJECTED with a 'scope the search' message (hard bound, no grind)", async () => {
    freshHome();
    const items: FakePhotoItem[] = Array.from({ length: SEARCH_SCAN_CAP + 1 }, (_, i) => ({
      id: `HUGE-${i}/L0/001`,
      filename: `huge-${i}.jpg`,
      date: null,
      width: null,
      height: null,
      favorite: false,
    }));
    const provider = new FakePhotosProvider({ items });
    const { deps } = stubDeps();
    const bridge = new ApplePhotosBridge(deps, "s1", applePhotosEntries(), provider);

    const out = await bridge.invoke({ id: PHOTOS_SEARCH_ID, input: {} }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/too many items to scan/);
    expect(out.error?.message).toMatch(/scope the search/);
  });

  it("export REFUSES a path-shaped fixture filename (confinement) and writes NOTHING outside the jail", async () => {
    const home = freshHome();
    const provider = new FakePhotosProvider({
      items: [
        {
          id: "EVIL-0001/L0/001",
          filename: "../../evil.txt",
          date: null,
          width: null,
          height: null,
          favorite: false,
        },
      ],
    });
    const { deps } = stubDeps();
    const bridge = new ApplePhotosBridge(deps, "s1", applePhotosEntries(), provider);

    const out = await bridge.invoke({ id: PHOTOS_EXPORT_ID, input: { id: "EVIL-0001/L0/001" } }, ctx);
    expect(out.ok).toBe(false);
    expect((out.error?.detail as { reason?: string })?.reason).toBe("confinement_violation");

    // Nothing escaped: no evil.txt at (or above) PLEXUS_HOME, and the jail holds no files.
    expect(existsSync(join(home, "evil.txt"))).toBe(false);
    expect(existsSync(join(home, "exports", "evil.txt"))).toBe(false);
    const jail = join(home, "exports", "photos");
    if (existsSync(jail)) {
      for (const sub of readdirSync(jail)) {
        expect(readdirSync(join(jail, sub)).length).toBe(0);
      }
    }
  });

  it("a TCC not-authorized state surfaces GRACEFULLY (clear onboarding message, not a crash)", async () => {
    freshHome();
    const { deps } = stubDeps();
    const bridge = new ApplePhotosBridge(
      deps,
      "s1",
      applePhotosEntries(),
      new FakePhotosProvider({ notAuthorized: true }),
    );
    for (const [id, input] of [
      [PHOTOS_ALBUMS_LIST_ID, {}],
      [PHOTOS_SEARCH_ID, {}],
      [PHOTOS_EXPORT_ID, { id: "9C1B2E30-0001/L0/001" }],
    ] as const) {
      const out = await bridge.invoke({ id, input }, ctx);
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe("transport_error");
      expect(out.error?.message).toContain("Photos access not granted");
      expect((out.error?.detail as { reason?: string })?.reason).toBe("not_authorized");
    }
  });

  it("invalid search input is rejected BEFORE the provider is touched", async () => {
    freshHome();
    let providerCalled = false;
    const provider = new FakePhotosProvider();
    const tracking = new Proxy(provider, {
      get(target, prop, recv) {
        if (prop === "search") {
          return (...args: Parameters<typeof target.search>) => {
            providerCalled = true;
            return target.search(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const { deps } = stubDeps();
    const bridge = new ApplePhotosBridge(deps, "s1", applePhotosEntries(), tracking);

    const bad = await bridge.invoke(
      { id: PHOTOS_SEARCH_ID, input: { start: "2026-07-01", end: "2026-06-01" } },
      ctx,
    );
    expect(bad.ok).toBe(false);
    expect((bad.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
    expect(providerCalled).toBe(false);

    const ok = await bridge.invoke({ id: PHOTOS_SEARCH_ID, input: { query: "harbor" } }, ctx);
    expect(ok.ok).toBe(true);
    expect(providerCalled).toBe(true);
  });
});

// ── REAL provider against a stubbed runner (no osascript, no TCC) ───────────────
describe("apple-photos: RealPhotosProvider with a stubbed CommandRunner", () => {
  it("detects the -1743 / 'not authorized' TCC denial and surfaces the onboarding reason", async () => {
    const denyRunner: PhotosCommandRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "execution error: Error: Not authorized to send Apple events to Photos. (-1743)",
    });
    const provider = new RealPhotosProvider(denyRunner);
    const a = await provider.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("Photos access not granted");
    expect(a.reason).toContain("Automation");

    expect(provider.listAlbums()).rejects.toThrow(/Photos access not granted/);
  });

  it("isNotAuthorized recognizes the osascript denial variants", () => {
    const deny = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
    expect(isNotAuthorized(deny("(-1743)"))).toBe(true);
    expect(isNotAuthorized(deny("Not authorized to send Apple events"))).toBe(true);
    expect(isNotAuthorized(deny("not allowed to send apple events"))).toBe(true);
    expect(isNotAuthorized(deny("syntax error"))).toBe(false);
  });

  it("parses the albums JSON the JXA script emits", async () => {
    const runner: PhotosCommandRunner = async () => ({
      code: 0,
      stdout:
        JSON.stringify({
          albums: [{ id: "a1", name: "Trips", itemCount: 12 }],
          folders: [{ id: "f1", name: "Archive", albums: [] }],
          truncated: false,
        }) + "\n",
      stderr: "",
    });
    const provider = new RealPhotosProvider(runner);
    const out = await provider.listAlbums();
    expect(out.albums).toEqual([{ id: "a1", name: "Trips", itemCount: 12 }]);
    expect(out.folders[0]?.name).toBe("Archive");
    expect(out.truncated).toBe(false);
  });

  it("exportItem builds a fresh dir INSIDE the jail, returns the produced file, and confines it", async () => {
    freshHome();
    // Stub runner simulates Photos' export: writes a file into the destination dir
    // (argv layout: ["-l","JavaScript","-e",script,id,destDir]).
    const runner: PhotosCommandRunner = async (_cmd, args) => {
      const dest = args[5]!;
      writeFileSync(join(dest, "IMG_9999.jpeg"), "jpeg-bytes");
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    };
    const provider = new RealPhotosProvider(runner);
    const res = await provider.exportItem("ABCD-1234/L0/001");
    expect(res.filename).toBe("IMG_9999.jpeg");
    expect(basename(res.path)).toBe("IMG_9999.jpeg");
    const rel = relative(resolveExportJail(), res.path);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(readFileSync(res.path, "utf-8")).toBe("jpeg-bytes");
  });

  it("exportItem fails cleanly when the export produced no file", async () => {
    freshHome();
    const runner: PhotosCommandRunner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" });
    const provider = new RealPhotosProvider(runner);
    expect(provider.exportItem("ABCD-1234/L0/001")).rejects.toThrow(/produced no file/);
  });
});
