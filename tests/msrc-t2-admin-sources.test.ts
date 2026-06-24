/**
 * msrc Task 2 — Admin API for managed sources + the write-only secret route.
 *
 * Asserts the management surface (DESIGN §3 entry points, §7 security):
 *   1. POST /admin/api/sources ADDS + PERSISTS + goes LIVE (discover/manifest shows
 *      it; sources.json on disk holds it).
 *   2. GET /admin/api/sources lists configured sources with their live status.
 *   3. enable / disable / remove work via the API.
 *   4. POST /admin/api/secrets/:name is WRITE-ONLY (writes 0600, never reads back)
 *      and REJECTS an unsafe name (path traversal).
 *   5. A cross-origin / non-loopback request to the sources routes is REJECTED by
 *      the Host/Origin guard (the admin surface does NOT widen).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { sourcesConfigPath } from "@plexus/runtime/sources/config/store.ts";
import { OBSIDIAN_SOURCE_ID, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import type { ConfiguredSource } from "@plexus/runtime/sources/config/types.ts";

const config = loadConfig();
const HOST = expectedHost(config);
const dirs: string[] = [];

/** A fresh app over a throwaway PLEXUS_HOME (real registry, empty MODULES). */
/** The active app's verified management connection-key (set per freshApp). */
let activeKey = "";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-msrc-t2-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const built = createAppWithState(config);
  // Mutating admin routes are connection-key gated (msrc-rev). The management
  // client + CLI both send X-Plexus-Connection-Key; the test helper mirrors that
  // so these "authenticated management surface" assertions keep passing.
  activeKey = built.state.connectionKey.current();
  return { ...built, dir };
}

/** Default req = the AUTHENTICATED management surface (sends the verified key). */
function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "X-Plexus-Connection-Key": activeKey, ...(init?.headers ?? {}) },
  });
}

/** A read-only obsidian-fs source — no secret + an in-process handler, so it
 * registers LIVE deterministically without a reachable external service. */
function fsSource(): ConfiguredSource {
  return {
    id: OBSIDIAN_SOURCE_ID,
    kind: "obsidian-fs",
    label: "Obsidian vault (test)",
    enabled: true,
    transport: "ipc",
    route: { vaultPath: join(tmpdir(), "vault-does-not-need-to-exist") },
  };
}

afterAll(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("msrc-t2: POST /admin/api/sources adds + persists + goes live", () => {
  it("registers the capability LIVE, persists sources.json, and discover shows it", async () => {
    const { app, dir } = freshApp();

    const add = await req(app, "/admin/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fsSource()),
    });
    expect(add.status).toBe(200);
    const result = (await add.json()) as { ok: boolean; registered: string[] };
    expect(result.ok).toBe(true);
    expect(result.registered).toContain(VAULT_READ_ID);

    // LIVE: the capability is discoverable via the admin capabilities ledger.
    const caps = await req(app, "/admin/api/capabilities");
    const capsBody = (await caps.json()) as { entries: { id: string }[] };
    expect(capsBody.entries.map((e) => e.id)).toContain(VAULT_READ_ID);

    // LIVE: it also shows in the public .well-known discover summary tier.
    const wk = await req(app, "/.well-known/plexus");
    const wkBody = (await wk.json()) as { capabilities: { id: string }[] };
    expect(wkBody.capabilities.map((e) => e.id)).toContain(VAULT_READ_ID);

    // PERSISTED: sources.json on disk holds the desired state.
    expect(existsSync(join(dir, "sources.json"))).toBe(true);
    const persisted = JSON.parse(readFileSync(sourcesConfigPath(), "utf8")) as {
      sources: { id: string }[];
    };
    expect(persisted.sources.map((s) => s.id)).toContain(OBSIDIAN_SOURCE_ID);

    // LIST: the sources route reports it as live + enabled.
    const list = await req(app, "/admin/api/sources");
    const listBody = (await list.json()) as {
      sources: { id: string; live: boolean; enabled: boolean; liveCapabilityCount: number }[];
    };
    const view = listBody.sources.find((s) => s.id === OBSIDIAN_SOURCE_ID)!;
    expect(view).toBeDefined();
    expect(view.live).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.liveCapabilityCount).toBeGreaterThan(0);
  });

  it("GET /admin/api/sources/detect responds (detector seam)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/sources/detect");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detected: unknown[] };
    expect(Array.isArray(body.detected)).toBe(true);
  });
});

