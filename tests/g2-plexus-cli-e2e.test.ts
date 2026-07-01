/**
 * G2-SCRIPTS — drive the self-contained `tools/plexus-cli/plexus` call-script END-TO-END
 * against a REAL booted gateway, exactly as a compiled CC-plugin agent would over Bash.
 *
 * This is the executable proof for the "eat the ugliness" script (agent-skill-compile §4,
 * Inv III/VI):
 *
 *   1. `plexus enroll <one-time-code>`  redeems the code over HTTP -> durable PAT, and
 *      SELF-STORES it at <clientHome>/agents/<agentId>.pat (0600) — never baked into the
 *      distributable script dir.
 *   2. `plexus <capabilityId> <path>`   reads ONLY that local PAT, runs the whole hidden
 *      chain (handshake with Bearer PAT -> standing scoped token -> invoke) driven from the
 *      Floor, and prints JUST the real note content.
 *   3. Inv III proof: the script is run with a client home that has NO connection-key; it
 *      succeeds on the PAT alone, never creates/reads a connection-key, and its source
 *      references the admin key nowhere.
 *
 * The script runs under `node` (NOT bun) to prove the engine-self-containment choice:
 * zero-dependency, single-file, no `bun` assumption (cc-plugin-artifact-spec §6 risk #2).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

const CLI_BIN = join(import.meta.dir, "..", "tools", "plexus-cli", "plexus");
const CLI_DIR = join(import.meta.dir, "..", "tools", "plexus-cli");
const AGENT_ID = "cc-agent-g2";
const NOTE_TEXT = "The plexus CLI script read THIS note via the hidden auth chain.";

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
  enrollCode: string;
  cleanup: () => void;
}

let booted: Booted;
let clientHome: string;
let server: ReturnType<typeof Bun.serve>;

/** Boot a real gateway + a read-only vault, mint an enrollment code, persist a STANDING grant. */
async function bootGateway(): Promise<Booted> {
  const serverHome = mkdtempSync(join(tmpdir(), "plexus-g2-server-"));
  process.env.PLEXUS_HOME = serverHome;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  // A real vault with a real note the CLI will read end-to-end.
  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-g2-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(join(vaultPath, "Projects", "Plexus.md"), `# Plexus\n${NOTE_TEXT}\n`);

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  // Admin-time provisioning: mint the agent's one-time enrollment code (the CLI redeems it),
  // and grant the selected cap-set as a STANDING grant (this IS the human approval, done once).
  const { code } = state.agentEnrollment.mintEnrollmentCode(AGENT_ID);
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
    enrollCode: code,
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

/**
 * Run the CLI as a subprocess under `node` (proving no-bun engine self-containment), with a
 * CLIENT home that is SEPARATE from the gateway's server home and holds NO connection-key.
 */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", CLI_BIN, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: clientHome,
      PLEXUS_HOME: clientHome, // the agent's OWN store — no connection-key lives here.
      PLEXUS_GATEWAY: booted.baseUrl,
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
  clientHome = mkdtempSync(join(tmpdir(), "plexus-g2-client-"));
});

afterAll(() => {
  booted?.cleanup();
  if (clientHome) rmSync(clientHome, { recursive: true, force: true });
  delete process.env.PLEXUS_HOME;
});

