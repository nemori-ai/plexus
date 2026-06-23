/**
 * integrations-codex-e2e — the DETERMINISTIC gate for the Codex integration.
 *
 * The Codex wrapper is "AGENTS.md instructions + the `plexus` CLI on PATH,
 * driven by `codex exec`". The LLM-in-the-loop `codex exec` run is best-effort
 * and lives in the README transcript / setup notes; THIS test is the
 * deterministic proof that the EXACT mechanism Codex would use works against a
 * real gateway with real data — no mock, no faking.
 *
 * It boots a real Plexus gateway with a real read-only Obsidian vault, then runs
 * the Codex-facing shim `integrations/codex/bin/plexus` as a SUBPROCESS — the
 * literal `bash` shim that Codex finds on its PATH — with the same PATH/env Codex
 * would have (the shim's dir on PATH, invoked by bare name `plexus`, the
 * connection-key auto-read from PLEXUS_HOME). It asserts:
 *
 *   - `plexus discover --json`  → the real vault capability + its usage skill,
 *   - `plexus skills <id> --json` → a REAL skill body (the usage knowledge),
 *   - `plexus call <id> --input` → REAL note content read back,
 *   - `plexus call <unknown>`   → the closed ErrorCode `unknown_capability`.
 *
 * Every command speaks the real DISCOVER → handshake → grant → invoke protocol
 * over real HTTP through the shared PlexusClient.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "../src/config.ts";
import { createAppWithState } from "../src/core/server.ts";
import { _resetSecretCacheForTests } from "../src/auth/index.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "../src/sources/obsidian/open-vault.ts";
import type { CapabilitySummary } from "../src/protocol/index.ts";

/** The Codex-facing shim (the bash launcher Codex puts on PATH). */
const CODEX_SHIM = join(import.meta.dir, "..", "integrations", "codex", "bin", "plexus");
const CODEX_BIN_DIR = dirname(CODEX_SHIM);

interface Booted {
  baseUrl: string;
  home: string;
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;

/** Pick a concrete free TCP port (the host/origin guard pins the authority). */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

async function bootGateway(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "plexus-codex-home-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-codex-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nCodex's plexus shim read THIS note via the real protocol.\n",
  );

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  return {
    baseUrl: configBaseUrl(config),
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
 * Run the Codex shim BY BARE NAME (`plexus`) with its dir prepended to PATH —
 * exactly how Codex resolves it from AGENTS.md instructions. The connection-key
 * is auto-read from PLEXUS_HOME (the no-paste local-agent path).
 */
async function runShim(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["plexus", ...args, "--url", booted.baseUrl], {
    env: {
      ...process.env,
      PATH: `${CODEX_BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
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

describe("integrations/codex — the shim is the exact thing Codex puts on PATH", () => {
  it("the shim exists and is executable", () => {
    expect(existsSync(CODEX_SHIM)).toBe(true);
  });

  it("resolves by bare name on PATH and prints help", async () => {
    const { code, stdout } = await runShim(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Plexus local capability gateway");
  });
});

describe("integrations/codex — discover (the scan Codex runs first)", () => {
  it("lists the real vault capability + its usage skill", async () => {
    const { code, stdout } = await runShim(["discover"]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_READ_ID);
    expect(stdout).toContain(VAULT_SKILL_ID);
    expect(stdout).toContain("grants:read");
  });

  it("--json emits parseable CapabilitySummary objects", async () => {
    const { code, stdout } = await runShim(["discover", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { capabilities: CapabilitySummary[] };
    const read = doc.capabilities.find((c) => c.id === VAULT_READ_ID);
    expect(read).toBeDefined();
    expect(read?.grants).toEqual(["read"]);
  });
});

describe("integrations/codex — skills (read usage knowledge before calling)", () => {
  it("fetches a real skill BODY", async () => {
    const { code, stdout } = await runShim(["skills", VAULT_SKILL_ID]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_SKILL_ID);
    expect(stdout.toLowerCase()).toContain("vault");
    expect(stdout.length).toBeGreaterThan(80);
  });
});

describe("integrations/codex — call (discover→grant→invoke returns REAL data)", () => {
  it("reads a real note and asserts its value", async () => {
    const { code, stdout } = await runShim([
      "call",
      VAULT_READ_ID,
      "--input",
      JSON.stringify({ path: "Projects/Plexus.md" }),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(`✓ ${VAULT_READ_ID} ok`);
    expect(stdout).toContain("Codex's plexus shim read THIS note via the real protocol.");
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
