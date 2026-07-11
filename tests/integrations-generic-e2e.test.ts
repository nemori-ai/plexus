/**
 * integrations-generic-e2e — the DETERMINISTIC gate for the PORTABLE ("generic") integration.
 *
 * The generic delivery is "a served setup.sh + a copy-able AGENTS.plexus.md + the `plexus` CLI".
 * This test is the deterministic proof that the EXACT mechanism a generic agent would use works
 * against a real gateway with real data — no mock, no faking, no LLM in the loop.
 *
 * It exercises the WHOLE delivery the console hands out for a `generic` agent:
 *
 *   1. connect the agent (agentType: "generic") + mgmt-fetch `GET /integration/:agentId`
 *      → the mgmt-gated JSON carries the one-time `enrollCode` + the code-FREE `setupCommand`
 *        + the copy-able `instruction` text ({{PLEXUS_CMD}} filled with the absolute launcher).
 *   2. fetch the PUBLIC `GET /integration/:agentId/setup.sh` (no key) + run it with cwd = a
 *      FAKE PROJECT DIR (the paste-in-the-project model, agent-integration-project-scope §4) in
 *      an ISOLATED agent home → it materializes the engine + this agent's launcher INSIDE the
 *      state home ($PLEXUS_HOME/agents/<id>/bin/plexus — NOT on PATH), pins the gateway, and
 *      lands the Plexus block at <project>/AGENTS.md with the absolute launcher path filled in.
 *   3. drive the launcher by its ABSOLUTE path — enroll (with the mgmt-only code) → list →
 *      invoke a real cap — the SAME command form AGENTS.plexus.md teaches.
 *
 * SECURITY INVARIANTS this pins:
 *   - Inv III — the served setup.sh + the landed AGENTS.plexus.md are CODE-FREE + KEY-FREE:
 *     neither the one-time code, a durable PAT, nor the admin connection-key appears in any
 *     served/landed file. The code rides ONLY the mgmt-gated JSON.
 *   - ADR-019 — the agent authenticates with its OWN per-agent PAT, redeemed from a one-time
 *     code the OWNER mints; it NEVER holds the admin connection-key. The connection-key is
 *     asserted absent from the isolated agent home after enroll/list/invoke.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
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

const AGENT_ID = "generic-e2e";

interface Booted {
  baseUrl: string;
  home: string; // the GATEWAY home (holds the admin connection-key)
  key: string;
  cleanup: () => void;
}

let booted: Booted;
let agentHome: string; // the AGENT home (holds only the per-agent PAT + engine + pin + launcher)
let projectDir: string; // the FAKE PROJECT the setup command is "pasted" in (cwd of setup.sh)
let launcher: string; // the ABSOLUTE per-agent launcher path — the one command the block teaches
let server: ReturnType<typeof Bun.serve>;

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

async function bootGateway(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "plexus-generic-gw-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-generic-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nThe generic agent's plexus CLI read THIS note via the real protocol.\n",
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

/** The OWNER connects the GENERIC agent (grants a starting cap-set + mints the code). */
async function connectAgent(capabilities: string[]): Promise<void> {
  const res = await fetch(`${booted.baseUrl}/admin/api/agents/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Plexus-Connection-Key": booted.key },
    body: JSON.stringify({
      agentId: AGENT_ID,
      agentType: "generic",
      capabilities,
      trustWindow: { kind: "7d" },
    }),
  });
  if (res.status !== 200) throw new Error(`connect failed: HTTP ${res.status}`);
}

/** The mgmt-gated integration JSON — carries the code-free setupCommand + the one-time code. */
async function getIntegration(): Promise<{
  agentType?: string;
  setupCommand?: string;
  instruction?: string;
  enrollCode?: string;
  enrollCommand?: string;
  installCommand?: string;
  capabilities?: string[];
}> {
  const res = await fetch(`${booted.baseUrl}/integration/${AGENT_ID}`, {
    headers: { accept: "application/json", "X-Plexus-Connection-Key": booted.key },
  });
  if (res.status !== 200) throw new Error(`GET /integration JSON failed: HTTP ${res.status}`);
  return (await res.json()) as never;
}

/** The PUBLIC served setup.sh (no key) — must be reachable by a cold agent. */
async function getSetupSh(key?: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${booted.baseUrl}/integration/${AGENT_ID}/setup.sh`, {
    headers: key ? { "X-Plexus-Connection-Key": key } : {},
  });
  return { status: res.status, body: await res.text() };
}

