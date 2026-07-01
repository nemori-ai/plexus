/**
 * D3-LAUNCHER-SHADOW-E2E — the executable proof for Bug B: the compiled CC plugin must invoke
 * its OWN bundled, version-pinned engine as the RIGHT agent, even when a DIFFERENT global
 * `plexus` sits earlier on the Bash PATH.
 *
 * The user's real environment had a pre-existing global `plexus` on PATH (a codex-integration
 * binary that hardcodes a different agentId). The SKILL used to teach a BARE `plexus <cap>`, so
 * Claude Code's Bash resolved that to the GLOBAL binary — every call authenticated as the wrong
 * agent, and the plugin's own `bin/plexus` was never used.
 *
 * The fix: the SKILL now teaches a PER-AGENT, collision-proof launcher `plexus-<agentId>` that
 *   (a) has a unique name no global `plexus` (or other plugin) can shadow, and
 *   (b) execs the plugin's OWN sibling engine (`bin/plexus`) by a self-relative path (never a PATH
 *       lookup), exporting PLEXUS_AGENT_ID=<agentId> so identity is unambiguous.
 *
 * This test reproduces the user's scenario end-to-end against a REAL booted gateway:
 *   1. Provision an agent (standing read grant + enrollment row) and materialize + enroll the
 *      plugin via the real self-contained install.sh, in an ISOLATED HOME.
 *   2. Put a FAKE global `plexus` EARLIER on PATH than the plugin's bin/ (a stub that acts as a
 *      DIFFERENT agent and never returns real data).
 *   3. Drop a DECOY second agent's PAT into the client store, so the engine WITHOUT an agent hint
 *      would refuse (ambiguous) — proving PLEXUS_AGENT_ID (set by the launcher) is load-bearing.
 *   4. Run the command THE SKILL TEACHES — `plexus-<agentId> <cap> <arg>` — and assert it returns
 *      the REAL note through the plugin's own engine as the RIGHT agent.
 *   5. Assert a BARE `plexus <cap>` would have hit the shadowing stub — proving the collision was
 *      real and the launcher structurally avoids it.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

const AGENT_ID = "my-claude-runner";
const DECOY_AGENT = "plexus-cli"; // a DIFFERENT agent whose PAT must never be picked by mistake
const NOTE_TEXT = "The per-agent launcher ran the plugin's OWN engine as the right agent.";
const STUB_MARKER = "SHADOW-STUB-GLOBAL-PLEXUS: I am a DIFFERENT agent and returned NO real data.";

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

interface Booted {
  baseUrl: string;
  serverHome: string;
  mgmtKey: string;
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;
let clientHome: string;
let stubBin: string;
let pluginBinDir: string;

async function bootGateway(): Promise<Booted> {
  const serverHome = mkdtempSync(join(tmpdir(), "plexus-d3-server-"));
  process.env.PLEXUS_HOME = serverHome;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-d3-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Projects", "Plexus.md"), `# Plexus\n${NOTE_TEXT}\n`);

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  state.agentEnrollment.mintEnrollmentCode(AGENT_ID);
  const now = Date.now();
  state.grants.put({
    agentId: AGENT_ID,
    capabilityId: VAULT_READ_ID,
    verbs: ["read"],
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    trustWindow: { kind: "7d" },
    standing: true,
  });

  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  return {
    baseUrl: configBaseUrl(config),
    serverHome,
    mgmtKey: state.connectionKey.current(),
    cleanup: () => {
      try {
        server.stop(true);
      } catch {
        /* ignore */
      }
      rmSync(serverHome, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
    },
  };
}

beforeAll(async () => {
  booted = await bootGateway();
  clientHome = mkdtempSync(join(tmpdir(), "plexus-d3-client-"));

  // A stub bin dir holding BOTH a stub `claude` (records nothing important; keeps install hermetic)
  // AND — critically — a FAKE GLOBAL `plexus` that acts as a DIFFERENT agent. This dir goes FIRST
  // on PATH, exactly like the user's `~/.local/bin/plexus` shadowing the plugin.
  stubBin = mkdtempSync(join(tmpdir(), "plexus-d3-bin-"));
  const claudeStub = join(stubBin, "claude");
  writeFileSync(claudeStub, `#!/usr/bin/env bash\nexit 0\n`, { mode: 0o755 });
  const globalPlexus = join(stubBin, "plexus");
  // The shadowing global: prints its marker + the args, NEVER contacts the gateway, NEVER prints the note.
  writeFileSync(
    globalPlexus,
    `#!/usr/bin/env bash\necho "${STUB_MARKER} argv=[$*]"\nexit 0\n`,
    { mode: 0o755 },
  );
  try {
    chmodSync(claudeStub, 0o755);
    chmodSync(globalPlexus, 0o755);
  } catch {
    /* best-effort */
  }
});

