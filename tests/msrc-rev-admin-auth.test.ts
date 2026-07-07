/**
 * msrc-rev — SECURITY GATE for the managed-sources admin surface.
 *
 * The CONFIRMED must-fix: the `/admin/api/*` MUTATING routes were gated by the
 * loopback Host guard ONLY — any local process could add a write-capable source
 * or write a secret with NO connection-key and NO human. This suite proves the
 * fix:
 *
 *   1. UNAUTHENTICATED (no-key) mutating calls are REJECTED (401) — the
 *      orchestrator's probe: POST /admin/api/sources + POST /admin/api/secrets/:name
 *      + the grant-mutating routes (grants/revoke/pending/enable/
 *      disable/reconfigure/remove).
 *   2. A WRONG key is also rejected (401) — the key is actually verified, not just
 *      present.
 *   3. WITH the verified key the same calls SUCCEED (the management client + CLI
 *      both send X-Plexus-Connection-Key, so the real surfaces keep working).
 *   4. Read-only GETs (capabilities/audit/sources LIST/detect/connection-key) stay
 *      loopback-only (the documented read boundary).
 *   5. W-1: a tampered `cli`-kind / non-loopback source is bounded — an unknown
 *      kind never registers; a non-loopback baseUrl is host_forbidden at dispatch
 *      (transport egress confinement, asserted elsewhere) and the kind is rejected
 *      at boot-load. Write-capable boot-load is DISCOVERABLE, not auto-granted.
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { OBSIDIAN_SOURCE_ID, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import type { ConfiguredSource } from "@plexus/runtime/sources/config/types.ts";

const config = loadConfig();
const HOST = expectedHost(config);
const dirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-msrc-rev-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const built = createAppWithState(config);
  return { ...built, key: built.state.connectionKey.current(), dir };
}

/** A request with a loopback Host. `key` controls the management header. */
function req(
  app: ReturnType<typeof freshApp>["app"],
  path: string,
  opts: { method?: string; body?: unknown; key?: string | null } = {},
) {
  const headers: Record<string, string> = { host: HOST };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key) headers["X-Plexus-Connection-Key"] = opts.key;
  return app.request("http://" + HOST + path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** A read-only fs source (registers LIVE deterministically, no external service). */
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

describe("msrc-rev: mutating admin routes REJECT an unauthenticated (no-key) caller", () => {
  it("POST /admin/api/sources with NO key → 401 (the orchestrator probe)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/sources", { method: "POST", body: fsSource() });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unauthorized");
  });

  it("POST /admin/api/secrets/:name with NO key → 401 (no value-ingress without the key)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/secrets/obsidian-key", {
      method: "POST",
      body: { value: "super-secret" },
    });
    expect(res.status).toBe(401);
  });

  it("every grant/source-management mutating route → 401 with no key", async () => {
    const { app } = freshApp();
    const probes: [string, string, unknown?][] = [
      ["PUT", "/admin/api/grants", { grants: {} }],
      ["POST", "/admin/api/revoke", { jti: "x" }],
      ["POST", "/admin/api/pending/anything", { action: "approve" }],
      ["POST", `/admin/api/sources/${OBSIDIAN_SOURCE_ID}/enable`, {}],
      ["POST", `/admin/api/sources/${OBSIDIAN_SOURCE_ID}/disable`, {}],
      ["POST", `/admin/api/sources/${OBSIDIAN_SOURCE_ID}/reconfigure`, { label: "x" }],
      ["DELETE", `/admin/api/sources/${OBSIDIAN_SOURCE_ID}`, undefined],
    ];
    for (const [method, path, body] of probes) {
      const res = await req(app, path, { method, body });
      expect(res.status).toBe(401);
    }
  });

  it("a WRONG key is rejected too (the key is verified, not just present)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/sources", {
      method: "POST",
      body: fsSource(),
      key: "plx_live_not_the_real_key",
    });
    expect(res.status).toBe(401);
  });
});

