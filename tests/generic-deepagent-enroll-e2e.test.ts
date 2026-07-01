/**
 * generic-deepagent-enroll-e2e (GEN-DEEP) — the executable proof of Inv II.
 *
 * Drives the pomodoro-demo DEEPAGENT's GENERIC (no-bespoke-skill) integration path
 * (agent-skill-compile §5) end-to-end against a REAL booted gateway, exactly as a
 * skill-less agent would. NO SKILL.md is compiled; the agent self-integrates from the
 * FLOOR (`.well-known/plexus`) alone:
 *
 *   admin (config-time, in-process here):  mint a one-time enrollment code for `agentId`
 *                                          + grant it a STANDING cap-set (ADR-5).
 *   agent (first run, real subprocess):    GET /.well-known → follow auth.enrollment →
 *                                          POST code → its OWN PAT (stored in an .env) →
 *                                          handshake (Bearer PAT) → invoke the granted cap.
 *
 * The agent side is the ACTUAL Python client the deepagent uses
 * (`plexus_deepagents.connect_generic` → `PlexusClient.enroll/handshake/invoke`), run as a
 * subprocess via `generic_enroll_probe.py` over real HTTP. Asserts, mechanically:
 *
 *   - the Floor self-describes enrollment (auth.enrollment: redeem shape + patStorage);
 *   - the agent redeems code→PAT (a `plx_agent_…`), stores it in its own `.env`;
 *   - it invokes a STANDING-granted capability and gets REAL data back — no owner step,
 *     no pend (the standing grant short-circuits), no compiled skill;
 *   - it NEVER holds/uses the admin connection-key (Inv III): the subprocess env carries
 *     none, and the generic client has no connection-key on this path;
 *   - the one-time code is SINGLE-USE (a replay is rejected);
 *   - a SECOND run with NO code REUSES the stored PAT (durable per-agent credential).
 *
 * The full LLM-driven agent loop is E2E-DEEP; this gate proves the integration/auth path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";
import type { WellKnownDocument } from "@plexus/protocol";

const AGENT_ID = "pomodoro-deepagent";
const NOTE_REL = "Projects/Plexus.md";
const NOTE_BODY =
  "The generic deepagent read THIS note via the FLOOR — self-enrolled, no bespoke skill.\n";

/** The pomodoro-demo dir + the standalone generic-path probe the deepagent's client backs. */
const DEMO_DIR = join(import.meta.dir, "..", "examples", "pomodoro-demo");
const PROBE = join(DEMO_DIR, "generic_enroll_probe.py");

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
  code: string;
  connectionKey: string;
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;
let envDir: string;

