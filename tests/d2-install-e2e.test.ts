/**
 * D2-INSTALL-E2E — actually RUN the copy-able one-command install (ADR-8), end to end.
 *
 * This is the executable proof that the "copy-able one-command install" genuinely works when
 * piped `curl … | PLEXUS_ENROLL_CODE=… bash` with NO surrounding directory — the exact failure
 * mode the shipped bug had (install.sh was 404 + assumed it ran from a materialized plugin dir).
 *
 * The flow this test drives, against a REAL booted gateway + a real read-only vault:
 *   1. Provision an agent: a STANDING read-cap grant + a seeded enrollment row (the state the
 *      admin `POST /admin/api/agents/connect` produces — done here directly for determinism).
 *   2. GET /integration/<agent>  (mgmt-gated JSON) → the `installCommand` carrying a FRESH
 *      single-use `plx_enroll_…` code + the `…/install.sh` URL.
 *   3. GET /integration/<agent>/install.sh  (PUBLIC — NO mgmt key, as a cold agent's curl is) →
 *      the SELF-CONTAINED bootstrap script, served text/plain.
 *   4. Pipe that script into `bash` with PLEXUS_ENROLL_CODE + PLEXUS_GATEWAY set (reproducing
 *      `curl … | PLEXUS_ENROLL_CODE=… bash`) inside an ISOLATED HOME/PLEXUS_HOME.
 *   5. Assert the install actually happened: the plugin dir materialized with every payload file
 *      from inline heredocs, `bin/plexus` executable, the gateway pinned, enrollment redeemed →
 *      a `plx_agent_…` PAT stored 0600, and NO connection-key anywhere in the client HOME (Inv III).
 *   6. Then run `bin/plexus <cap> <arg>` (the materialized engine) and assert it returns the REAL
 *      note content through the whole hidden auth chain.
 *
 * The `claude plugin marketplace add/install` step needs the `claude` CLI. To keep this test
 * HERMETIC and non-destructive to the developer's real Claude Code config, we put a STUB
 * `claude` on PATH that records its argv, and run install.sh with cwd = a FAKE PROJECT DIR —
 * the paste-in-the-project-dir model (agent-integration-project-scope §2): $PWD at paste time
 * IS the project the plugin registers into. We assert install.sh invokes the CLI with
 * `plugin marketplace add … --scope local` + `plugin install … --scope local` (project-located,
 * personal — never user/machine-global). The gateway-pin + file-materialization + enroll (which
 * are useful even without Claude Code) run BEFORE and INDEPENDENTLY of that step, so
 * `plexus <cap>` works regardless — proven here. Additional cases pin the PLEXUS_CC_SCOPE knob
 * (project accepted, user refused), the $PWD = $HOME loud warning, and the user-scope
 * migration hint against a stubbed CC registry.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

const AGENT_ID = "cc-agent-d2";
const NOTE_TEXT = "The self-contained install.sh materialized THIS plugin and enrolled the agent.";
const HAS_CLAUDE = Bun.which("claude") != null;

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
let projectDir: string; // the FAKE PROJECT the install command is "pasted" in (cwd of install.sh)
let stubBin: string;
let claudeLog: string;

/** Boot a real gateway + a read-only vault; provision a STANDING read grant + an enrollment row. */
async function bootGateway(): Promise<Booted> {
  const serverHome = mkdtempSync(join(tmpdir(), "plexus-d2-server-"));
  process.env.PLEXUS_HOME = serverHome;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-d2-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the D2 demo vault.\n");
  writeFileSync(join(vaultPath, "Projects", "Plexus.md"), `# Plexus\n${NOTE_TEXT}\n`);

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  // Provisioning (what admin connect leaves behind): seed the enrollment row (so the integration
  // endpoint recognizes the agent) + a STANDING, admin-approved read grant (so the call is frictionless).
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

  // An ISOLATED client HOME/PLEXUS_HOME — a cold machine that has NO connection-key.
  clientHome = realpathSync(mkdtempSync(join(tmpdir(), "plexus-d2-client-"))); // realpath: bash $PWD/$HOME are symlink-resolved on macOS
  // The fake project dir the user "pastes" the install command in — install.sh runs with THIS
  // as cwd, exactly the directory Claude Code treats as the project ($PWD ≠ $HOME here).
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "plexus-d2-project-")));

  // A stub `claude` on PATH (records argv) so the plugin-registration step is hermetic + never
  // mutates the developer's real ~/.claude. install.sh's gateway-pin + enroll run independently.
  stubBin = mkdtempSync(join(tmpdir(), "plexus-d2-bin-"));
  claudeLog = join(stubBin, "claude-invocations.log");
  const stub = join(stubBin, "claude");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${claudeLog}"\nexit 0\n`, { mode: 0o755 });
  try {
    require("node:fs").chmodSync(stub, 0o755);
  } catch {
    /* best-effort */
  }
});