describe("msrc-rev: WITH the verified key, the management surface works (client + CLI)", () => {
  it("POST /admin/api/sources WITH the key → 200 + registers LIVE", async () => {
    const { app, key } = freshApp();
    const res = await req(app, "/admin/api/sources", { method: "POST", body: fsSource(), key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; registered: string[] };
    expect(body.ok).toBe(true);
    expect(body.registered).toContain(VAULT_READ_ID);
  });

  it("POST /admin/api/secrets/:name WITH the key → 200, write-only (never echoed)", async () => {
    const { app, key } = freshApp();
    const write = await req(app, "/admin/api/secrets/obsidian-key", {
      method: "POST",
      body: { value: "super-secret" },
      key,
    });
    expect(write.status).toBe(200);
    const body = (await write.json()) as { ok: boolean; name: string; value?: unknown };
    expect(body.ok).toBe(true);
    expect(body.value).toBeUndefined(); // never read back
    // The store offers no read-back route at all: a GET on the secret path is the SPA
    // fallthrough (not the value).
    const readBack = await req(app, "/admin/api/secrets/obsidian-key", { key });
    const text = await readBack.text();
    expect(text).not.toContain("super-secret");
  });

  it("an UNSAFE secret name is rejected even WITH the key (path traversal)", async () => {
    const { app, key } = freshApp();
    const res = await req(app, "/admin/api/secrets/" + encodeURIComponent("../evil"), {
      method: "POST",
      body: { value: "x" },
      key,
    });
    expect(res.status).toBe(400);
  });
});

describe("msrc-rev: read-only GETs are now key-gated too (FEAT configurable-binding re-gating)", () => {
  // The original read boundary let capabilities/audit/sources GETs respond WITHOUT a
  // key (acceptable while strictly loopback). The network-binding relaxation makes
  // those reads LAN-reachable, so they are uniformly key-gated now.
  const READ_PATHS = [
    "/admin/api/capabilities",
    "/admin/api/audit",
    "/admin/api/sources",
    "/admin/api/sources/detect",
  ];

  it("every read GET → 401 WITHOUT the key", async () => {
    const { app } = freshApp();
    for (const path of READ_PATHS) {
      const res = await req(app, path);
      expect(res.status).toBe(401);
    }
  });

  it("every read GET → 200 WITH the key", async () => {
    const { app, key } = freshApp();
    for (const path of READ_PATHS) {
      const res = await req(app, path, { key });
      expect(res.status).toBe(200);
    }
  });

  it("F2: GET /admin/api/connection-key is gone (404 WITH the key) — the key is never an HTTP read", async () => {
    const { app, key } = freshApp();
    const res = await req(app, "/admin/api/connection-key", { key });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(key);
  });
});

describe("msrc-rev: W-1 — a tampered source is bounded by default-deny + kind/egress policy", () => {
  it("an unknown ('cli') kind never registers — even WITH the key (no exec smuggling)", async () => {
    const { app, key } = freshApp();
    const res = await req(app, "/admin/api/sources", {
      method: "POST",
      body: {
        id: "rce",
        kind: "cli",
        label: "rce",
        enabled: true,
        transport: "cli",
        route: { bin: "/bin/sh" },
      } as unknown as ConfiguredSource,
      key,
    });
    // The add is accepted by the route (authed) but the kind adapter rejects it:
    // ok:false, nothing registered, nothing persisted.
    const body = (await res.json()) as { ok: boolean; registered: string[]; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.registered).toEqual([]);
    expect(body.reason ?? "").toContain("unknown source kind");
    // It is NOT live: the capabilities ledger has no cli entry (key-gated read).
    const caps = await req(app, "/admin/api/capabilities", { key });
    const capsBody = (await caps.json()) as { entries: { id: string }[] };
    expect(capsBody.entries.some((e) => e.id.startsWith("rce."))).toBe(false);
  });

  it("adding a source makes it DISCOVERABLE only — no grant is auto-issued", async () => {
    const { app, key, state } = freshApp();
    await req(app, "/admin/api/sources", { method: "POST", body: fsSource(), key });
    // Registered + live, but no grant exists for its capability — invoke still
    // requires a grant (default-deny is untouched by registration).
    expect(state.grants.forAgent("any-agent")).toEqual([]);
  });
});