describe("msrc-t2: enable / disable / remove via the API", () => {
  it("disable unregisters (retains config), enable re-registers, remove drops it", async () => {
    const { app } = freshApp();

    await req(app, "/admin/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fsSource()),
    });

    // DISABLE → live gone, config retained as enabled:false.
    const dis = await req(app, `/admin/api/sources/${OBSIDIAN_SOURCE_ID}/disable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(dis.status).toBe(200);
    let caps = (await (await req(app, "/admin/api/capabilities")).json()) as {
      entries: { id: string }[];
    };
    expect(caps.entries.map((e) => e.id)).not.toContain(VAULT_READ_ID);
    let list = (await (await req(app, "/admin/api/sources")).json()) as {
      sources: { id: string; live: boolean; enabled: boolean }[];
    };
    const disabledView = list.sources.find((s) => s.id === OBSIDIAN_SOURCE_ID)!;
    expect(disabledView.enabled).toBe(false);
    expect(disabledView.live).toBe(false);

    // ENABLE → re-registers LIVE.
    const en = await req(app, `/admin/api/sources/${OBSIDIAN_SOURCE_ID}/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(en.status).toBe(200);
    expect(((await en.json()) as { ok: boolean }).ok).toBe(true);
    caps = (await (await req(app, "/admin/api/capabilities")).json()) as { entries: { id: string }[] };
    expect(caps.entries.map((e) => e.id)).toContain(VAULT_READ_ID);

    // REMOVE → live gone + dropped from config.
    const rm = await req(app, `/admin/api/sources/${OBSIDIAN_SOURCE_ID}`, { method: "DELETE" });
    expect(rm.status).toBe(200);
    caps = (await (await req(app, "/admin/api/capabilities")).json()) as { entries: { id: string }[] };
    expect(caps.entries.map((e) => e.id)).not.toContain(VAULT_READ_ID);
    const afterRemove = (await (await req(app, "/admin/api/sources")).json()) as {
      sources: { id: string; live: boolean; enabled: boolean }[];
    };
    expect(afterRemove.sources.map((s) => s.id)).not.toContain(OBSIDIAN_SOURCE_ID);
  });
});

describe("msrc-t2: the secret route is WRITE-ONLY and name-validated", () => {
  it("writes a named secret with 0600 perms and never echoes the value", async () => {
    const { app, dir } = freshApp();
    const secret = "super-secret-bearer-value-xyz";
    const res = await req(app, "/admin/api/secrets/obsidian-rest-api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("obsidian-rest-api-key");
    // WRITE-ONLY: the response body NEVER contains the secret value.
    expect(JSON.stringify(body)).not.toContain(secret);

    // The value landed in the store at ~/.plexus/secrets/<name> with 0600 perms.
    const file = join(dir, "secrets", "obsidian-rest-api-key");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(secret);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    // There is NO read-back route — GET on the secret path falls through to the
    // SPA static handler (HTML), never the secret value.
    const readBack = await req(app, "/admin/api/secrets/obsidian-rest-api-key");
    const text = await readBack.text();
    expect(text).not.toContain(secret);
  });

  it("rejects an unsafe secret name (path traversal) and writes nothing", async () => {
    const { app } = freshApp();
    // Encode the traversal so it reaches the route param rather than 404-ing on path.
    const res = await req(app, "/admin/api/secrets/" + encodeURIComponent("../evil"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("unsafe");
  });

  it("rejects a missing/empty value", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/secrets/some-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("msrc-t2: the sources routes do NOT widen the auth surface", () => {
  it("a cross-origin request to /admin/api/sources is rejected (host_forbidden)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/sources", {
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it("a cross-origin POST to the secret route is rejected (host_forbidden)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/secrets/obsidian-rest-api-key", {
      method: "POST",
      headers: { origin: "http://evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ value: "leak" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it("a non-loopback Host to the sources route is rejected (DNS-rebinding)", async () => {
    const { app } = freshApp();
    const res = await app.request("http://evil.example.com/admin/api/sources", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });
});