afterAll(() => {
  booted?.cleanup();
  if (clientHome) rmSync(clientHome, { recursive: true, force: true });
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  if (stubBin) rmSync(stubBin, { recursive: true, force: true });
  delete process.env.PLEXUS_HOME;
});

/** Fetch through the real HTTP server (a real curl would use the same Host). */
function get(path: string, init?: RequestInit) {
  return fetch(`${booted.baseUrl}${path}`, init);
}

describe("D2 — the install.sh route is a PUBLIC, secret-free projection; JSON stays mgmt-gated", () => {
  it("GET /integration/:agentId/install.sh → 200 text/plain WITHOUT a mgmt key", async () => {
    const res = await get(`/integration/${AGENT_ID}/install.sh`); // NO key — a cold agent's curl
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const body = await res.text();
    expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
    // Secret-free: no baked code / PAT / connection-key rides the public script.
    expect(body).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    expect(body).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
    expect(body).not.toContain(booted.mgmtKey);
  });

  it("GET /integration/:agentId (JSON) → 401 WITHOUT the mgmt key (still gated)", async () => {
    const res = await get(`/integration/${AGENT_ID}`); // no key
    expect(res.status).toBe(401);
  });

  it("GET /integration/<unknown>/install.sh → 404 (still derives the cap-set, refuses unknowns)", async () => {
    const res = await get(`/integration/ghost-agent/install.sh`);
    expect(res.status).toBe(404);
  });
});