/** Run the installed launcher by its ABSOLUTE path (exactly what the landed block teaches —
 *  it is NOT on the shell PATH) in the agent home — never the connection-key. */
async function runPlexus(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([launcher, ...args], {
    env: {
      ...process.env,
      PLEXUS_HOME: agentHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Recursively read every file's contents under a dir. */
function scanFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...scanFiles(p));
    else out.push(readFileSync(p, "utf8"));
  }
  return out;
}

beforeAll(async () => {
  booted = await bootGateway();
  // realpath: bash $PWD is symlink-resolved on macOS, and the launcher path lands inside AGENTS.md.
  agentHome = realpathSync(mkdtempSync(join(tmpdir(), "plexus-generic-agent-")));
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "plexus-generic-project-")));
  launcher = join(agentHome, "agents", AGENT_ID, "bin", "plexus");
});

afterAll(() => {
  booted?.cleanup();
  if (agentHome) rmSync(agentHome, { recursive: true, force: true });
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  delete process.env.PLEXUS_HOME;
});

describe("integrations/generic — the served setup.sh is code-free + key-free (Inv III)", () => {
  it("mgmt JSON carries the code + a code-free setupCommand; served setup.sh leaks no secret", async () => {
    await connectAgent([VAULT_READ_ID]);
    const integ = await getIntegration();

    // The mgmt-gated JSON is the ONLY place the one-time code is delivered.
    expect(integ.agentType).toBe("generic");
    expect(typeof integ.enrollCode).toBe("string");
    expect(integ.enrollCode).toMatch(/^plx_enroll_/);
    expect(integ.setupCommand).toContain("/integration/generic-e2e/setup.sh");
    // The setupCommand is CODE-FREE (no code baked into the command).
    expect(integ.setupCommand).not.toContain(integ.enrollCode!);
    // The instruction text carries no code + no connection-key…
    expect(integ.instruction ?? "").not.toContain(integ.enrollCode!);
    expect(integ.instruction ?? "").not.toContain(booted.key);
    // …and is token-COMPLETE: {{PLEXUS_CMD}} is filled server-side with the ABSOLUTE per-agent
    // launcher path (under the GATEWAY's resolved home — gateway and agent share the machine).
    expect(integ.instruction ?? "").not.toContain("{{PLEXUS_");
    expect(integ.instruction ?? "").toContain(`/agents/${AGENT_ID}/bin/plexus`);
    // The out-of-band enroll is spelled with the same absolute launcher.
    expect(integ.enrollCommand ?? "").toContain(`/agents/${AGENT_ID}/bin/plexus enroll `);

    // The PUBLIC setup.sh is reachable WITHOUT the connection-key…
    const pub = await getSetupSh();
    expect(pub.status).toBe(200);
    // …and it is CODE-FREE + KEY-FREE: no one-time code, no durable PAT, no connection-key.
    expect(pub.body).not.toContain(integ.enrollCode!);
    expect(pub.body).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    expect(pub.body).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
    expect(pub.body).not.toContain(booted.key);
    // It installs the sanctioned CLI (embeds the engine) + lands the instruction.
    expect(pub.body).toContain("PLEXUS_EOF_ENGINE");
    expect(pub.body).toContain("<!-- BEGIN PLEXUS -->");
  });

  it("a never-connected agent's setup.sh is 404", async () => {
    const res = await fetch(`${booted.baseUrl}/integration/ghost-generic/setup.sh`);
    expect(res.status).toBe(404);
  });
});

