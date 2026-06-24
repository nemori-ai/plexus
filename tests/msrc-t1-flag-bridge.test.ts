/**
 * msrc Task 1 — launcher flags as PERSISTING shortcuts over ManagedSources (the bridge).
 *
 * Locks in the demotion of `bin/plexus`'s `--vault` / `--obsidian-rest` flags from
 * ephemeral boot-time registrations to thin convenience shortcuts over
 * `state.managedSources.add(...)` (DESIGN §2.1, fork F-1):
 *
 *   1. `--obsidian-rest` PERSISTS a source to ~/.plexus/sources.json AND registers it
 *      LIVE (discover advertises obsidian-rest.vault.{list,read,write}).
 *   2. A SECOND boot with NO flag (same PLEXUS_HOME) STILL has it — boot-load
 *      re-registers the persisted source. No flag re-supply needed.
 *   3. `--ephemeral` registers the source for THIS run but does NOT persist it
 *      (sources.json never gains the entry) — the preserved old "just this run" behavior.
 *
 * Each test runs the REAL launcher subprocess under a throwaway PLEXUS_HOME — never
 * touches the real ~/.plexus. Real loopback port, real HTTP fetch, real on-disk
 * sources.json. No mocks. The Obsidian REST plugin need not be reachable: registering
 * a source only makes its capabilities DISCOVERABLE (grants/invoke would need the live
 * plugin, which we don't exercise here).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WellKnownDocument } from "@plexus/protocol";

const LAUNCHER = fileURLToPath(new URL("../bin/plexus", import.meta.url));
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-msrc-t1-home-"));
  tmpDirs.push(dir);
  return dir;
}

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "plexus-msrc-t1-vault-"));
  tmpDirs.push(root);
  const vaultPath = join(root, "Vault");
  mkdirSync(join(vaultPath, "Notes"), { recursive: true });
  writeFileSync(join(vaultPath, "Notes", "Hello.md"), "# Hello\n");
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

async function waitForUp(url: string, host: string, timeoutMs = 8000): Promise<void> {
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

/** Boot the launcher with the given extra args under `home`/`port`, run `body`, then kill. */
async function withLauncher(
  home: string,
  port: number,
  extraArgs: string[],
  body: (base: string, host: string) => Promise<void>,
): Promise<void> {
  const host = `127.0.0.1:${port}`;
  const base = `http://${host}`;
  const proc = Bun.spawn(["bun", "run", LAUNCHER, ...extraArgs], {
    env: { ...process.env, PLEXUS_HOME: home, PLEXUS_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForUp(`${base}/.well-known/plexus`, host);
    await body(base, host);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function wellKnown(base: string, host: string): Promise<WellKnownDocument> {
  return (await (await fetch(`${base}/.well-known/plexus`, { headers: { host } })).json()) as WellKnownDocument;
}

function sourcesJsonPath(home: string): string {
  return join(home, "sources.json");
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

describe("msrc-t1: --obsidian-rest is a PERSISTING shortcut over managedSources.add", () => {
  it("persists the source to sources.json AND registers it live (discoverable)", async () => {
    const home = freshHome();
    const port = freePort();

    await withLauncher(home, port, ["--obsidian-rest"], async (base, host) => {
      // LIVE: discovery advertises the obsidian-rest capabilities.
      const wk = await wellKnown(base, host);
      const ids = wk.capabilities.map((c) => c.id);
      expect(ids).toContain("obsidian-rest.vault.write");
      expect(ids).toContain("obsidian-rest.vault.read");
      expect(ids).toContain("obsidian-rest.vault.list");
    });

    // PERSISTED: sources.json holds the obsidian-rest source as desired state.
    expect(existsSync(sourcesJsonPath(home))).toBe(true);
    const cfg = JSON.parse(readFileSync(sourcesJsonPath(home), "utf8")) as {
      version: number;
      sources: Array<{ id: string; kind: string; route?: { baseUrl?: string }; secretRef?: string }>;
    };
    const entry = cfg.sources.find((s) => s.id === "obsidian-rest");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("obsidian-rest");
    // Secret stays NAME-only — the value is NEVER embedded in sources.json.
    expect(entry?.secretRef).toBe("obsidian-local-rest-api-key");
    const raw = readFileSync(sourcesJsonPath(home), "utf8");
    expect(raw).not.toContain("Bearer");
    expect(raw).not.toContain("secretValue");
  }, 20000);

  it("a SECOND boot with NO flag still has the source (boot-load re-registers it)", async () => {
    const home = freshHome();

    // First boot: persist via the flag.
    await withLauncher(home, freePort(), ["--obsidian-rest"], async () => {
      /* persisted on this run */
    });
    expect(existsSync(sourcesJsonPath(home))).toBe(true);

    // Second boot: SAME home, NO flag. The persisted source must load + be live.
    await withLauncher(home, freePort(), [], async (base, host) => {
      const wk = await wellKnown(base, host);
      const ids = wk.capabilities.map((c) => c.id);
      expect(ids).toContain("obsidian-rest.vault.write");
    });
  }, 30000);
});

describe("msrc-t1: --ephemeral registers WITHOUT persisting", () => {
  it("the source is live this run but never written to sources.json", async () => {
    const home = freshHome();
    const port = freePort();

    await withLauncher(home, port, ["--obsidian-rest", "--ephemeral"], async (base, host) => {
      // LIVE this run.
      const wk = await wellKnown(base, host);
      expect(wk.capabilities.map((c) => c.id)).toContain("obsidian-rest.vault.write");
    });

    // NOT persisted: either no sources.json, or it has no obsidian-rest entry.
    if (existsSync(sourcesJsonPath(home))) {
      const cfg = JSON.parse(readFileSync(sourcesJsonPath(home), "utf8")) as {
        sources: Array<{ id: string }>;
      };
      expect(cfg.sources.find((s) => s.id === "obsidian-rest")).toBeUndefined();
    }

    // And a fresh boot with no flag has nothing to load.
    await withLauncher(home, freePort(), [], async (base, host) => {
      const wk = await wellKnown(base, host);
      expect(wk.capabilities.map((c) => c.id)).not.toContain("obsidian-rest.vault.write");
    });
  }, 30000);
});

describe("msrc-t1: --vault persists the obsidian-fs source", () => {
  it("a fresh boot with no flag still serves obsidian.vault.read after --vault once", async () => {
    const home = freshHome();
    const vault = makeVault();

    await withLauncher(home, freePort(), ["--vault", vault], async (base, host) => {
      const wk = await wellKnown(base, host);
      expect(wk.capabilities.map((c) => c.id)).toContain("obsidian.vault.read");
    });

    // Persisted as obsidian-fs (vaultPath in route; no secret).
    const cfg = JSON.parse(readFileSync(sourcesJsonPath(home), "utf8")) as {
      sources: Array<{ id: string; kind: string; route?: { vaultPath?: string } }>;
    };
    const entry = cfg.sources.find((s) => s.id === "obsidian");
    expect(entry?.kind).toBe("obsidian-fs");
    expect(entry?.route?.vaultPath).toBe(vault);

    // Second boot, no flag: still live via boot-load.
    await withLauncher(home, freePort(), [], async (base, host) => {
      const wk = await wellKnown(base, host);
      expect(wk.capabilities.map((c) => c.id)).toContain("obsidian.vault.read");
    });
  }, 30000);
});