describe("G2 plexus CLI — enroll (redeem code -> self-stored PAT, never baked)", () => {
  it("redeems the one-time code and stores the PAT at <home>/agents/<agentId>.pat (0600)", async () => {
    const { code, stdout, stderr } = await runCli(["enroll", booted.enrollCode]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain(`Enrolled as '${AGENT_ID}'`);

    const patFile = join(clientHome, "agents", `${AGENT_ID}.pat`);
    expect(existsSync(patFile)).toBe(true);
    const pat = readFileSync(patFile, "utf8").trim();
    expect(pat.startsWith("plx_agent_")).toBe(true);
  });

  it("the PAT is NOT baked into the distributable script dir (tools/plexus-cli)", () => {
    // No credential file, and no PAT/enroll literal, ever lands in the shippable dir.
    const files = readdirSync(CLI_DIR);
    expect(files.some((f) => f.endsWith(".pat"))).toBe(false);
    const src = readFileSync(CLI_BIN, "utf8");
    expect(src).not.toContain("plx_agent_x"); // no literal PAT baked
    // The only allowed occurrences of the prefixes are the shape checks (constants), not a real value.
    expect(src.includes(readFileSync(join(clientHome, "agents", `${AGENT_ID}.pat`), "utf8").trim())).toBe(false);
  });

  it("a bad enrollment code fails cleanly and points at the sanctioned path (no forgery hint)", async () => {
    const { code, stderr } = await runCli(["enroll", "plx_enroll_totally-bogus"]);
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("rejected");
    expect(stderr.toLowerCase()).toContain("one-time code");
    // Never tells the caller to forge/self-mint or to read an admin key.
    expect(stderr.toLowerCase()).not.toContain("connection-key");
    expect(stderr.toLowerCase()).not.toContain("forge");
  });
});

describe("G2 plexus CLI — native call (hidden handshake->token->invoke over a standing grant)", () => {
  it("prints JUST the real note content for `plexus <cap> <path>` (positional -> io schema)", async () => {
    const { code, stdout, stderr } = await runCli([VAULT_READ_ID, "Projects/Plexus.md"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    // The result, and ONLY the result — none of the redeem/handshake/token plumbing leaks.
    expect(stdout).toContain(NOTE_TEXT);
    expect(stdout).not.toContain("Bearer");
    expect(stdout).not.toContain("sessionId");
    expect(stdout).not.toContain("plx_agent_");
  });

  it("--json returns a real InvokeResponse with ok:true", async () => {
    const { code, stdout } = await runCli([VAULT_READ_ID, "path=Index.md", "--json"]);
    expect(code).toBe(0);
    const res = JSON.parse(stdout) as { id: string; ok: boolean; output?: { content?: string }; auditId: string };
    expect(res.ok).toBe(true);
    expect(res.id).toBe(VAULT_READ_ID);
    expect(res.output?.content ?? "").toContain("Welcome to the demo vault.");
    expect(res.auditId.length).toBeGreaterThan(0);
  });
});

describe("G2 plexus CLI — Inv III: only the agent's own PAT, never the connection-key", () => {
  it("succeeds on the PAT alone and never materializes a connection-key in the client home", () => {
    // The gateway's connection-key lives in the SERVER home; the client home the CLI used holds
    // ONLY the agent store — proof the script authenticated purely with its own PAT.
    expect(existsSync(join(booted.serverHome, "connection-key"))).toBe(true); // server has one…
    expect(existsSync(join(clientHome, "connection-key"))).toBe(false); // …the client never did.
  });

  it("the script never presents a connection-key credential (no wire field, no key value)", () => {
    // The script's PROSE steers the agent AWAY from the admin key (good hygiene), but it must
    // never PRESENT one: it never sends the `connectionKey` wire body field, never sends the
    // `X-Plexus-Connection-Key` header, and never handles a `plx_live_` key value.
    const src = readFileSync(CLI_BIN, "utf8");
    expect(src).not.toContain("connectionKey"); // the wire body field an admin would send
    expect(src.toLowerCase()).not.toContain("x-plexus-connection-key"); // the mgmt header
    expect(src).not.toContain("plx_live_"); // the connection-key value prefix
  });
});

describe("G2 plexus CLI — F1: --purpose is a real flag (clean invoke input + threads to narration)", () => {
  it("(F1a) `--purpose` is parsed as a flag, NOT a positional — the invoke input stays uncorrupted", async () => {
    // Old bug: --purpose fell through to POSITIONAL args, so `plexus <cap> <path> --purpose "x"`
    // sent 3 positionals to a 1-field schema → error/corruption. It must now be consumed, leaving
    // the SAME clean single-field input, so the standing-grant read succeeds and returns the note.
    const { code, stdout, stderr } = await runCli([
      VAULT_READ_ID,
      "Projects/Plexus.md",
      "--purpose",
      "reading the note to answer the user",
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain(NOTE_TEXT);
    // …and the flag placed BEFORE the positional is equally clean (order-independent parsing).
    const pre = await runCli([VAULT_READ_ID, "--purpose", "same, flag first", "Index.md"]);
    expect(pre.code).toBe(0);
    expect(pre.stdout).toContain("Welcome to the demo vault.");
  });

  it("(F1b) a `--purpose` on a call that must PEND reaches the owner-facing pending narration", async () => {
    // A gateway with the SAME vault but NO standing grant → an extension read PENDS (awaits the
    // owner). Drive the real CLI subprocess with --purpose and prove the purpose threaded through
    // the grant request into the gateway-authored pending narration + PendingView.agentPurpose.
    const serverHome = mkdtempSync(join(tmpdir(), "plexus-g2p-server-"));
    const prevHome = process.env.PLEXUS_HOME;
    const prevConfirm = process.env.PLEXUS_CONFIRM_MODE;
    process.env.PLEXUS_HOME = serverHome;
    // Pend EVERY grant (even a low-risk read) so the --purpose call reaches the human-approval
    // path where the purpose is surfaced. Without this, a first-party read auto-allows.
    process.env.PLEXUS_CONFIRM_MODE = "confirm-all";
    _resetSecretCacheForTests();

    const port = await pickFreePort();
    const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
    const { app, state } = createAppWithState(config);

    const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-g2p-vault-"));
    const vaultPath = join(vaultRoot, "DemoVault");
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(vaultPath, "Index.md"), "# Index\n");
    const { manifest, handlers } = openVaultExtension(vaultPath);
    const reg = await state.capabilities.registerExtension(manifest, { handlers });
    if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

    const PENDING_AGENT = "cc-p";
    const { code: enrollCode } = state.agentEnrollment.mintEnrollmentCode(PENDING_AGENT);
    // NB: NO state.grants.put(...) — so the read is not standing and must pend.

    const pServer = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
    const pBaseUrl = configBaseUrl(config);
    const pClientHome = mkdtempSync(join(tmpdir(), "plexus-g2p-client-"));

    const runPending = async (args: string[]) => {
      const proc = Bun.spawn(["node", CLI_BIN, ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: pClientHome,
          PLEXUS_HOME: pClientHome,
          PLEXUS_GATEWAY: pBaseUrl,
          PLEXUS_AGENT_ID: PENDING_AGENT,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      return { code: exit, stdout, stderr };
    };

    try {
      const enrolled = await runPending(["enroll", enrollCode]);
      expect(enrolled.code).toBe(0);

      const PURPOSE = "collect release notes";
      const called = await runPending([VAULT_READ_ID, "Index.md", "--purpose", PURPOSE]);
      // The call PENDS (owner must approve) — exit 75, and it must NOT corrupt into a bad request.
      expect(called.code).toBe(75);
      expect(called.stderr.toLowerCase()).toContain("approval");

      // The gateway-side pending record carries the purpose the CLI sent.
      const res = await fetch(`${pBaseUrl}/admin/api/pending`, {
        headers: { "X-Plexus-Connection-Key": state.connectionKey.current() },
      });
      const body = (await res.json()) as {
        pending: { agentId?: string; agentPurpose?: string; pendingNarration?: { id: string; notificationLine?: string }[] }[];
      };
      const item = body.pending.find((p) => p.agentId === PENDING_AGENT);
      expect(item).toBeDefined();
      // (1) purpose surfaced on the PendingView, verbatim (the CLI threaded it end-to-end).
      expect(item!.agentPurpose).toBe(PURPOSE);
      // (2) it is folded into the gateway-authored one-line narration too (AUTHZ-UX §2.N2).
      const n = item!.pendingNarration?.find((x) => x.id === VAULT_READ_ID);
      expect(n?.notificationLine ?? "").toContain(PURPOSE);
    } finally {
      try {
        pServer.stop(true);
      } catch {
        /* ignore */
      }
      rmSync(serverHome, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
      rmSync(pClientHome, { recursive: true, force: true });
      if (prevHome) process.env.PLEXUS_HOME = prevHome;
      else delete process.env.PLEXUS_HOME;
      if (prevConfirm) process.env.PLEXUS_CONFIRM_MODE = prevConfirm;
      else delete process.env.PLEXUS_CONFIRM_MODE;
    }
  });
});
