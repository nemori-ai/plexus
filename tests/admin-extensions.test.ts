/**
 * FEAT-CREATE-EXTENSION — the management surface over runtime registration.
 *
 * Asserts the admin API contract:
 *   1. POST /admin/api/extensions/preview returns the PINNED surface contract for a
 *      valid manifest, and { valid:false, reasons[] } for an invalid one — NO commit.
 *   2. POST /admin/api/extensions registers an extension LIVE (discoverable in the
 *      registry), audits source.install (outcome committed), and a BAD manifest →
 *      { ok:false } with NO commit (nothing registered).
 *   3. GET /admin/api/extensions lists extension-provenance sources.
 *   4. DELETE /admin/api/extensions/:source unregisters it.
 *   5. The mutating routes are connection-key gated (401 without the key).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import type { ExtensionManifest } from "@plexus/protocol";

const config = loadConfig();
const HOST = expectedHost(config);
const dirs: string[] = [];
let activeKey = "";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-ext-admin-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const built = createAppWithState(config);
  activeKey = built.state.connectionKey.current();
  return { ...built, dir };
}

/** The AUTHENTICATED management surface (sends the verified connection-key). */
function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "X-Plexus-Connection-Key": activeKey, ...(init?.headers ?? {}) },
  });
}

/** A loopback local-rest WRITE extension (transport-backed) — the worked example. */
function vaultManifest(): ExtensionManifest {
  return {
    manifest: "plexus-extension/0.1",
    source: "my-vault",
    label: "My local vault",
    transport: "local-rest",
    secrets: [{ name: "my-vault-key", attach: "bearer" }],
    capabilities: [
      {
        name: "notes.write",
        kind: "capability",
        label: "Write a note",
        describe: "Create or overwrite the note at {path} with {content}.",
        io: {
          input: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        grants: ["write"],
        transport: "local-rest",
        route: {
          baseUrl: "http://127.0.0.1:27123",
          allowedHosts: ["127.0.0.1:27123"],
          method: "PUT",
          path: "/vault/{path}",
          secret: { name: "my-vault-key", attach: "bearer" },
        },
      },
      {
        name: "notes.howto",
        kind: "skill",
        label: "How to use my-vault",
        describe: "Usage guidance for my-vault.notes.write.",
        grants: [],
        transport: "skill",
        body: { format: "markdown", markdown: "# my-vault\nWrite with notes.write { path, content }." },
      },
    ],
  };
}

/** Read every audit JSONL line under <PLEXUS_HOME>/audit. */
function readAudit(dir: string): Array<{ type: string; detail?: Record<string, unknown> }> {
  const auditDir = join(dir, "audit");
  if (!existsSync(auditDir)) return [];
  const events: Array<{ type: string; detail?: Record<string, unknown> }> = [];
  for (const file of readdirSync(auditDir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(auditDir, file), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        /* skip torn line */
      }
    }
  }
  return events;
}

