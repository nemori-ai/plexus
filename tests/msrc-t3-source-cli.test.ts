/**
 * msrc Task 3 — the `plexus source …` admin CLI, driven END-TO-END against a REAL
 * booted gateway exactly as a user would from the terminal.
 *
 * It boots a real Plexus gateway on a free loopback port with a throwaway
 * PLEXUS_HOME (never the real ~/.plexus), then RUNS THE ACTUAL CLI BINARY as a
 * subprocess (`bun integrations/cli/bin/plexus source …`) over Task 2's admin API
 * and asserts:
 *
 *   - `source detect`     finds a reachable source (a mock REST listener on the
 *                         Obsidian default port → `locateLocalService` hit).
 *   - `source add obsidian-rest --base-url http://127.0.0.1:<mockport>
 *      --secret-name k --api-key-stdin` reads the KEY from STDIN (NEVER argv),
 *      stores the secret write-only, then the source goes LIVE.
 *   - `source list`       shows it enabled + live + capabilityCount > 0, AND
 *                         `discover` (the protocol scan) shows its capability.
 *   - the API key NEVER appears on the child's argv (no shell-history leak).
 *   - `source disable` / `enable` / `remove` flip live/enabled state.
 *
 * No mock of the admin API — every command is a real HTTP round-trip the booted
 * gateway answers. The only mock is a throwaway TCP/HTTP listener standing in for
 * the Obsidian Local REST API (so detect/registration have something reachable).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { REST_VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault-rest.ts";

const CLI_BIN = join(import.meta.dir, "..", "packages", "cli", "src", "bin", "plexus");

/** Obsidian Local REST default port `locateLocalService` probes (darwin.ts). */
const OBSIDIAN_DEFAULT_PORT = 27124;

/** Pick a concrete free TCP port (we serve the gateway on exactly it). */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