/** Boot a real gateway + provision {agentId, one-time code, STANDING grant} as the admin. */
async function bootGateway(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "plexus-gendeep-home-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  // A real read-only vault capability to invoke through the primary gateway.
  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-gendeep-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\n");
  writeFileSync(join(vaultPath, NOTE_REL), NOTE_BODY);
  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  // ADMIN, config-time (Inv I): mint the agent's one-time enrollment code …
  const { code } = state.agentEnrollment.mintEnrollmentCode(AGENT_ID);
  // … and grant it the cap-set STANDING (ADR-5): a durable, unexpired, short-circuiting
  // grant for (agentId, capabilityId). This is the human approval, done ONCE, admin-time —
  // so the agent's PUT /grants short-circuits to a scoped token with no owner step.
  const now = Date.now();
  state.grants.put({
    agentId: AGENT_ID,
    capabilityId: VAULT_READ_ID,
    verbs: ["read"],
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    standing: true,
  });

  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  const base = configBaseUrl(config);

  return {
    baseUrl: base,
    home,
    code,
    connectionKey: state.connectionKey.current(),
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

interface ProbeResult {
  ok: boolean;
  output?: unknown;
  agentId?: string;
  sessionId?: string;
  patPrefix?: string;
  patStored?: boolean;
  usedConnectionKey?: boolean;
  connectionKeyPresentInEnv?: boolean;
  reusedStoredPat?: boolean;
  error?: { code: string; message: string };
}

/** Run the generic-path probe as a subprocess. The agent env carries NO connection-key. */
async function runProbe(
  args: string[],
): Promise<{ code: number; result: ProbeResult; stdout: string; stderr: string }> {
  // A CLEAN environment: strip PLEXUS_CONNECTION_KEY + PLEXUS_HOME so the generic agent
  // categorically cannot reach the admin credential (Inv III) — it has only its code/.env.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "PLEXUS_CONNECTION_KEY" || k === "PLEXUS_HOME") continue;
    env[k] = v;
  }
  const proc = Bun.spawn(["python3", PROBE, "--url", booted.baseUrl, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  let result: ProbeResult;
  try {
    result = JSON.parse(lastLine) as ProbeResult;
  } catch {
    throw new Error(`probe emitted non-JSON stdout:\n${stdout}\n--- stderr ---\n${stderr}`);
  }
  return { code, result, stdout, stderr };
}

beforeAll(async () => {
  booted = await bootGateway();
  envDir = mkdtempSync(join(tmpdir(), "plexus-gendeep-env-"));
});

afterAll(() => {
  booted?.cleanup();
  try {
    rmSync(envDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.PLEXUS_HOME;
});

describe("GEN-DEEP — the Floor self-describes enrollment (what a skill-less agent reads)", () => {
  it("advertises auth.enrollment: redeem shape (code→pat/agentId) + patStorage guidance", async () => {
    const res = await fetch(`${booted.baseUrl}/.well-known/plexus`, {
      headers: { host: new URL(booted.baseUrl).host },
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as WellKnownDocument;
    const enrollment = (doc.auth as Record<string, any>).enrollment;
    expect(enrollment).toBeDefined();
    expect(enrollment.url).toContain("/agents/enroll");
    // The load-bearing body field name + the success shape a generic agent constructs from.
    expect(Object.keys(enrollment.body)).toContain("code");
    expect(enrollment.success).toMatchObject({ pat: expect.any(String), agentId: expect.any(String) });
    expect(typeof enrollment.patStorage).toBe("string");
    // Handshake address is present so the agent knows where to present its minted PAT.
    expect((doc.auth as Record<string, any>).handshakeUrl).toContain("/link/handshake");
  });
});

describe("GEN-DEEP — generic base-mode: self-enroll from the Floor → PAT → invoke", () => {
  it("redeems its code→PAT, stores it in .env, and invokes a standing-granted cap (no skill, no key)", async () => {
    const envPath = join(envDir, "agent.env");
    const { code, result, stderr } = await runProbe([
      "--cap",
      VAULT_READ_ID,
      "--code",
      booted.code,
      "--input",
      JSON.stringify({ path: NOTE_REL }),
      "--env",
      envPath,
    ]);

    expect(result.ok, `probe failed: ${JSON.stringify(result.error)}\nstderr:\n${stderr}`).toBe(true);
    expect(code).toBe(0);

    // The session bound to the PAT's REAL agentId (not a self-asserted string).
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.sessionId).toMatch(/^sess_/);

    // It authenticated with its OWN per-agent PAT — a `plx_agent_…` — self-stored in .env.
    expect(result.patStored).toBe(true);
    expect(result.patPrefix).toBe("plx_agent_");
    expect(existsSync(envPath)).toBe(true);
    const envText = readFileSync(envPath, "utf-8");
    expect(envText).toContain("PLEXUS_AGENT_PAT=plx_agent_");

    // Inv III: the agent never held/used the admin connection-key.
    expect(result.usedConnectionKey).toBe(false);
    expect(result.connectionKeyPresentInEnv).toBe(false);
    // And the stored PAT is NOT the connection-key.
    expect(envText).not.toContain(booted.connectionKey);

    // The standing grant short-circuited → REAL note data came back (invoke through the
    // primary gateway), with no owner approval step and no compiled SKILL.md anywhere.
    const output = result.output as { content?: string; text?: string; data?: unknown };
    const flat = JSON.stringify(output);
    expect(flat).toContain("read THIS note via the FLOOR");
  });

  it("the one-time code is SINGLE-USE — a replay is rejected", async () => {
    const envPath = join(envDir, "replay.env");
    const { result } = await runProbe([
      "--cap",
      VAULT_READ_ID,
      "--code",
      booted.code, // already consumed by the first test
      "--input",
      JSON.stringify({ path: NOTE_REL }),
      "--env",
      envPath,
    ]);
    expect(result.ok).toBe(false);
    // The enrollment surface's typed reason for a spent/unknown code.
    expect(["code_consumed", "unknown_code"]).toContain(result.error?.code as string);
    expect(existsSync(envPath)).toBe(false);
  });

  it("a SECOND run REUSES the stored PAT (no code) — durable per-agent credential", async () => {
    // Reuse the .env the first successful run wrote (its stored PAT).
    const envPath = join(envDir, "agent.env");
    expect(existsSync(envPath)).toBe(true);
    const { result, stderr } = await runProbe([
      "--cap",
      VAULT_READ_ID,
      // NO --code: it must load the stored PAT and re-authenticate.
      "--input",
      JSON.stringify({ path: NOTE_REL }),
      "--env",
      envPath,
    ]);
    expect(result.ok, `reuse failed: ${JSON.stringify(result.error)}\nstderr:\n${stderr}`).toBe(true);
    expect(result.reusedStoredPat).toBe(true);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.usedConnectionKey).toBe(false);
    const flat = JSON.stringify(result.output);
    expect(flat).toContain("read THIS note via the FLOOR");
  });
});
