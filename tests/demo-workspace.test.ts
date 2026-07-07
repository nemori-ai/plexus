/**
 * POST /admin/api/demo-workspace — the P1b onboarding demo-directory endpoint.
 *
 * Pins:
 *   1. MATERIALIZE + REGISTER: one call creates <root>/plexus-intro (the intro mds)
 *      + <root>/your-secret/secret.md (the obviously-fake secret), and registers the
 *      two managed workspace-dir sources with the RIGHT postures — `demo-intro`
 *      (auto) + `your-secret` (approval:"ask") — live capabilities + persisted config.
 *   2. IDEMPOTENT: a second call overwrites NOTHING (a user-edited file survives
 *      byte-for-byte), re-registers nothing, and NEVER retunes a posture the user
 *      changed (reconfigured ask→auto stays auto).
 *   3. CONTAINMENT: everything lands under the explicit body.path root (tests never
 *      touch the real home); the response reports that root.
 *   4. AUTH: the route is management-key gated like every other /admin/api route.
 *
 * Throwaway PLEXUS_HOME + throwaway roots — no ~/.plexus, no ~/PlexusDemo.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  DEMO_FAKE_SECRET,
  DEMO_INTRO_SOURCE_ID,
  DEMO_SECRET_SOURCE_ID,
  type DemoWorkspaceResult,
} from "@plexus/runtime/core/demo-workspace.ts";

const config = loadConfig();
const HOST = expectedHost(config);

const dirs: string[] = [];
let built: ReturnType<typeof createAppWithState>;
let key = "";
let root = "";

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.PLEXUS_HOME = tempDir("plexus-demo-ws-home-");
  _resetSecretCacheForTests();
  built = createAppWithState(config);
  key = built.state.connectionKey.current();
  root = join(tempDir("plexus-demo-ws-root-"), "PlexusDemo");
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function callEndpoint(body?: unknown, headers?: Record<string, string>) {
  return built.app.request(`http://${HOST}/admin/api/demo-workspace`, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "X-Plexus-Connection-Key": key,
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("demo-workspace: materialize + register (postures correct)", () => {
  it("creates the two folders' files and registers demo-intro (auto) + your-secret (ask)", async () => {
    const res = await callEndpoint({ path: root });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DemoWorkspaceResult;
    expect(body.ok).toBe(true);
    expect(body.root).toBe(root);

    // FILES: the intro mds + the fake secret, all under the EXPLICIT root.
    const introFiles = readdirSync(join(root, "plexus-intro"));
    expect(introFiles.length).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(root, "your-secret", "secret.md"))).toBe(true);
    const secret = readFileSync(join(root, "your-secret", "secret.md"), "utf8");
    expect(secret).toContain(DEMO_FAKE_SECRET);
    expect(secret.toLowerCase()).toContain("fake secret");
    // The intro reads like the docs voice — an agent can introduce Plexus from it.
    const welcome = readFileSync(join(root, "plexus-intro", "welcome.md"), "utf8");
    expect(welcome).toContain("Default deny");
    expect(welcome).toContain("capability");

    // SOURCES: persisted with the right postures.
    const cfgs = built.state.managedSources.list();
    const intro = cfgs.find((s) => s.id === DEMO_INTRO_SOURCE_ID)!;
    const guarded = cfgs.find((s) => s.id === DEMO_SECRET_SOURCE_ID)!;
    expect(intro).toBeDefined();
    expect(guarded).toBeDefined();
    expect(intro.approval ?? "auto").toBe("auto");
    expect(guarded.approval).toBe("ask");
    expect(intro.route?.path).toBe(join(root, "plexus-intro"));
    expect(guarded.route?.path).toBe(join(root, "your-secret"));

    // LIVE capabilities for both instances.
    for (const id of [DEMO_INTRO_SOURCE_ID, DEMO_SECRET_SOURCE_ID]) {
      for (const verb of ["list", "read", "write"]) {
        expect(built.state.capabilities.get(`${id}.${verb}`)).toBeDefined();
      }
    }

    // RESPONSE reports both sources with their capability ids.
    const ids = body.sources.map((s) => s.id).sort();
    expect(ids).toEqual([DEMO_INTRO_SOURCE_ID, DEMO_SECRET_SOURCE_ID].sort());
    const askRow = body.sources.find((s) => s.id === DEMO_SECRET_SOURCE_ID)!;
    expect(askRow.approval).toBe("ask");
    expect(askRow.capabilities).toContain(`${DEMO_SECRET_SOURCE_ID}.read`);
    expect(askRow.alreadyConfigured).toBe(false);
    expect(body.createdFiles.length).toBeGreaterThanOrEqual(4);
  });
});

describe("demo-workspace: idempotency", () => {
  it("a repeat call overwrites nothing, re-registers nothing, and reports alreadyConfigured", async () => {
    expect((await callEndpoint({ path: root })).status).toBe(200);

    // The user edits a demo file — a re-run must NOT clobber it.
    const edited = join(root, "plexus-intro", "welcome.md");
    writeFileSync(edited, "# My own notes now\n", "utf8");
    const revBefore = built.state.capabilities.revision();

    const res2 = await callEndpoint({ path: root });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as DemoWorkspaceResult;
    expect(body2.ok).toBe(true);
    expect(body2.createdFiles).toEqual([]); // nothing (re)written
    expect(readFileSync(edited, "utf8")).toBe("# My own notes now\n");
    expect(body2.sources.every((s) => s.alreadyConfigured)).toBe(true);

    // No re-register: the registry revision did not move, and no duplicate configs.
    expect(built.state.capabilities.revision()).toBe(revBefore);
    const ids = built.state.managedSources.list().map((s) => s.id);
    expect(ids.filter((i) => i === DEMO_INTRO_SOURCE_ID)).toHaveLength(1);
    expect(ids.filter((i) => i === DEMO_SECRET_SOURCE_ID)).toHaveLength(1);
  });

  it("a repeat call never retunes a posture the user changed (ask→auto stays auto)", async () => {
    expect((await callEndpoint({ path: root })).status).toBe(200);

    // The user deliberately relaxes the protected source…
    const rec = await built.state.managedSources.reconfigure(
      DEMO_SECRET_SOURCE_ID,
      { approval: "auto" },
      { approvedByHuman: true },
    );
    expect(rec.ok).toBe(true);

    // …and the idempotent endpoint leaves that decision alone.
    const res = await callEndpoint({ path: root });
    const body = (await res.json()) as DemoWorkspaceResult;
    const row = body.sources.find((s) => s.id === DEMO_SECRET_SOURCE_ID)!;
    expect(row.alreadyConfigured).toBe(true);
    expect(row.approval).toBe("auto");
    expect(
      built.state.managedSources.list().find((s) => s.id === DEMO_SECRET_SOURCE_ID)?.approval,
    ).toBe("auto");
  });

  it("P3: a DISABLED existing demo source is RE-ENABLED (live) and reports real capabilities, not ok:true-but-dead", async () => {
    expect((await callEndpoint({ path: root })).status).toBe(200);

    // The user disables your-secret (config retained, capabilities unregistered).
    await built.state.managedSources.disable(DEMO_SECRET_SOURCE_ID);
    expect(built.state.capabilities.get(`${DEMO_SECRET_SOURCE_ID}.read`)).toBeUndefined();

    // Re-entering onboarding must make it CALLABLE again (else the agent would get
    // unknown_capability and the spinner would never resolve).
    const res = await callEndpoint({ path: root });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DemoWorkspaceResult;
    expect(body.ok).toBe(true);

    // LIVE again — the read capability is registered.
    expect(built.state.capabilities.get(`${DEMO_SECRET_SOURCE_ID}.read`)).toBeDefined();
    expect(
      built.state.managedSources.list().find((s) => s.id === DEMO_SECRET_SOURCE_ID)?.enabled,
    ).toBe(true);

    // The response reports the REAL live capability ids (kind:capability only — no skill,
    // no hardcoded verb list).
    const row = body.sources.find((s) => s.id === DEMO_SECRET_SOURCE_ID)!;
    expect(row.capabilities).toContain(`${DEMO_SECRET_SOURCE_ID}.read`);
    expect(row.capabilities).toContain(`${DEMO_SECRET_SOURCE_ID}.list`);
    expect(row.capabilities).toContain(`${DEMO_SECRET_SOURCE_ID}.write`);
    // The how-to-use SKILL is NOT reported as a capability.
    expect(row.capabilities).not.toContain(`${DEMO_SECRET_SOURCE_ID}.how-to-use`);
  });
});

describe("demo-workspace: auth + containment", () => {
  it("rejects a request without the management key (gated like every admin route)", async () => {
    const res = await built.app.request(`http://${HOST}/admin/api/demo-workspace`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    // Nothing materialized, nothing registered.
    expect(existsSync(root)).toBe(false);
    expect(built.state.managedSources.list()).toHaveLength(0);
  });

  it("everything lands under the explicit body.path (no stray writes elsewhere)", async () => {
    const res = await callEndpoint({ path: root });
    const body = (await res.json()) as DemoWorkspaceResult;
    expect(body.root).toBe(root);
    for (const s of body.sources) {
      expect(s.path.startsWith(root)).toBe(true);
    }
    // Both configured roots point inside the tmp root.
    for (const cfg of built.state.managedSources.list()) {
      expect(String(cfg.route?.path).startsWith(root)).toBe(true);
    }
  });
});
