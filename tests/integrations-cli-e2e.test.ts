/**
 * integrations-cli-e2e — drive the SHARED `plexus` integration CLI end-to-end
 * against a REAL booted gateway, exactly as a coding agent (ti-cc / ti-codex)
 * would over Bash.
 *
 * This is the honest proof for the integration layer: it boots a real Plexus
 * gateway on a concrete free loopback port (the host/origin guard pins the
 * expected authority to the configured port, so we cannot bind :0 — we pick a
 * free port and serve on exactly it, mirroring examples/min-agent/run.ts), with a
 * fresh PLEXUS_HOME whose connection-key the CLI auto-reads (no manual paste), and
 * a real Obsidian vault read-only source registered. Then it RUNS THE ACTUAL CLI
 * BINARY as a subprocess (`bun integrations/cli/bin/plexus …`) and asserts:
 *
 *   - `discover`           shows the real obsidian.vault.read capability + a skill,
 *   - `discover --json`    parses to real CapabilitySummary objects,
 *   - `skills <id>`        FETCHES a real skill BODY (the usage knowledge),
 *   - `call <id>`          returns REAL note content (asserting the value),
 *   - `call <unknown>`     denies with the closed ErrorCode `unknown_capability`.
 *
 * No mock: every command talks the real DISCOVER → handshake → grant → invoke
 * protocol over real HTTP through the same PlexusClient the gateway harness uses.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";
import type { CapabilitySummary } from "@plexus/protocol";

const CLI_BIN = join(import.meta.dir, "..", "packages", "cli", "src", "bin", "plexus");

/** Pick a concrete free TCP port (we serve on exactly it; see header). */
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
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;

/** Boot a real gateway with its own PLEXUS_HOME + a registered read-only vault. */
async function bootGateway(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "plexus-int-cli-home-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  // Real Obsidian vault with real notes.
  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-int-cli-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nThe CLI discovered and read THIS note via the real protocol.\n",
  );

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  const base = configBaseUrl(config);

  return {
    baseUrl: base,
    home,
    cleanup: () => {
      try {
        server.stop(true);
      } catch {
        /* ignore */
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
    },
  };
}

/** Run the CLI binary as a subprocess against the booted gateway. */
async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_BIN, ...args, "--url", booted.baseUrl], {
    env: {
      ...process.env,
      // The CLI auto-reads the connection-key from PLEXUS_HOME/connection-key —
      // exactly the local-agent, no-paste path the integration relies on.
      PLEXUS_HOME: booted.home,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

beforeAll(async () => {
  booted = await bootGateway();
});

afterAll(() => {
  booted?.cleanup();
  delete process.env.PLEXUS_HOME;
});

// The public `.well-known` `discover` no longer lists a catalog (authorized-subset model
// §3.3) — it points the agent at `manifest`, the post-handshake list of the capabilities
// Plexus authorized this agent to access. The scan assertions repoint there.
describe("integrations CLI — manifest (the authorized list)", () => {
  it("lists the real vault capability + its usage skill", async () => {
    const { code, stdout } = await runCli(["manifest"]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_READ_ID);
    expect(stdout).toContain(VAULT_SKILL_ID);
    // grants + transport surfaced per entry.
    expect(stdout).toMatch(/grants:\s+read/);
    expect(stdout).toMatch(/full entr/);
  });

  it("--json emits parseable manifest entries", async () => {
    const { code, stdout } = await runCli(["manifest", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { entries: Array<{ id: string; kind: string; grants: string[] }> };
    const read = doc.entries.find((c) => c.id === VAULT_READ_ID);
    expect(read).toBeDefined();
    expect(read?.kind).toBe("capability");
    expect(read?.grants).toEqual(["read"]);
  });
});

describe("integrations CLI — skills (the usage-knowledge half)", () => {
  it("lists kind:\"skill\" entries", async () => {
    const { code, stdout } = await runCli(["skills"]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_SKILL_ID);
  });

  it("fetches a real skill BODY (not a mock)", async () => {
    const { code, stdout } = await runCli(["skills", VAULT_SKILL_ID]);
    expect(code).toBe(0);
    // The bundled how-to-cite-vault skill body is real markdown content.
    expect(stdout).toContain(VAULT_SKILL_ID);
    expect(stdout.toLowerCase()).toContain("vault");
    expect(stdout.length).toBeGreaterThan(80); // a real body, not an empty stub
  });
});

describe("integrations CLI — call (discover→grant→invoke returns REAL data)", () => {
  it("reads a real note and asserts its value", async () => {
    const { code, stdout } = await runCli([
      "call",
      VAULT_READ_ID,
      "--input",
      JSON.stringify({ path: "Projects/Plexus.md" }),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(`✓ ${VAULT_READ_ID} ok`);
    // The REAL note content — the assert that proves a true end-to-end read.
    expect(stdout).toContain("The CLI discovered and read THIS note via the real protocol.");
  });

  it("--json returns a real InvokeResponse with ok:true + output", async () => {
    const { code, stdout } = await runCli([
      "call",
      VAULT_READ_ID,
      "--input",
      JSON.stringify({ path: "Index.md" }),
      "--json",
    ]);
    expect(code).toBe(0);
    const res = JSON.parse(stdout) as {
      id: string;
      ok: boolean;
      output?: { content?: string };
      auditId: string;
    };
    expect(res.ok).toBe(true);
    expect(res.id).toBe(VAULT_READ_ID);
    expect(res.output?.content ?? "").toContain("Welcome to the demo vault.");
    expect(res.auditId.length).toBeGreaterThan(0);
  });

  it("denies an unknown capability with the closed ErrorCode (--json)", async () => {
    const { code, stdout } = await runCli(["call", "nope.does.not_exist", "--json"]);
    expect(code).not.toBe(0);
    const res = JSON.parse(stdout) as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("unknown_capability");
  });
});