afterAll(() => {
  booted?.cleanup();
  if (clientHome) rmSync(clientHome, { recursive: true, force: true });
  if (stubBin) rmSync(stubBin, { recursive: true, force: true });
  delete process.env.PLEXUS_HOME;
});

function get(path: string, init?: RequestInit) {
  return fetch(`${booted.baseUrl}${path}`, init);
}

describe("D3 — the SKILL-taught per-agent launcher beats a shadowing global `plexus`", () => {
  it("materializes + enrolls, then `plexus-<agentId> <cap>` returns REAL data as the right agent (not the shadow)", async () => {
    // (1) Read the mgmt-gated JSON → the copy-able installCommand carrying a FRESH one-time code.
    const jsonRes = await get(`/integration/${AGENT_ID}`, {
      headers: { "x-plexus-connection-key": booted.mgmtKey },
    });
    expect(jsonRes.status).toBe(200);
    const json = (await jsonRes.json()) as { installCommand: string };
    const code = json.installCommand.match(/PLEXUS_ENROLL_CODE="(plx_enroll_[^"]+)"/)![1] as string;

    // (2) Fetch the PUBLIC install.sh and pipe it into bash in the ISOLATED HOME (no mgmt key), with
    //     the shadowing stub dir FIRST on PATH — exactly the user's broken environment.
    const installSh = await (await get(`/integration/${AGENT_ID}/install.sh`)).text();
    const proc = Bun.spawn(["bash", "-s"], {
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        HOME: clientHome,
        PLEXUS_HOME: clientHome,
        PLEXUS_GATEWAY: booted.baseUrl,
        PLEXUS_ENROLL_CODE: code,
      },
      stdin: Buffer.from(installSh, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const outStdout = await new Response(proc.stdout).text();
    const outStderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`install.sh exited ${exit}\n${outStdout}\n${outStderr}`);

    const dir = join(clientHome, "plugins", `plexus@${AGENT_ID}`);
    pluginBinDir = join(dir, "bin");

    // The per-agent launcher was materialized alongside the engine, and is executable.
    const launcher = join(pluginBinDir, `plexus-${AGENT_ID}`);
    expect(existsSync(launcher)).toBe(true);
    const launcherBody = readFileSync(launcher, "utf8");
    expect(launcherBody).toContain(`export PLEXUS_AGENT_ID='${AGENT_ID}'`);
    expect(launcherBody).toContain('exec "$RUNTIME" "$SELF_DIR/plexus"');

    // The SKILL teaches the launcher name (not a bare `plexus`).
    const skill = readFileSync(join(dir, "skills", "use-plexus", "SKILL.md"), "utf8");
    expect(skill).toContain(`plexus-${AGENT_ID} <capabilityId>`);

    // (3) DECOY: a SECOND agent's PAT in the same store. WITHOUT an agent hint the engine refuses
    //     (ambiguous), so a successful call PROVES the launcher's PLEXUS_AGENT_ID pinned identity.
    writeFileSync(join(clientHome, "agents", `${DECOY_AGENT}.pat`), "plx_agent_decoydecoydecoydecoydecoy\n", { mode: 0o600 });

    // (4) THE PAYOFF — run the EXACT command the SKILL teaches, with the shadowing stub still FIRST
    //     on PATH and the plugin's bin/ also on PATH (as Claude Code puts it). Do NOT set
    //     PLEXUS_AGENT_ID in the env — the launcher must set it itself.
    const runPath = `${stubBin}:${pluginBinDir}:${process.env.PATH ?? ""}`;
    const call = Bun.spawn([`plexus-${AGENT_ID}`, VAULT_READ_ID, "Projects/Plexus.md"], {
      env: { PATH: runPath, HOME: clientHome, PLEXUS_HOME: clientHome, PLEXUS_GATEWAY: booted.baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const callOut = await new Response(call.stdout).text();
    const callErr = await new Response(call.stderr).text();
    const callExit = await call.exited;
    expect(callErr).toBe("");
    expect(callExit).toBe(0);
    // Got the REAL note through the plugin's OWN engine as the RIGHT agent…
    expect(callOut).toContain(NOTE_TEXT);
    // …and NOT the shadowing global stub.
    expect(callOut).not.toContain(STUB_MARKER);

    // (5) Prove the collision was REAL: a BARE `plexus <cap>` on the SAME PATH hits the shadow stub,
    //     never the plugin engine — which is exactly why the launcher (unique name) is required.
    const bare = Bun.spawn(["plexus", VAULT_READ_ID, "Projects/Plexus.md"], {
      env: { PATH: runPath, HOME: clientHome, PLEXUS_HOME: clientHome, PLEXUS_GATEWAY: booted.baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const bareOut = await new Response(bare.stdout).text();
    await bare.exited;
    expect(bareOut).toContain(STUB_MARKER); // the shadow won bare `plexus`
    expect(bareOut).not.toContain(NOTE_TEXT); // and never returned real data
  });
});