describe("integrations/generic — running the served setup.sh installs a working CLI", () => {
  it("setup.sh lands the launcher in the state home + pins the gateway + writes <project>/AGENTS.md", async () => {
    const { body: setupSh } = await getSetupSh();
    const scriptPath = join(agentHome, "served-setup.sh");
    writeFileSync(scriptPath, setupSh);

    // cwd = the fake project dir — $PWD at paste time IS the project; AGENTS.md defaults there.
    const proc = Bun.spawn(["bash", scriptPath], {
      cwd: projectDir,
      env: { ...process.env, PLEXUS_HOME: agentHome, PLEXUS_GATEWAY: booted.baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("plexus setup: done");
    // The output contract names the exact file + that the agent discovers it by itself.
    expect(out).toContain(join(projectDir, "AGENTS.md"));
    expect(out).toContain("picks it up from this project by itself");

    // The engine + this agent's launcher (inside the state home, NOT a PATH dir) + gateway pin
    // + the project AGENTS.md all landed.
    expect(existsSync(join(agentHome, "bin", "plexus"))).toBe(true);
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(join(agentHome, "gateway"), "utf8").trim()).toBe(booted.baseUrl);
    const landed = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    expect(landed).toContain("<!-- BEGIN PLEXUS -->");
    // The run-time sed fill resolved {{PLEXUS_CMD}} to the ABSOLUTE launcher path — the block
    // teaches a command that exists on this machine, from any workdir.
    expect(landed).not.toContain("{{PLEXUS_");
    expect(landed).toContain(launcher);
    // The landed instruction is code-free + key-free.
    expect(landed).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    expect(landed).not.toContain(booted.key);

    // The installed launcher runs the sanctioned engine's documented surface.
    const { code: hc, stdout: help } = await runPlexus(["--help"]);
    expect(hc).toBe(0);
    expect(help).toContain("plexus enroll");
    expect(help).toContain("plexus list");
  });

  it("re-running setup.sh in the same project REFRESHES the block (marker-guarded, no duplicate)", async () => {
    const { body: setupSh } = await getSetupSh();
    const scriptPath = join(agentHome, "served-setup.sh");
    writeFileSync(scriptPath, setupSh);
    const proc = Bun.spawn(["bash", scriptPath], {
      cwd: projectDir,
      env: { ...process.env, PLEXUS_HOME: agentHome, PLEXUS_GATEWAY: booted.baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(await proc.exited).toBe(0);
    expect(out).toContain("refreshed the Plexus block");
    const landed = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    expect(landed.split("<!-- BEGIN PLEXUS -->").length).toBe(2); // exactly one block
  });
});

describe("integrations/generic — enroll → list → invoke (real data, per-agent PAT only)", () => {
  it("enrolls with the mgmt-only code; the connection-key never reaches the agent home", async () => {
    // Re-fetch a FRESH code from the mgmt JSON (the code is single-use; each fetch supersedes).
    const integ = await getIntegration();
    expect(integ.enrollCode).toMatch(/^plx_enroll_/);

    const { code, stdout } = await runPlexus(["enroll", integ.enrollCode!]);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("enrolled");

    // The PAT landed in the AGENT home, 0600.
    const patFile = join(agentHome, "agents", `${AGENT_ID}.pat`);
    expect(existsSync(patFile)).toBe(true);
    expect((statSync(patFile).mode & 0o777).toString(8)).toBe("600");

    // ADR-019: the admin connection-key is NEVER present anywhere in the agent home.
    for (const contents of scanFiles(agentHome)) {
      expect(contents).not.toContain(booted.key);
    }
  });

  it("list shows the granted vault read as CALLABLE NOW + the skill grouped", async () => {
    const { code, stdout } = await runPlexus(["list"]);
    expect(code).toBe(0);
    expect(stdout).toContain(VAULT_READ_ID);
    expect(stdout).toContain("CALLABLE NOW");
    expect(stdout).toContain(VAULT_SKILL_ID);
  });

  it("invokes a real cap by id + positional arg (real data)", async () => {
    const { code, stdout } = await runPlexus([VAULT_READ_ID, "Projects/Plexus.md"]);
    expect(code).toBe(0);
    expect(stdout).toContain("The generic agent's plexus CLI read THIS note via the real protocol.");
  });

  it("--json returns a real InvokeResponse with ok:true + output", async () => {
    const { code, stdout } = await runPlexus([VAULT_READ_ID, "Index.md", "--json"]);
    expect(code).toBe(0);
    const res = JSON.parse(stdout) as { ok: boolean; output?: { content?: string } };
    expect(res.ok).toBe(true);
    expect(res.output?.content ?? "").toContain("Welcome to the demo vault.");
  });

  it("after enroll+list+invoke, the connection-key is STILL absent from the agent home", async () => {
    for (const contents of scanFiles(agentHome)) {
      expect(contents).not.toContain(booted.key);
    }
  });
});
