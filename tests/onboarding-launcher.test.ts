/**
 * Onboarding — `bin/plexus` launcher behavior (the human start path).
 *
 * These tests lock in the launcher contract a first-time macOS user depends on:
 *   - `--print-key` prints the connection-key persisted under ~/.plexus/ and exits
 *     (no server), and matches the key the gateway state surfaces.
 *   - `--help` prints usage and exits 0.
 *   - Booting with `--vault <realdir>` opens the REAL obsidian.vault.read source
 *     read-only, serves the `/admin` management UI (200 HTML), answers
 *     `.well-known`, and an agent can handshake → grant → invoke a REAL note.
 *
 * The launcher subprocess runs with a sandboxed PLEXUS_HOME (a temp dir) so the
 * test never reads or mutates the real ~/.plexus. It uses a real on-disk vault
 * (a temp folder of .md notes), a real loopback port, and real HTTP fetch — no
 * mocks, no in-memory hand-waving.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

import type {
  WellKnownDocument,
  HandshakeResponse,
  ScopedToken,
  InvokeResponse,
} from "../src/protocol/index.ts";

const LAUNCHER = fileURLToPath(new URL("../bin/plexus", import.meta.url));
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-onb-home-"));
  tmpDirs.push(dir);
  return dir;
}

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "plexus-onb-vault-"));
  tmpDirs.push(root);
  const vaultPath = join(root, "OnboardVault");
  mkdirSync(join(vaultPath, "Notes"), { recursive: true });
  writeFileSync(join(vaultPath, "Notes", "Hello.md"), "# Hello\nReal note from a real fs vault.\n");
  return vaultPath;
}

/** Pick a free TCP port by briefly binding :0. */
function freePort(): number {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

async function waitForUp(url: string, host: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { host } });
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`gateway never came up at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("onboarding: bin/plexus launcher", () => {
  it("--print-key prints the persisted connection-key and exits (no server)", async () => {
    const home = freshHome();
    const proc = Bun.spawn(["bun", "run", LAUNCHER, "--print-key"], {
      env: { ...process.env, PLEXUS_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toMatch(/^plx_live_[0-9a-f]+$/);
    // It is the SAME key now persisted under the sandboxed home.
    const persisted = readFileSync(join(home, "connection-key"), "utf8").trim();
    expect(out).toBe(persisted);
  });

  it("--help prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", LAUNCHER, "--help"], {
      env: { ...process.env, PLEXUS_HOME: freshHome() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("Plexus");
    expect(out).toContain("--vault");
  });

  it("boots with --vault, serves /admin + .well-known, agent reads a REAL note", async () => {
    const home = freshHome();
    const vault = makeVault();
    const port = freePort();
    const host = `127.0.0.1:${port}`;
    const base = `http://${host}`;

    const proc = Bun.spawn(["bun", "run", LAUNCHER, "--vault", vault], {
      env: { ...process.env, PLEXUS_HOME: home, PLEXUS_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitForUp(`${base}/.well-known/plexus`, host);

      // /admin serves the management UI (200 HTML).
      const admin = await fetch(`${base}/admin`, { headers: { host } });
      expect(admin.status).toBe(200);
      expect(admin.headers.get("content-type") ?? "").toContain("text/html");
      const adminHtml = await admin.text();
      expect(adminHtml.toLowerCase()).toContain("<!doctype html");

      // .well-known advertises the read-only vault capability.
      const wk = (await (await fetch(`${base}/.well-known/plexus`, { headers: { host } })).json()) as WellKnownDocument;
      const vaultSummary = wk.capabilities.find((c) => c.id === "obsidian.vault.read");
      expect(vaultSummary).toBeDefined();
      expect(vaultSummary?.grants).toEqual(["read"]);

      // The connection-key the agent needs is the persisted one.
      const key = readFileSync(join(home, "connection-key"), "utf8").trim();

      // handshake → grant read → invoke → REAL note content.
      const hsRes = await fetch(`${base}/link/handshake`, {
        method: "POST",
        headers: { host, "content-type": "application/json" },
        body: JSON.stringify({ connectionKey: key, client: { name: "onb-test", agentId: "agent-onb" } }),
      });
      const hs = (await hsRes.json()) as HandshakeResponse;
      expect(hs.sessionId).toBeTruthy();

      const grantRes = await fetch(`${base}/grants`, {
        method: "PUT",
        headers: { host, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: hs.sessionId, grants: { "obsidian.vault.read": "allow" } }),
      });
      const token = (await grantRes.json()) as ScopedToken;
      expect(token.scopes).toEqual([{ id: "obsidian.vault.read", verbs: ["read"] }]);

      const invokeRes = await fetch(`${base}/invoke`, {
        method: "POST",
        headers: { host, "content-type": "application/json", authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ id: "obsidian.vault.read", input: { path: "Notes/Hello.md" } }),
      });
      const out = (await invokeRes.json()) as InvokeResponse;
      expect(out.ok).toBe(true);
      const data = out.output as { type: string; content: string; relativePath: string };
      expect(data.content).toContain("Real note from a real fs vault");
      expect(data.relativePath).toBe("Notes/Hello.md");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20000);
});
