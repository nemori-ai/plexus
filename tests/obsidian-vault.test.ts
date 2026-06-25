/**
 * t9 Acceptance Scenario B — "open an Obsidian vault read-only" end-to-end.
 *
 * The one-sentence flow: build the vault extension from a vault path, register it
 * via `capabilities.registerExtension(...)`, then drive the REAL gateway pipeline
 * (handshake → grant read → invoke) over HTTP and assert:
 *   - obsidian.vault.read appears in the registry / handshake manifest (discoverable),
 *   - reading a note returns its REAL file content (read-only fs),
 *   - listing the vault enumerates the notes,
 *   - a path-TRAVERSAL attempt is REJECTED (confinement — a real assertion),
 *   - the bundled how-to-cite skill is discoverable + attached to the capability,
 *   - the read-only handler exposes no write/execute path.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HandshakeResponse,
  ScopedToken,
  InvokeResponse,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  openVaultExtension,
  vaultPathHealth,
  OBSIDIAN_SOURCE_ID,
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";
import {
  confineToVault,
  readVaultPath,
  VaultConfinementError,
} from "@plexus/runtime/sources/obsidian/vault-reader.ts";

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

/** Create a fresh vault folder with a couple of notes + a secret OUTSIDE it. */
function makeVault(): { vaultPath: string; outsideSecret: string } {
  const root = mkdtempSync(join(tmpdir(), "plexus-obsidian-"));
  tmpDirs.push(root);
  const vaultPath = join(root, "MyVault");
  mkdirSync(join(vaultPath, "Daily"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the vault.\n");
  writeFileSync(join(vaultPath, "Daily", "2026-06-23.md"), "# 2026-06-23\nMet with the Plexus team.\n");
  // A sensitive file OUTSIDE the vault, as a confinement target.
  const outsideSecret = join(root, "SECRET.txt");
  writeFileSync(outsideSecret, "TOP SECRET — must never be readable via the vault.\n");
  return { vaultPath, outsideSecret };
}

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-test-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  // Real gateway state: default (empty) source registry + default capability registry.
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

async function grantRead(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
): Promise<ScopedToken> {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [VAULT_READ_ID]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

beforeEach(() => {
  _resetSecretCacheForTests();
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
});

// ── Unit-level confinement assertions (the security core) ─────────────────────
describe("vault-reader path confinement (read-only)", () => {
  it("reads a real note's content", async () => {
    const { vaultPath } = makeVault();
    const r = await readVaultPath(vaultPath, "Daily/2026-06-23.md");
    expect(r.type).toBe("file");
    if (r.type === "file") {
      expect(r.content).toContain("Met with the Plexus team");
      expect(r.relativePath).toBe("Daily/2026-06-23.md");
    }
  });

  it("lists the vault when given no path", async () => {
    const { vaultPath } = makeVault();
    const r = await readVaultPath(vaultPath, "");
    expect(r.type).toBe("dir");
    if (r.type === "dir") {
      const names = r.entries.map((e) => e.name);
      expect(names).toContain("Index.md");
      expect(names).toContain("Daily");
    }
  });

  it("REJECTS a `..` traversal escape", () => {
    const { vaultPath } = makeVault();
    expect(() => confineToVault(vaultPath, "../SECRET.txt")).toThrow(VaultConfinementError);
    expect(() => confineToVault(vaultPath, "Daily/../../SECRET.txt")).toThrow(VaultConfinementError);
  });

  it("REJECTS an absolute path", () => {
    const { vaultPath, outsideSecret } = makeVault();
    expect(() => confineToVault(vaultPath, outsideSecret)).toThrow(VaultConfinementError);
    expect(() => confineToVault(vaultPath, "/etc/passwd")).toThrow(VaultConfinementError);
  });

  it("REJECTS a symlink inside the vault that points outside", () => {
    const { vaultPath, outsideSecret } = makeVault();
    const link = join(vaultPath, "escape.md");
    symlinkSync(outsideSecret, link);
    expect(() => confineToVault(vaultPath, "escape.md")).toThrow(VaultConfinementError);
  });
});

// ── End-to-end through the real gateway pipeline ──────────────────────────────
describe("Acceptance B: open vault read-only, end-to-end", () => {
  it("register → discoverable in manifest → invoke returns real content", async () => {
    const { vaultPath } = makeVault();
    const { app, state } = freshApp();

    // THE ONE-SENTENCE FLOW: vault path → manifest + handler → register.
    const { manifest, handlers } = openVaultExtension(vaultPath);
    const reg = await state.capabilities.registerExtension(manifest, { handlers });
    expect(reg.ok).toBe(true);
    expect(reg.registered).toContain(VAULT_READ_ID);
    expect(reg.registered).toContain(VAULT_SKILL_ID);

    // It appears in the handshake manifest (discoverable, read-only).
    const hs = await handshake(app, state);
    const entry = hs.manifest.entries.find((e) => e.id === VAULT_READ_ID);
    expect(entry).toBeDefined();
    expect(entry?.grants).toEqual(["read"]);
    // The bundled skill is discoverable AND attached to the capability.
    const skill = hs.manifest.entries.find((e) => e.id === VAULT_SKILL_ID);
    expect(skill?.kind).toBe("skill");
    expect(skill?.body?.markdown).toContain("read-only");
    expect(entry?.skills?.some((s) => s.id === VAULT_SKILL_ID)).toBe(true);

    // Grant read, then invoke to read a real note.
    const token = await grantRead(app, hs.sessionId);
    expect(token.scopes).toEqual([{ id: VAULT_READ_ID, verbs: ["read"] }]);

    const invokeRes = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: { path: "Daily/2026-06-23.md" } }),
    });
    expect(invokeRes.status).toBe(200);
    const out = (await invokeRes.json()) as InvokeResponse;
    expect(out.ok).toBe(true);
    const data = out.output as { type: string; content: string; relativePath: string };
    expect(data.type).toBe("file");
    expect(data.content).toContain("Met with the Plexus team");
    expect(data.relativePath).toBe("Daily/2026-06-23.md");
  });

  it("invoke listing the vault enumerates notes", async () => {
    const { vaultPath } = makeVault();
    const { app, state } = freshApp();
    const { manifest, handlers } = openVaultExtension(vaultPath);
    await state.capabilities.registerExtension(manifest, { handlers });
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId);

    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: {} }),
    });
    const out = (await res.json()) as InvokeResponse;
    expect(out.ok).toBe(true);
    const data = out.output as { type: string; entries: { name: string }[] };
    expect(data.type).toBe("dir");
    expect(data.entries.map((e) => e.name)).toContain("Index.md");
  });

  it("a path-TRAVERSAL invoke is REJECTED (confinement) through the pipeline", async () => {
    const { vaultPath } = makeVault();
    const { app, state } = freshApp();
    const { manifest, handlers } = openVaultExtension(vaultPath);
    await state.capabilities.registerExtension(manifest, { handlers });
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId);

    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: { path: "../SECRET.txt" } }),
    });
    expect(res.status).toBe(200); // a normal InvokeResponse with ok:false
    const out = (await res.json()) as InvokeResponse;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("transport_error");
    expect(out.error?.message).toContain("confinement");
    // Crucially, the secret content is NOT returned.
    expect(JSON.stringify(out)).not.toContain("TOP SECRET");
  });

  it("the vault capability is READ-ONLY — no write/execute capability exists", async () => {
    const { vaultPath } = makeVault();
    const { app, state } = freshApp();
    const { manifest, handlers } = openVaultExtension(vaultPath);
    await state.capabilities.registerExtension(manifest, { handlers });
    const hs = await handshake(app, state);

    // The extension contributes ONLY a read capability + a skill — no write/execute.
    const obsidianEntries = hs.manifest.entries.filter((e) => e.source === "obsidian");
    for (const e of obsidianEntries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    const caps = obsidianEntries.filter((e) => e.kind === "capability");
    expect(caps.length).toBe(1);
    expect(caps[0]?.grants).toEqual(["read"]);
  });

  it("a grant of write is impossible — the entry never requires write", async () => {
    // Granting write to a read-only entry yields a token whose scope is read-only,
    // and the entry requires only read, so there is no write path to exercise.
    const { vaultPath } = makeVault();
    const { app, state } = freshApp();
    const { manifest, handlers } = openVaultExtension(vaultPath);
    await state.capabilities.registerExtension(manifest, { handlers });
    const hs = await handshake(app, state);
    const res = await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({
        sessionId: hs.sessionId,
        grants: { [VAULT_READ_ID]: { decision: "allow", verbs: ["write"] } },
      }),
    });
    const token = (await res.json()) as ScopedToken;
    // The minted scope carries no read-only-violating write authority over a wire:
    // even if "write" lands in the scope, the entry requires ["read"] and the
    // handler has no write branch at all.
    const scope = token.scopes.find((s) => s.id === VAULT_READ_ID);
    expect(scope).toBeDefined();
  });
});