interface Booted {
  baseUrl: string;
  home: string;
  mockPort: number;
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;
/** A raw TCP listener on the Obsidian default port so `detect` finds a source. */
let detectListener: net.Server | null = null;
/** A mock HTTP listener standing in for the configured obsidian-rest baseUrl. */
let mockRest: ReturnType<typeof Bun.serve> | null = null;

/** Try to bind the Obsidian default port so detect has a reachable service. If it
 * is already in use (e.g. real Obsidian is running), detect will still find one. */
async function ensureDetectListener(): Promise<void> {
  await new Promise<void>((resolve) => {
    const srv = net.createServer((sock) => sock.end());
    srv.once("error", () => {
      // Port already in use → something is already reachable there; detect still hits.
      detectListener = null;
      resolve();
    });
    srv.listen(OBSIDIAN_DEFAULT_PORT, "127.0.0.1", () => {
      detectListener = srv;
      resolve();
    });
  });
}

async function bootGateway(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "plexus-msrc-t3-home-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app } = createAppWithState(config);
  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });

  // A mock REST endpoint the added source's baseUrl points at (loopback http).
  const mockPort = await pickFreePort();
  mockRest = Bun.serve({
    hostname: "127.0.0.1",
    port: mockPort,
    fetch: () => new Response(JSON.stringify({ files: [] }), { headers: { "content-type": "application/json" } }),
  });

  await ensureDetectListener();

  return {
    baseUrl: configBaseUrl(config),
    home,
    mockPort,
    cleanup: () => {
      try { server.stop(true); } catch { /* ignore */ }
      try { mockRest?.stop(true); } catch { /* ignore */ }
      try { detectListener?.close(); } catch { /* ignore */ }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Run the CLI binary as a subprocess. `stdin` (if given) is piped to its STDIN. */
async function runCli(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string; argv: string[] }> {
  const argv = ["bun", CLI_BIN, ...args, "--url", booted.baseUrl];
  const proc = Bun.spawn(argv, {
    env: { ...process.env, PLEXUS_HOME: booted.home },
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr, argv };
}

beforeAll(async () => {
  booted = await bootGateway();
});

afterAll(() => {
  booted?.cleanup();
  delete process.env.PLEXUS_HOME;
});

describe("msrc-t3: source detect (the scan over the admin API)", () => {
  it("finds a reachable source and prints an add hint", async () => {
    const { code, stdout } = await runCli(["source", "detect"]);
    expect(code).toBe(0);
    // A reachable Obsidian Local REST endpoint (our listener on 27124) → detected.
    expect(stdout).toContain("obsidian-rest");
    expect(stdout.toLowerCase()).toContain("reachable");
    // The "how to add" hint is surfaced.
    expect(stdout).toContain("plexus source add obsidian-rest");
  });

  it("--json emits a parseable detected array", async () => {
    const { code, stdout } = await runCli(["source", "detect", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { detected: { kind: string }[] };
    expect(Array.isArray(doc.detected)).toBe(true);
    expect(doc.detected.some((d) => d.kind === "obsidian-rest")).toBe(true);
  });
});

describe("msrc-t3: source add (secret via STDIN) → live + listed", () => {
  const SECRET = "super-secret-rest-bearer-key-zzz";

  it("reads the key from STDIN (never argv), stores it write-only, and goes live", async () => {
    const { code, stdout, argv } = await runCli(
      [
        "source",
        "add",
        "obsidian-rest",
        "--base-url",
        `http://127.0.0.1:${booted.mockPort}`,
        "--secret-name",
        "k",
        "--api-key-stdin",
      ],
      SECRET, // the key is piped to STDIN
    );
    expect(code).toBe(0);
    expect(stdout).toContain("added source");
    expect(stdout).toContain(REST_VAULT_READ_ID);

    // The api-key NEVER appears on the child's argv (no shell-history/process leak).
    expect(argv.join(" ")).not.toContain(SECRET);

    // The secret landed write-only at ~/.plexus/secrets/k with 0600 perms.
    const secretFile = join(booted.home, "secrets", "k");
    expect(existsSync(secretFile)).toBe(true);
    expect(readFileSync(secretFile, "utf8")).toBe(SECRET);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
  });

  it("source list shows it enabled + live with a capability count", async () => {
    const { code, stdout } = await runCli(["source", "list"]);
    expect(code).toBe(0);
    expect(stdout).toContain("obsidian-rest");
    expect(stdout).toContain("enabled");
    expect(stdout).toContain("live");
    const json = await runCli(["source", "list", "--json"]);
    const doc = JSON.parse(json.stdout) as {
      sources: { id: string; enabled: boolean; live: boolean; liveCapabilityCount: number }[];
    };
    const view = doc.sources.find((s) => s.id === "obsidian-rest")!;
    expect(view).toBeDefined();
    expect(view.enabled).toBe(true);
    expect(view.live).toBe(true);
    expect(view.liveCapabilityCount).toBeGreaterThan(0);
  });

  it("the protocol `manifest` (authorized list) also shows the source's capability (truly LIVE)", async () => {
    // The public `.well-known` `discover` no longer lists a catalog (authorized-subset
    // §3.3); the capability list is delivered post-handshake via `manifest`.
    const { code, stdout } = await runCli(["manifest"]);
    expect(code).toBe(0);
    expect(stdout).toContain(REST_VAULT_READ_ID);
  });
});

describe("msrc-t3: disable / enable / remove flip state", () => {
  it("disable unregisters (live:false, enabled:false), enable re-registers, remove drops it", async () => {
    // DISABLE → not live, config retained as disabled.
    const dis = await runCli(["source", "disable", "obsidian-rest"]);
    expect(dis.code).toBe(0);
    expect(dis.stdout).toContain("disabled source");
    let list = await runCli(["source", "list", "--json"]);
    let view = (JSON.parse(list.stdout) as { sources: { id: string; live: boolean; enabled: boolean }[] })
      .sources.find((s) => s.id === "obsidian-rest")!;
    expect(view.enabled).toBe(false);
    expect(view.live).toBe(false);
    // the authorized-list `manifest` no longer shows the capability (source unregistered).
    let disc = await runCli(["manifest"]);
    expect(disc.stdout).not.toContain(REST_VAULT_READ_ID);

    // ENABLE → re-registers LIVE.
    const en = await runCli(["source", "enable", "obsidian-rest"]);
    expect(en.code).toBe(0);
    expect(en.stdout).toContain("enabled source");
    disc = await runCli(["manifest"]);
    expect(disc.stdout).toContain(REST_VAULT_READ_ID);

    // REMOVE → dropped from config + capability gone.
    const rm = await runCli(["source", "remove", "obsidian-rest"]);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain("removed source");
    list = await runCli(["source", "list", "--json"]);
    const ids = (JSON.parse(list.stdout) as { sources: { id: string }[] }).sources.map((s) => s.id);
    expect(ids).not.toContain("obsidian-rest");
    disc = await runCli(["manifest"]);
    expect(disc.stdout).not.toContain(REST_VAULT_READ_ID);
  });
});

describe("msrc-t3: usage / guard errors", () => {
  it("--api-key-stdin without --secret-name is a usage error", async () => {
    const { code, stderr } = await runCli(["source", "add", "obsidian-rest", "--api-key-stdin"], "key");
    expect(code).not.toBe(0);
    expect(stderr).toContain("--secret-name");
  });
});
