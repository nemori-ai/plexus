/**
 * SOURCE SETTINGS — the owner's machine-level `realLaunch` knob for the exec-class
 * first-party sources (codex / claudecode), console-manageable.
 *
 *   1. STORE — default empty; write/merge/clear round-trips; corrupt file fail-safe.
 *   2. PRECEDENCE — the persisted setting WINS over the env flag; env is the fallback;
 *      absent both ⇒ OFF (nothing spends money by default).
 *   3. LAUNCHER — codex's `headlessLaunchEnabled()` follows the persisted toggle LIVE.
 *   4. ADMIN API — GET reports the trio with provenance (persisted vs env); PUT
 *      toggles + clears + is AUDITED (`source.settings`); unknown source → 404;
 *      no key → 401 (the blanket management gate).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import {
  allSourceSettings,
  authorizedDirFor,
  realLaunchEnabled,
  sourceSettings,
  writeSourceSettings,
  SOURCE_SETTINGS_FILE,
} from "@plexus/runtime/sources/config/settings.ts";
import { headlessLaunchEnabled as codexHeadless } from "@plexus/runtime/sources/codex/launcher.ts";

const baseConfig = loadConfig();
const LOOPBACK_HOST = expectedHost(baseConfig);
const dirs: string[] = [];
const ENV = "PLEXUS_CODEX_HEADLESS_LAUNCH";
// Capture the ambient values ONCE so afterAll RESTORES them (bun runs every test file in
// one process — deleting a runner-level PLEXUS_HOME sandbox would corrupt later files).
const PRIOR_HOME = process.env.PLEXUS_HOME;
const PRIOR_ENV = process.env[ENV];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-srcset-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  return dir;
}

beforeEach(() => {
  delete process.env[ENV];
});

afterAll(() => {
  if (PRIOR_HOME === undefined) delete process.env.PLEXUS_HOME;
  else process.env.PLEXUS_HOME = PRIOR_HOME;
  if (PRIOR_ENV === undefined) delete process.env[ENV];
  else process.env[ENV] = PRIOR_ENV;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("srcset 1: the persisted store", () => {
  it("defaults empty; write/merge/clear round-trips", () => {
    freshHome();
    expect(sourceSettings("codex")).toEqual({});
    expect(allSourceSettings()).toEqual({});
    writeSourceSettings("codex", { realLaunch: true });
    expect(sourceSettings("codex")).toEqual({ realLaunch: true });
    // Clearing (undefined) removes the key AND the now-empty record.
    writeSourceSettings("codex", { realLaunch: undefined });
    expect(sourceSettings("codex")).toEqual({});
    expect(allSourceSettings()).toEqual({});
  });

  it("a corrupt file fails SAFE (everything defaults off)", () => {
    const dir = freshHome();
    writeFileSync(join(dir, SOURCE_SETTINGS_FILE), "{not json");
    expect(sourceSettings("codex")).toEqual({});
    expect(realLaunchEnabled("codex", ENV)).toBe(false);
  });
});

describe("srcset 2: precedence — setting wins, env falls back, default OFF", () => {
  it("absent both ⇒ OFF; env=1 ⇒ ON; persisted false OVERRIDES env=1; persisted true works alone", () => {
    freshHome();
    expect(realLaunchEnabled("codex", ENV)).toBe(false);
    process.env[ENV] = "1";
    expect(realLaunchEnabled("codex", ENV)).toBe(true);
    writeSourceSettings("codex", { realLaunch: false }); // console says NO — env can't win
    expect(realLaunchEnabled("codex", ENV)).toBe(false);
    delete process.env[ENV];
    writeSourceSettings("codex", { realLaunch: true });
    expect(realLaunchEnabled("codex", ENV)).toBe(true);
  });

  it("the codex launcher's gate follows the persisted toggle live", () => {
    freshHome();
    expect(codexHeadless()).toBe(false);
    writeSourceSettings("codex", { realLaunch: true });
    expect(codexHeadless()).toBe(true);
    writeSourceSettings("codex", { realLaunch: false });
    expect(codexHeadless()).toBe(false);
  });
});

describe("srcset 2b: authorizedDir precedence — persisted > env > default (+ null-clear)", () => {
  it("falls to default, then env, then persisted; clearing/empty reverts to env/default", () => {
    freshHome();
    // Absent both ⇒ the per-source default.
    expect(authorizedDirFor("codex", undefined, "/def")).toBe("/def");
    // Env override wins over the default.
    expect(authorizedDirFor("codex", "/env", "/def")).toBe("/env");
    // A persisted non-empty string OVERRIDES the env override.
    writeSourceSettings("codex", { authorizedDir: "/persisted" });
    expect(authorizedDirFor("codex", "/env", "/def")).toBe("/persisted");
    // NULL-CLEAR (undefined patch deletes the key) ⇒ back to env, then default.
    writeSourceSettings("codex", { authorizedDir: undefined });
    expect(sourceSettings("codex").authorizedDir).toBeUndefined();
    expect(authorizedDirFor("codex", "/env", "/def")).toBe("/env");
    expect(authorizedDirFor("codex", undefined, "/def")).toBe("/def");
    // A persisted EMPTY string is treated as unset (falls back) — never a "" jail.
    writeSourceSettings("codex", { authorizedDir: "" });
    expect(authorizedDirFor("codex", "/env", "/def")).toBe("/env");
    // realLaunch + authorizedDir coexist (additive merge).
    writeSourceSettings("codex", { realLaunch: true, authorizedDir: "/jail" });
    expect(sourceSettings("codex")).toEqual({ realLaunch: true, authorizedDir: "/jail" });
  });
});

describe("srcset 3: the admin API (key-gated, audited)", () => {
  function freshApp() {
    freshHome();
    const built = createAppWithState(baseConfig);
    return { ...built, key: built.state.connectionKey.current() };
  }
  function req(
    app: ReturnType<typeof createAppWithState>["app"],
    path: string,
    opts: { method?: string; body?: unknown; key?: string } = {},
  ) {
    const headers: Record<string, string> = { host: LOOPBACK_HOST };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.key) headers["X-Plexus-Connection-Key"] = opts.key;
    return app.request(`http://${LOOPBACK_HOST}${path}`, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  it("GET reports the exec trio with provenance; PUT toggles, clears, and audits", async () => {
    const { app, key, state } = freshApp();
    const list = (await (await req(app, "/admin/api/source-settings", { key })).json()) as {
      sources: { sourceId: string; realLaunch: boolean; persisted: boolean | null; envActive: boolean }[];
    };
    expect(list.sources.map((s) => s.sourceId).sort()).toEqual(["claudecode", "codex"]);
    for (const s of list.sources) {
      expect(s.realLaunch).toBe(false);
      expect(s.persisted).toBeNull();
    }

    // Toggle codex ON.
    const on = (await (
      await req(app, "/admin/api/source-settings/codex", { method: "PUT", key, body: { realLaunch: true } })
    ).json()) as { ok: boolean; realLaunch: boolean; persisted: boolean | null };
    expect(on).toMatchObject({ ok: true, realLaunch: true, persisted: true });
    expect(realLaunchEnabled("codex", ENV)).toBe(true);

    // Clear back to default (null) — falls back to env/default (off here).
    const cleared = (await (
      await req(app, "/admin/api/source-settings/codex", { method: "PUT", key, body: { realLaunch: null } })
    ).json()) as { realLaunch: boolean; persisted: boolean | null };
    expect(cleared).toMatchObject({ realLaunch: false, persisted: null });

    // Both writes were audited as trust-relevant acts.
    const audit = (await (
      await req(app, "/admin/api/audit?limit=50", { key })
    ).json()) as { events: { type: string; detail?: { sourceId?: string } }[] };
    const settingEvents = audit.events.filter((e) => e.type === "source.settings");
    expect(settingEvents.length).toBe(2);
    expect(settingEvents.every((e) => e.detail?.sourceId === "codex")).toBe(true);
  });

  it("GET returns the authorizedDir trio; PUT persists an absolute path + rejects a relative one", async () => {
    const { app, key } = freshApp();
    // GET reports the effective dir + provenance for BOTH exec sources.
    const list = (await (await req(app, "/admin/api/source-settings", { key })).json()) as {
      sources: {
        sourceId: string;
        authorizedDir: string;
        authorizedDirPersisted: string | null;
        authorizedDirDefault: string;
      }[];
    };
    for (const s of list.sources) {
      // Default until overridden — persisted null, effective == default.
      expect(s.authorizedDirPersisted).toBeNull();
      expect(s.authorizedDir).toBe(s.authorizedDirDefault);
      expect(s.authorizedDirDefault.endsWith(`/.plexus/workspace/${s.sourceId}`)).toBe(true);
    }

    // PUT an absolute path persists + becomes the effective dir.
    const abs = "/tmp/plexus-jail-test-abs";
    const put = (await (
      await req(app, "/admin/api/source-settings/codex", {
        method: "PUT",
        key,
        body: { authorizedDir: abs },
      })
    ).json()) as { ok: boolean; authorizedDir: string; authorizedDirPersisted: string | null };
    expect(put).toMatchObject({ ok: true, authorizedDir: abs, authorizedDirPersisted: abs });
    expect(authorizedDirFor("codex", undefined, "/def")).toBe(abs);

    // GET now reflects the override.
    const after = (await (await req(app, "/admin/api/source-settings", { key })).json()) as {
      sources: { sourceId: string; authorizedDir: string; authorizedDirPersisted: string | null }[];
    };
    const codexRow = after.sources.find((s) => s.sourceId === "codex")!;
    expect(codexRow.authorizedDirPersisted).toBe(abs);
    expect(codexRow.authorizedDir).toBe(abs);

    // A RELATIVE path is rejected with 400 (the jail root must be unambiguous).
    expect(
      (
        await req(app, "/admin/api/source-settings/codex", {
          method: "PUT",
          key,
          body: { authorizedDir: "relative/jail" },
        })
      ).status,
    ).toBe(400);

    // NULL clears back to default.
    const cleared = (await (
      await req(app, "/admin/api/source-settings/codex", {
        method: "PUT",
        key,
        body: { authorizedDir: null },
      })
    ).json()) as { authorizedDir: string; authorizedDirPersisted: string | null; authorizedDirDefault: string };
    expect(cleared.authorizedDirPersisted).toBeNull();
    expect(cleared.authorizedDir).toBe(cleared.authorizedDirDefault);
  });

  it("unknown source → 404; bad body → 400; no key → 401", async () => {
    const { app, key } = freshApp();
    expect(
      (await req(app, "/admin/api/source-settings/notasource", { method: "PUT", key, body: { realLaunch: true } })).status,
    ).toBe(404);
    expect(
      (await req(app, "/admin/api/source-settings/codex", { method: "PUT", key, body: { realLaunch: "yes" } })).status,
    ).toBe(400);
    expect((await req(app, "/admin/api/source-settings", {})).status).toBe(401);
    expect(
      (await req(app, "/admin/api/source-settings/codex", { method: "PUT", body: { realLaunch: true } })).status,
    ).toBe(401);
  });
});