describe("D2 — actually RUN `curl … | PLEXUS_ENROLL_CODE=… bash` end to end", () => {
  it("materializes the plugin, pins the gateway, enrolls (0600 PAT), and `plexus <cap>` returns real data", async () => {
    // (1) Read the mgmt-gated JSON to get the copy-able installCommand + its FRESH one-time code.
    const jsonRes = await get(`/integration/${AGENT_ID}`, {
      headers: { "x-plexus-connection-key": booted.mgmtKey },
    });
    expect(jsonRes.status).toBe(200);
    const json = (await jsonRes.json()) as { installCommand: string; dirName: string; capabilities: string[] };
    expect(json.capabilities).toEqual([VAULT_READ_ID]);
    expect(json.installCommand).toContain(`/integration/${AGENT_ID}/install.sh`);
    const codeMatch = json.installCommand.match(/PLEXUS_ENROLL_CODE="(plx_enroll_[^"]+)"/);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![1] as string;

    // (2) Fetch the PUBLIC install.sh exactly as `curl` would (no key), then pipe it into bash —
    //     i.e. reproduce `curl … | PLEXUS_ENROLL_CODE=… bash` with an ISOLATED HOME/PLEXUS_HOME.
    const installSh = await (await get(`/integration/${AGENT_ID}/install.sh`)).text();

    const proc = Bun.spawn(["bash", "-s"], {
      cwd: projectDir, // pasted IN the project dir — $PWD is the project the plugin registers into
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`, // stub `claude` first; real node/bun still resolve
        HOME: clientHome,
        PLEXUS_HOME: clientHome, // the agent's OWN store — no connection-key lives here
        PLEXUS_GATEWAY: booted.baseUrl,
        PLEXUS_ENROLL_CODE: code, // the one-time code rides the ENV, as the real command does
        CLAUDE_STUB_LOG: claudeLog,
      },
      stdin: Buffer.from(installSh, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      // Surface the script output to make any failure debuggable.
      throw new Error(`install.sh exited ${exit}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    }

    // (3) The plugin dir materialized from inline heredocs (NO surrounding dir was ever present).
    const dir = join(clientHome, "plugins", `plexus@${AGENT_ID}`);
    for (const rel of [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "skills/use-plexus/SKILL.md",
      "bin/plexus",
      "README.md",
    ]) {
      expect(existsSync(join(dir, rel))).toBe(true);
    }
    // bin/plexus is byte-identical to the committed engine + executable.
    const engineSrc = readFileSync(join(import.meta.dir, "..", "tools", "plexus-cli", "plexus"), "utf8");
    expect(readFileSync(join(dir, "bin", "plexus"), "utf8")).toBe(engineSrc);
    expect(statSync(join(dir, "bin", "plexus")).mode & 0o111).not.toBe(0);

    // (4) The gateway got pinned so `plexus <cap>` reaches the right port.
    expect(readFileSync(join(clientHome, "gateway"), "utf8").trim()).toBe(booted.baseUrl);

    // (5) Enrollment redeemed the one-time code → a durable PAT self-stored 0600. The scratch is gone.
    const patFile = join(clientHome, "agents", `${AGENT_ID}.pat`);
    expect(existsSync(patFile)).toBe(true);
    expect(readFileSync(patFile, "utf8").trim().startsWith("plx_agent_")).toBe(true);
    expect(statSync(patFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(clientHome, "agents", `${AGENT_ID}.enroll`))).toBe(false); // scratch deleted on success

    // (6) Inv III — NO connection-key anywhere in the client HOME; only the agent's own store exists.
    expect(existsSync(join(clientHome, "connection-key"))).toBe(false);
    expect(existsSync(join(booted.serverHome, "connection-key"))).toBe(true); // the gateway has one; the client never did

    // (7) The claude-plugin-registration step invoked the CLI with the right verbs AND the
    //     project-located scope (agent-integration-project-scope §3.1): both the marketplace
    //     declaration and the install pass --scope local explicitly (CC's own default is user).
    expect(existsSync(claudeLog)).toBe(true);
    const log = readFileSync(claudeLog, "utf8");
    expect(log).toContain(`plugin marketplace add ${dir} --scope local`);
    expect(log).toContain("plugin install plexus@plexus --scope local");
    expect(log).not.toContain("--scope user");
    // The printed contract (§3.4): where it landed, /reload-plugins activation, the ad-hoc line.
    expect(stdout).toContain(`plexus install: installed into project ${projectDir}`);
    expect(stdout).toContain(".claude/settings.local.json");
    expect(stdout).toContain("/reload-plugins");
    expect(stdout).toContain("--plugin-dir");
    // Run from a real project dir (not $HOME): no home-directory warning fired.
    expect(stderr).not.toContain("WARNING");
    // NB: a stub `claude` was used to stay hermetic; a real `claude` IS ${HAS_CLAUDE ? "present" : "absent"} in this env.

    // (8) THE PAYOFF — run the materialized engine and get the REAL note back through the hidden chain.
    const call = Bun.spawn(["node", join(dir, "bin", "plexus"), VAULT_READ_ID, "Projects/Plexus.md"], {
      env: { PATH: process.env.PATH ?? "", HOME: clientHome, PLEXUS_HOME: clientHome, PLEXUS_GATEWAY: booted.baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const callOut = await new Response(call.stdout).text();
    const callErr = await new Response(call.stderr).text();
    const callExit = await call.exited;
    expect(callErr).toBe("");
    expect(callExit).toBe(0);
    expect(callOut).toContain(NOTE_TEXT);
    // Only the result — none of the redeem/handshake/token plumbing leaks.
    expect(callOut).not.toContain("plx_agent_");
    expect(callOut).not.toContain("Bearer");
  });
});

// ── The project-scope knob + guards (agent-integration-project-scope §3.1–§3.5) ────────────────
// These re-runs are CODE-FREE (no PLEXUS_ENROLL_CODE — enrollment already happened above and the
// code is single-use): install.sh re-materializes idempotently and still runs step 4, which is
// exactly the surface under test here.
describe("D2 — PLEXUS_CC_SCOPE knob, $PWD=$HOME warning, user-scope migration hint", () => {
  /** Run the served install.sh (piped, code-free) with a controlled cwd + extra env. */
  async function runInstall(opts: {
    cwd: string;
    env?: Record<string, string>;
  }): Promise<{ exit: number; stdout: string; stderr: string }> {
    const installSh = await (await get(`/integration/${AGENT_ID}/install.sh`)).text();
    const proc = Bun.spawn(["bash", "-s"], {
      cwd: opts.cwd,
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        HOME: clientHome,
        PLEXUS_HOME: clientHome,
        PLEXUS_GATEWAY: booted.baseUrl,
        ...(opts.env ?? {}),
      },
      stdin: Buffer.from(installSh, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { exit, stdout, stderr };
  }

  it("PLEXUS_CC_SCOPE=project registers with --scope project (the committed settings.json posture)", async () => {
    const { exit, stdout } = await runInstall({
      cwd: projectDir,
      env: { PLEXUS_CC_SCOPE: "project" },
    });
    expect(exit).toBe(0);
    const log = readFileSync(claudeLog, "utf8");
    expect(log).toContain("--scope project");
    expect(stdout).toContain(`plexus install: installed into project ${projectDir} (scope: project`);
    expect(stdout).toContain(".claude/settings.json");
  });

  it("PLEXUS_CC_SCOPE=user is REFUSED loudly, before any side effect (the knob cannot go global)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "plexus-d2-badscope-"));
    try {
      const { exit, stderr } = await runInstall({
        cwd: projectDir,
        env: { PLEXUS_CC_SCOPE: "user", PLEXUS_HOME: scratch },
      });
      expect(exit).not.toBe(0);
      expect(stderr).toContain("invalid PLEXUS_CC_SCOPE");
      // Validation runs before materialization: nothing landed in the fresh home.
      expect(existsSync(join(scratch, "plugins"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("running from $PWD = $HOME warns LOUDLY (home-as-project) but proceeds (exit 0)", async () => {
    const { exit, stderr } = await runInstall({ cwd: clientHome }); // cwd == HOME
    expect(exit).toBe(0);
    expect(stderr).toContain("WARNING");
    expect(stderr).toContain("HOME directory");
    expect(stderr).toContain("cd into the project");
  });

  it("a pre-existing user-scope plexus@plexus (stubbed CC registry) prints the migration hint — and ONLY suggests", async () => {
    // Stub the recon-verified scope source: $CLAUDE_CONFIG_DIR/plugins/installed_plugins.json
    // (v2 schema — entries carry `scope`), with a machine-global install from an old installer.
    const ccConfig = mkdtempSync(join(tmpdir(), "plexus-d2-ccconfig-"));
    try {
      mkdirSync(join(ccConfig, "plugins"), { recursive: true });
      writeFileSync(
        join(ccConfig, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "plexus@plexus": [{ scope: "user", installPath: "/old/path" }] },
        }),
      );
      const { exit, stdout } = await runInstall({
        cwd: projectDir,
        env: { CLAUDE_CONFIG_DIR: ccConfig },
      });
      expect(exit).toBe(0);
      // The exact pinned one-liner (§3.5) — detect + suggest, never auto-remove.
      expect(stdout).toContain(
        "plexus install: a machine-global (user-scope) plexus@plexus from an older installer exists; consider removing it: claude plugin uninstall plexus@plexus --scope user",
      );
      // The installer itself never invoked an uninstall (the stub log records every claude call).
      expect(readFileSync(claudeLog, "utf8")).not.toContain("uninstall");
    } finally {
      rmSync(ccConfig, { recursive: true, force: true });
    }
  });

  it("plexus@plexus at LOCAL scope + ANOTHER plugin at user scope → NO hint (detection is entry-scoped)", async () => {
    // The false-positive shape the naive whole-file grep had: `plexus@plexus` appears (local
    // scope, i.e. already migrated) AND `"scope": "user"` appears (some unrelated plugin). The
    // hint must key on the plexus@plexus ENTRY's own scope, so this combination stays silent.
    const ccConfig = mkdtempSync(join(tmpdir(), "plexus-d2-ccconfig-combo-"));
    try {
      mkdirSync(join(ccConfig, "plugins"), { recursive: true });
      writeFileSync(
        join(ccConfig, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "plexus@plexus": [{ scope: "local", projectPath: "/some/project", installPath: "/new/path" }],
            "superpowers@marketplace": [{ scope: "user", installPath: "/unrelated/plugin" }],
          },
        }),
      );
      const { exit, stdout } = await runInstall({
        cwd: projectDir,
        env: { CLAUDE_CONFIG_DIR: ccConfig },
      });
      expect(exit).toBe(0);
      expect(stdout).not.toContain("machine-global (user-scope) plexus@plexus");
    } finally {
      rmSync(ccConfig, { recursive: true, force: true });
    }
  });

  it("WITHOUT the stubbed registry, no migration hint is printed (no false alarm)", async () => {
    const { exit, stdout } = await runInstall({ cwd: projectDir });
    expect(exit).toBe(0);
    expect(stdout).not.toContain("machine-global (user-scope) plexus@plexus");
  });
});

// ── Re-paste with a live PAT (agent-integration-project-scope §3.7) ─────────────────────────────
// Registration is per-project but enrollment is once-per-agent: pasting the SAME install command
// in a SECOND project carries the already-consumed one-time code. The installer must recognize
// the live PAT and skip the redeem entirely — no scary "did not complete" error, no stale .enroll
// scratch — while step 4 (registration into the new project) still runs.
describe("D2 — re-paste in a second project: a live PAT skips the redeem, registration still runs", () => {
  it("prints the already-enrolled line, leaves no scratch, never touches the PAT, and still registers", async () => {
    // A fresh isolated home pre-seeded with a live PAT (what the FIRST paste left behind) — with
    // sentinel content, so any enroll that DID reach the gateway (rewriting the file) or any
    // scratch write is detectable byte-for-byte.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plexus-d2-repaste-home-")));
    const secondProject = realpathSync(mkdtempSync(join(tmpdir(), "plexus-d2-repaste-proj-")));
    const sentinel = "plx_agent_sentinel_must_survive_repaste\n";
    try {
      mkdirSync(join(home, "agents"), { recursive: true });
      const patFile = join(home, "agents", `${AGENT_ID}.pat`);
      writeFileSync(patFile, sentinel, { mode: 0o600 });

      const installSh = await (await get(`/integration/${AGENT_ID}/install.sh`)).text();
      const proc = Bun.spawn(["bash", "-s"], {
        cwd: secondProject,
        env: {
          PATH: `${stubBin}:${process.env.PATH ?? ""}`,
          HOME: home,
          PLEXUS_HOME: home,
          PLEXUS_GATEWAY: booted.baseUrl,
          // The code riding a re-pasted command is single-use and long gone server-side; the
          // guard must skip BEFORE ever looking at it, so any non-empty value proves the point.
          PLEXUS_ENROLL_CODE: "plx_enroll_consumed_by_the_first_paste",
        },
        stdin: Buffer.from(installSh, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      expect(exit).toBe(0);

      // The friendly one-liner — including the rotation escape hatch.
      expect(stdout).toContain(
        `plexus install: agent '${AGENT_ID}' is already enrolled here — keeping the existing credential; ` +
          `to re-enroll with a new code, remove ${patFile} and re-run.`,
      );

      // The redeem never ran: no enroll reached the gateway (a redeem of this dead code would have
      // failed → the loud error + a stale 0600 scratch), no success line, and the PAT is untouched.
      expect(stderr).not.toContain("enrollment did not complete");
      expect(stdout).not.toContain("plexus install: enrolled agent");
      expect(existsSync(join(home, "agents", `${AGENT_ID}.enroll`))).toBe(false);
      expect(readFileSync(patFile, "utf8")).toBe(sentinel);

      // Step 4 still ran — the plugin registered into THIS (second) project.
      const dir = join(home, "plugins", `plexus@${AGENT_ID}`);
      expect(existsSync(join(dir, "bin", "plexus"))).toBe(true);
      const log = readFileSync(claudeLog, "utf8");
      expect(log).toContain(`plugin marketplace add ${dir} --scope local`);
      expect(stdout).toContain(`plexus install: installed into project ${secondProject}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(secondProject, { recursive: true, force: true });
    }
  });
});
