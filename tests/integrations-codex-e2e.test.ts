/**
 * integrations-codex-e2e — the DETERMINISTIC gate for the Codex integration.
 *
 * The Codex wrapper is "AGENTS.md instructions + the `plexus` CLI on PATH". This
 * test is the deterministic proof that the EXACT mechanism Codex would use works
 * against a real gateway with real data — no mock, no faking.
 *
 * It runs the Codex-facing shim `integrations/codex/bin/plexus` as a SUBPROCESS —
 * the literal `bash` shim Codex finds on its PATH — and drives the SAME verb
 * surface `AGENTS.plexus.md` teaches Codex to use:
 *
 *   plexus enroll <one-time-code>   → redeem the code for the agent's OWN PAT
 *   plexus list                     → callable-now vs needs-approval (+ skills)
 *   plexus <capabilityId> <args>    → discover→handshake→grant→invoke, real data
 *
 * The load-bearing invariant this pins (ADR-019): Codex authenticates with its
 * OWN per-agent PAT, redeemed from a one-time enrollment code the OWNER mints —
 * it NEVER holds or uses the admin connection-key. The shim runs in an ISOLATED
 * agent home, distinct from the gateway home; the connection-key is asserted
 * absent from that agent home.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";

/** The Codex-facing shim (the bash launcher Codex puts on PATH). */
const CODEX_SHIM = join(import.meta.dir, "..", "integrations", "codex", "bin", "plexus");
const CODEX_BIN_DIR = dirname(CODEX_SHIM);
const AGENT_ID = "codex-e2e";

interface Booted {
  baseUrl: string;
  home: string; // the GATEWAY home (holds the admin connection-key)
  key: string;
  cleanup: () => void;
}

let booted: Booted;
let agentHome: string; // the AGENT home (holds only the per-agent PAT)
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
  const home = mkdtempSync(join(tmpdir(), "plexus-codex-gw-"));
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
    key: state.connectionKey.current(),
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
 * The OWNER (admin) connects the Codex agent: grants a starting cap-set as
 * standing and mints the one-time enrollment code the agent redeems. This uses
 * the connection-key — but on the ADMIN plane, never handed to the agent.
 */
async function connectAgent(capabilities: string[]): Promise<string> {
  const res = await fetch(`${booted.baseUrl}/admin/api/agents/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Plexus-Connection-Key": booted.key },
    body: JSON.stringify({
      agentId: AGENT_ID,
      agentType: "codex",
      capabilities,
      trustWindow: { kind: "7d" },
    }),
  });
  const body = (await res.json()) as { code?: string };
  if (!body.code) throw new Error(`connect did not return a code: ${JSON.stringify(body)}`);
  return body.code;
}

/**
 * Run the Codex shim BY BARE NAME (`plexus`) with its dir prepended to PATH —
 * exactly how Codex resolves it from AGENTS.md. It runs in the AGENT home with a
 * baked agent id and the gateway URL; NO connection-key is provided (the agent
 * authenticates with its own PAT, per ADR-019).
 */
async function runShim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["plexus", ...args], {
    env: {
      ...process.env,
      PATH: `${CODEX_BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      PLEXUS_HOME: agentHome,
      PLEXUS_GATEWAY: booted.baseUrl,
      PLEXUS_AGENT_ID: AGENT_ID,
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
  agentHome = mkdtempSync(join(tmpdir(), "plexus-codex-agent-"));
});

afterAll(() => {
  booted?.cleanup();
  if (agentHome) rmSync(agentHome, { recursive: true, force: true });
  delete process.env.PLEXUS_HOME;
});

describe("integrations/codex — the shim is the exact thing Codex puts on PATH", () => {
  it("the shim exists and is executable", () => {
    expect(existsSync(CODEX_SHIM)).toBe(true);
  });

  it("resolves by bare name on PATH and prints help for the enroll/list/<cap> surface", async () => {
    const { code, stdout } = await runShim(["--help"]);
    expect(code).toBe(0);
    // The verbs AGENTS.plexus.md teaches Codex — NOT the old packages/cli surface.
    expect(stdout).toContain("plexus enroll");
    expect(stdout).toContain("plexus list");
    expect(stdout).toContain("<capabilityId>");
  });
});

describe("integrations/codex — enroll (the agent redeems its OWN PAT, never the key)", () => {
  it("plexus enroll <code> stores a 0600 PAT; the connection-key never reaches the agent", async () => {
    const code = await connectAgent([VAULT_READ_ID]);
    const { code: exit, stdout } = await runShim(["enroll", code]);
    expect(exit).toBe(0);
    expect(stdout.toLowerCase()).toContain("enrolled");

    // The PAT landed in the AGENT home, 0600.
    const patFile = join(agentHome, "agents", `${AGENT_ID}.pat`);
    expect(existsSync(patFile)).toBe(true);
    expect((statSync(patFile).mode & 0o777).toString(8)).toBe("600");

    // ADR-019: the admin connection-key is NEVER present anywhere in the agent home.
    const scan = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...scan(p));
        else out.push(readFileSync(p, "utf8"));
      }
      return out;
    };
    for (const contents of scan(agentHome)) {
      expect(contents).not.toContain(booted.key);
    }
  });
});

describe("integrations/codex — list (callable-now vs needs-approval, skills grouped)", () => {
  it("shows the granted vault read as CALLABLE NOW and the skill under its own section", async () => {
    const { code, stdout } = await runShim(["list"]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_READ_ID);
    // The read is standing-granted → callable now.
    expect(stdout).toContain("CALLABLE NOW");
    // The usage skill is grouped as read-as-context, NOT presented as callable.
    expect(stdout).toContain("SKILLS");
    expect(stdout).toContain(VAULT_SKILL_ID);
  });
});

describe("integrations/codex — call (discover→handshake→grant→invoke, REAL data)", () => {
  it("reads a real note by capability id + positional arg", async () => {
    const { code, stdout } = await runShim([VAULT_READ_ID, "Projects/Plexus.md"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Codex's plexus shim read THIS note via the real protocol.");
  });

  it("--json returns a real InvokeResponse with ok:true + output", async () => {
    const { code, stdout } = await runShim([VAULT_READ_ID, "Index.md", "--json"]);
    expect(code).toBe(0);
    const res = JSON.parse(stdout) as { ok: boolean; output?: { content?: string } };
    expect(res.ok).toBe(true);
    expect(res.output?.content ?? "").toContain("Welcome to the demo vault.");
  });

  it("printing a SKILL by id emits its guidance body (never a wire call)", async () => {
    const { code, stdout } = await runShim([VAULT_SKILL_ID]);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("vault");
    expect(stdout.length).toBeGreaterThan(80);
  });

  it("an unknown capability fails cleanly (non-zero), not a crash", async () => {
    const { code, stdout, stderr } = await runShim(["nope.does.not_exist", "--json"]);
    expect(code).not.toBe(0);
    // Either a structured unknown_capability error or a clear grant/lookup failure —
    // never a stack trace. Accept the closed ErrorCode when present.
    const blob = (stdout + stderr).toLowerCase();
    expect(blob).toMatch(/unknown_capability|unknown capability|not.*grant|no such/);
  });
});
