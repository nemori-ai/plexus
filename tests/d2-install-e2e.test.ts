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
 * HERMETIC and non-destructive to the developer's real `~/.claude` config (a real `claude` on
 * PATH would mutate it under `--scope user`), we put a STUB `claude` on PATH that records its
 * argv. We assert install.sh invokes it with `plugin marketplace add` + `plugin install`. The
 * gateway-pin + file-materialization + enroll (which are useful even without Claude Code) run
 * BEFORE and INDEPENDENTLY of that step, so `plexus <cap>` works regardless — proven here.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
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
  clientHome = mkdtempSync(join(tmpdir(), "plexus-d2-client-"));

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

    // (7) The claude-plugin-registration step invoked the CLI with the right verbs (recorded by the stub).
    expect(existsSync(claudeLog)).toBe(true);
    const log = readFileSync(claudeLog, "utf8");
    expect(log).toContain(`plugin marketplace add ${dir}`);
    expect(log).toContain("plugin install plexus@plexus --scope user");
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