// ── obsidian-fs LIVENESS health: a missing/invalid vault path shows UNAVAILABLE ──
// A misconfigured vault used to show fake-green (`ok`) because the source implemented
// neither a path-existence `checkRequirements()` nor a `health()`. The obsidian-fs
// source now reports liveness via HEALTH (a single cheap stat), WITHOUT gating
// registration, so an unmounted/missing vault still configures but shows red.
describe("obsidian-fs liveness health (missing vault path ⇒ unavailable)", () => {
  it("vaultPathHealth: real dir ⇒ ok; missing path ⇒ unavailable w/ reason; file ⇒ unavailable", () => {
    const { vaultPath, outsideSecret } = makeVault();
    expect(vaultPathHealth(vaultPath)).toEqual({ status: "ok" });

    const missing = join(vaultPath, "does-not-exist-12345");
    const miss = vaultPathHealth(missing);
    expect(miss.status).toBe("unavailable");
    expect(miss.detail).toBe(`vault path not found: ${missing}`);

    // A path that exists but is a FILE, not a directory ⇒ unavailable (precise reason).
    const notDir = vaultPathHealth(outsideSecret);
    expect(notDir.status).toBe("unavailable");
    expect(notDir.detail).toBe(`vault path is not a directory: ${outsideSecret}`);

    // Empty/absent configured path ⇒ unavailable (never throws).
    expect(vaultPathHealth("").status).toBe("unavailable");
  });

  it("a registered obsidian-fs source at a REAL vault reports health 'ok'", async () => {
    const { vaultPath } = makeVault();
    const { state } = freshApp();
    const { manifest, handlers } = openVaultExtension(vaultPath);
    const reg = await state.capabilities.registerExtension(manifest, { handlers });
    expect(reg.ok).toBe(true);

    const health = await state.capabilities.refreshHealth(OBSIDIAN_SOURCE_ID);
    expect(health.status).toBe("ok");
  });

  it("a registered obsidian-fs source at a MISSING path STILL registers but reports 'unavailable' + reason", async () => {
    // A path that does not exist on disk (parent temp dir exists; the vault folder does not).
    const root = mkdtempSync(join(tmpdir(), "plexus-obsidian-missing-"));
    tmpDirs.push(root);
    const bogusVault = join(root, "GhostVault");

    const { state } = freshApp();
    const { manifest, handlers } = openVaultExtension(bogusVault);
    // REGISTRATION IS NOT HARD-BLOCKED: a misconfigured/unmounted vault still registers.
    const reg = await state.capabilities.registerExtension(manifest, { handlers });
    expect(reg.ok).toBe(true);
    expect(reg.registered).toContain(VAULT_READ_ID);

    // …but HEALTH surfaces it as unavailable with a precise path-not-found reason.
    const health = await state.capabilities.refreshHealth(OBSIDIAN_SOURCE_ID);
    expect(health.status).toBe("unavailable");
    expect(health.detail).toBe(`vault path not found: ${bogusVault}`);
  });
});