afterAll(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("POST /admin/api/extensions/preview", () => {
  beforeEach(() => {
    /* fresh app per test below (freshApp called in each it) */
  });

  it("returns the pinned surface contract for a VALID manifest (no commit)", async () => {
    const { app, state } = freshApp();
    const before = state.capabilities.revision();
    const res = await req(app, "/admin/api/extensions/preview", {
      method: "POST",
      body: JSON.stringify({ manifest: vaultManifest() }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      valid: boolean;
      reasons: string[];
      surface: {
        source: string;
        label: string;
        capabilities: { id: string; label: string; kind: string; transport: string; verbs: string[] }[];
        cliBins: string[];
        restHosts: string[];
        crossSource: { id: string; sources: string[] }[];
        transportBacked: boolean;
      } | null;
    };

    expect(json.ok).toBe(true);
    expect(json.valid).toBe(true);
    expect(json.reasons).toEqual([]);
    expect(json.surface).not.toBeNull();
    expect(json.surface!.source).toBe("my-vault");
    expect(json.surface!.label).toBe("My local vault");
    expect(json.surface!.transportBacked).toBe(true);
    // local-rest write → its host shows on the approval surface.
    expect(json.surface!.restHosts).toContain("127.0.0.1:27123");
    const writeCap = json.surface!.capabilities.find((c) => c.id === "my-vault.notes.write");
    expect(writeCap).toBeDefined();
    expect(writeCap!.kind).toBe("capability");
    expect(writeCap!.transport).toBe("local-rest");
    expect(writeCap!.verbs).toContain("write");
    // The exact pinned keys exist (UI agent depends on these).
    for (const key of ["source", "label", "capabilities", "cliBins", "restHosts", "crossSource", "transportBacked"]) {
      expect(Object.prototype.hasOwnProperty.call(json.surface, key)).toBe(true);
    }

    // PREVIEW MUST NOT COMMIT — the registry revision is unchanged.
    expect(state.capabilities.revision()).toBe(before);
    expect(state.capabilities.getEntry("my-vault.notes.write")).toBeUndefined();
  });

  it("returns valid:false + reasons for an INVALID manifest (no commit)", async () => {
    const { app, state } = freshApp();
    const before = state.capabilities.revision();
    const bad = { manifest: "plexus-extension/0.1", source: "", label: "x", transport: "cli", capabilities: [] };
    const res = await req(app, "/admin/api/extensions/preview", {
      method: "POST",
      body: JSON.stringify({ manifest: bad }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; valid: boolean; reasons: string[] };
    expect(json.ok).toBe(true);
    expect(json.valid).toBe(false);
    expect(json.reasons.length).toBeGreaterThan(0);
    expect(state.capabilities.revision()).toBe(before);
  });
});

describe("POST /admin/api/extensions (admin create)", () => {
  it("registers LIVE + audits source.install committed", async () => {
    const { app, state, dir } = freshApp();
    const before = state.capabilities.revision();
    const res = await req(app, "/admin/api/extensions", {
      method: "POST",
      body: JSON.stringify({ manifest: vaultManifest() }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      source: string;
      registered: string[];
      revision: number;
      reason?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.source).toBe("my-vault");
    expect(json.registered).toContain("my-vault.notes.write");
    expect(json.registered).toContain("my-vault.notes.howto");
    expect(json.revision).toBeGreaterThan(before);

    // Discoverable in the live registry.
    expect(state.capabilities.getEntry("my-vault.notes.write")).toBeDefined();

    // Audited source.install with outcome committed + approvedByHuman.
    const installs = readAudit(dir).filter(
      (e) => e.type === "source.install" && e.detail?.source === "my-vault",
    );
    const committed = installs.find((e) => e.detail?.outcome === "committed");
    expect(committed).toBeDefined();
    expect(committed!.detail?.approvedByHuman).toBe(true);
  });

  it("rejects a BAD manifest with ok:false and NO commit", async () => {
    const { app, state } = freshApp();
    const before = state.capabilities.revision();
    const bad = { manifest: "plexus-extension/0.1", source: "", label: "x", transport: "cli", capabilities: [] };
    const res = await req(app, "/admin/api/extensions", {
      method: "POST",
      body: JSON.stringify({ manifest: bad }),
    });
    const json = (await res.json()) as { ok: boolean; registered: string[]; reason?: string };
    expect(json.ok).toBe(false);
    expect(json.registered).toEqual([]);
    expect(json.reason).toBeDefined();
    // No commit: revision unchanged.
    expect(state.capabilities.revision()).toBe(before);
  });
});

describe("GET + DELETE /admin/api/extensions", () => {
  it("lists extension-provenance sources, then unregisters one", async () => {
    const { app, state } = freshApp();
    // Install first.
    await req(app, "/admin/api/extensions", {
      method: "POST",
      body: JSON.stringify({ manifest: vaultManifest() }),
    });

    const listRes = await req(app, "/admin/api/extensions");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      extensions: { source: string; capabilities: string[] }[];
      revision: number;
    };
    const row = list.extensions.find((e) => e.source === "my-vault");
    expect(row).toBeDefined();
    expect(row!.capabilities).toContain("my-vault.notes.write");

    // DELETE unregisters.
    const delRes = await req(app, "/admin/api/extensions/my-vault", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const del = (await delRes.json()) as { ok: boolean; source: string; removed: string[] };
    expect(del.ok).toBe(true);
    expect(del.removed.length).toBeGreaterThan(0);
    expect(state.capabilities.getEntry("my-vault.notes.write")).toBeUndefined();

    // The list no longer shows it.
    const list2 = (await (await req(app, "/admin/api/extensions")).json()) as {
      extensions: { source: string }[];
    };
    expect(list2.extensions.find((e) => e.source === "my-vault")).toBeUndefined();
  });
});

describe("auth gating", () => {
  it("rejects the create route without a connection-key (401)", async () => {
    const { app } = freshApp();
    const res = await app.request("http://" + HOST + "/admin/api/extensions", {
      method: "POST",
      headers: { host: HOST },
      body: JSON.stringify({ manifest: vaultManifest() }),
    });
    expect(res.status).toBe(401);
  });

  it("serves the authoring guide (markdown)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/extensions/authoring-guide");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Plexus extension");
    expect(text.toLowerCase()).toContain("manifest");
  });
});
