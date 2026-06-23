/**
 * integrations-cc-e2e — drive the CLAUDE CODE PLUGIN's `bin/plexus` shim
 * end-to-end against a REAL booted gateway, exactly as Claude Code would over
 * Bash once the plugin (integrations/claude-code) is active on PATH.
 *
 * This is the deterministic GATE for the Claude Code integration. It exercises
 * the EXACT mechanism the `use-plexus` SKILL instructs — run the plugin's
 * `bin/plexus` (a thin shim → `bun integrations/cli/bin/plexus`) as a subprocess
 * for `discover` / `skills` / `call` — against a real gateway with a real
 * read-only Obsidian vault, and asserts:
 *
 *   - the shim resolves the shared CLI and runs (no mock),
 *   - `discover`        shows the real obsidian.vault.read capability + a skill,
 *   - `skills <id>`     FETCHES a real skill BODY (the usage knowledge the SKILL
 *                       tells CC to read BEFORE calling),
 *   - `call <id>`       returns the REAL note content (asserting the value),
 *   - `call <unknown>`  denies with the closed ErrorCode `unknown_capability`.
 *
 * No mock: every command talks the real DISCOVER → handshake → grant → invoke
 * protocol over real HTTP through the same engine the gateway harness uses. The
 * subprocess runs the plugin's actual bin shim file, so a regression in the shim
 * (bad path resolution, missing exec) fails this gate.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "../src/config.ts";
import { createAppWithState } from "../src/core/server.ts";
import { _resetSecretCacheForTests } from "../src/auth/index.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "../src/sources/obsidian/open-vault.ts";
import type { CapabilitySummary } from "../src/protocol/index.ts";

/** The Claude Code plugin's bin shim — the EXACT thing CC puts on its Bash PATH. */
const PLUGIN_SHIM = join(
  import.meta.dir,
  "..",
  "integrations",
  "claude-code",
  "bin",
  "plexus",
);

/** Pick a concrete free TCP port (the host/origin guard pins the authority). */
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
  const home = mkdtempSync(join(tmpdir(), "plexus-cc-home-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-cc-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nClaude Code read THIS note through the plugin shim via the real protocol.\n",
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

/**
 * Run the PLUGIN SHIM directly as a subprocess (not the raw CLI) — the exact
 * binary Claude Code invokes from its Bash PATH. We execute the shim file itself
 * so its path-resolution + bun-forwarding logic is part of what this gate proves.
 */
async function runShim(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([PLUGIN_SHIM, ...args, "--url", booted.baseUrl], {
    env: {
      ...process.env,
      // The CLI auto-reads the connection-key from PLEXUS_HOME/connection-key —
      // exactly the local-agent, no-paste path the integration relies on. We use
      // a throwaway PLEXUS_HOME so the real ~/.plexus is never touched.
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

describe("CC plugin shim — is the exact PATH binary CC runs", () => {
  it("exists and is executable", () => {
    const st = statSync(PLUGIN_SHIM);
    expect(st.isFile()).toBe(true);
    // Owner-executable bit set (0o100).
    expect(st.mode & 0o100).not.toBe(0);
  });
});

describe("CC plugin shim — discover (the scan the SKILL runs first)", () => {
  it("lists the real vault capability + its usage skill", async () => {
    const { code, stdout } = await runShim(["discover"]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_READ_ID);
    expect(stdout).toContain(VAULT_SKILL_ID);
    expect(stdout).toContain("grants:read");
    expect(stdout).toMatch(/gateway: plexus v/);
  });

  it("--json emits parseable CapabilitySummary objects", async () => {
    const { code, stdout } = await runShim(["discover", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { capabilities: CapabilitySummary[] };
    const read = doc.capabilities.find((c) => c.id === VAULT_READ_ID);
    expect(read).toBeDefined();
    expect(read?.kind).toBe("capability");
    expect(read?.grants).toEqual(["read"]);
  });
});

describe("CC plugin shim — skills (read usage guidance BEFORE calling)", () => {
  it("fetches a real skill BODY (not a mock)", async () => {
    const { code, stdout } = await runShim(["skills", VAULT_SKILL_ID]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_SKILL_ID);
    expect(stdout.toLowerCase()).toContain("vault");
    expect(stdout.length).toBeGreaterThan(80); // a real body, not an empty stub
  });
});

describe("CC plugin shim — call (discover→grant→invoke returns REAL data)", () => {
  it("reads a real note and asserts its value", async () => {
    const { code, stdout } = await runShim([
      "call",
      VAULT_READ_ID,
      "--input",
      JSON.stringify({ path: "Projects/Plexus.md" }),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(`✓ ${VAULT_READ_ID} ok`);
    expect(stdout).toContain(
      "Claude Code read THIS note through the plugin shim via the real protocol.",
    );
  });

  it("--json returns a real InvokeResponse with ok:true + output", async () => {
    const { code, stdout } = await runShim([
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
    const { code, stdout } = await runShim(["call", "nope.does.not_exist", "--json"]);
    expect(code).not.toBe(0);
    const res = JSON.parse(stdout) as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("unknown_capability");
  });
});
