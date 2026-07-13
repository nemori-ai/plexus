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

import type { ExtensionManifest } from "@plexus/protocol";
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
    // AUTHORIZED-SUBSET (fail-closed): no subset record = authorized NOTHING (deny, not
    // pend). Declare the read in the agent's subset so the call PENDS — the purpose
    // threading under test — rather than being subset-denied.
    state.agentSubsets.set(PENDING_AGENT, [VAULT_READ_ID]);
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
      // --no-wait: fail fast instead of the default wait-and-poll (the test IS the owner
      // who never approves; without it the call would rightly sit polling for approval).
      const called = await runPending([VAULT_READ_ID, "Index.md", "--purpose", PURPOSE, "--no-wait"]);
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

describe("G2 plexus CLI — WAIT-AND-APPROVE: a pending call blocks, then invokes on approval", () => {
  it("call → PENDS → owner approves out-of-band → the SAME process invokes with the minted token", async () => {
    // The call-once-and-wait contract: the CLI must NOT exit on grant_pending_user (a
    // re-run can never work for once-capped approvals — nothing consumes the minted
    // token). It polls the advertised statusUrl and invokes the moment the owner approves.
    const serverHome = mkdtempSync(join(tmpdir(), "plexus-g2w-server-"));
    const prevHome = process.env.PLEXUS_HOME;
    const prevConfirm = process.env.PLEXUS_CONFIRM_MODE;
    process.env.PLEXUS_HOME = serverHome;
    process.env.PLEXUS_CONFIRM_MODE = "confirm-all"; // pend EVERY grant (even a low-risk read)
    _resetSecretCacheForTests();

    const port = await pickFreePort();
    const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
    const { app, state } = createAppWithState(config);

    const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-g2w-vault-"));
    const vaultPath = join(vaultRoot, "DemoVault");
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(vaultPath, "Index.md"), "# Waited-for content\n");
    const { manifest, handlers } = openVaultExtension(vaultPath);
    const reg = await state.capabilities.registerExtension(manifest, { handlers });
    if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

    const WAIT_AGENT = "cc-wait";
    const { code: enrollCode } = state.agentEnrollment.mintEnrollmentCode(WAIT_AGENT);
    // AUTHORIZED-SUBSET (fail-closed): declare the read in the agent's subset so the
    // call PENDS (the wait-and-approve loop under test) instead of being subset-denied.
    state.agentSubsets.set(WAIT_AGENT, [VAULT_READ_ID]);

    const wServer = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
    const wBaseUrl = configBaseUrl(config);
    const wClientHome = mkdtempSync(join(tmpdir(), "plexus-g2w-client-"));
    const spawnCli = (args: string[]) =>
      Bun.spawn(["node", CLI_BIN, ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: wClientHome,
          PLEXUS_HOME: wClientHome,
          PLEXUS_GATEWAY: wBaseUrl,
          PLEXUS_AGENT_ID: WAIT_AGENT,
          PLEXUS_APPROVAL_WAIT_MS: "30000",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

    try {
      const enrollProc = spawnCli(["enroll", enrollCode]);
      expect(await enrollProc.exited).toBe(0);

      // Launch the call WITHOUT awaiting: it must sit in the poll loop, not exit 75.
      const callProc = spawnCli([VAULT_READ_ID, "Index.md"]);

      // Owner side: wait for the pend to surface, then approve it via the admin API.
      let pendingId: string | undefined;
      for (let i = 0; i < 40 && !pendingId; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const res = await fetch(`${wBaseUrl}/admin/api/pending`, {
          headers: { "X-Plexus-Connection-Key": state.connectionKey.current() },
        });
        const body = (await res.json()) as { pending: { pendingId: string; agentId?: string }[] };
        pendingId = body.pending.find((p) => p.agentId === WAIT_AGENT)?.pendingId;
      }
      expect(pendingId).toBeDefined();
      const approve = await fetch(`${wBaseUrl}/admin/api/pending/${pendingId}`, {
        method: "POST",
        headers: {
          "X-Plexus-Connection-Key": state.connectionKey.current(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "approve", agentId: WAIT_AGENT, trustWindow: { kind: "once" } }),
      });
      expect(approve.status).toBe(200);

      // The SAME waiting process must now complete the invoke with the minted token.
      const stdout = await new Response(callProc.stdout).text();
      const stderr = await new Response(callProc.stderr).text();
      expect(await callProc.exited).toBe(0);
      expect(stdout).toContain("Waited-for content");
      expect(stderr).toContain("awaiting the owner's approval");
    } finally {
      try {
        wServer.stop(true);
      } catch {
        /* ignore */
      }
      rmSync(serverHome, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
      rmSync(wClientHome, { recursive: true, force: true });
      if (prevHome) process.env.PLEXUS_HOME = prevHome;
      else delete process.env.PLEXUS_HOME;
      if (prevConfirm) process.env.PLEXUS_CONFIRM_MODE = prevConfirm;
      else delete process.env.PLEXUS_CONFIRM_MODE;
    }
  });
});

describe("G2 plexus CLI — discover: `plexus list` (grant-status annotated, auth hidden)", () => {
  // The DISCOVERY verb: an enrolled agent asking "what can I do right now?" gets a native answer
  // WITHOUT hand-rolling HTTP. It authenticates the SAME hidden way as invoke, then annotates each
  // capability as callable-now (standing grant) vs needs-approval (not yet granted). This boots its
  // own gateway with a two-cap extension: one read cap granted STANDING (callable now), one write
  // cap left UN-granted (must surface with a needs-approval marker).
  const DEMO_READ = "demo.doc.read";
  const DEMO_WRITE = "demo.doc.write";
  const DEMO_EXT: ExtensionManifest = {
    manifest: "plexus-extension/0.1",
    source: "demo",
    label: "Demo docs",
    transport: "cli",
    capabilities: [
      {
        name: "doc.read",
        kind: "capability",
        label: "Read a demo doc",
        describe: "Read a demo document by name. Use to fetch existing content.",
        io: { input: { type: "object", properties: { name: { type: "string" } } } },
        grants: ["read"],
        transport: "cli",
        route: { bin: "true", args: ["{name}"] },
      },
      {
        name: "doc.write",
        kind: "capability",
        label: "Write a demo doc",
        describe: "Create or overwrite a demo document. Use to persist content.",
        io: { input: { type: "object", properties: { name: { type: "string" }, body: { type: "string" } } } },
        grants: ["write"],
        transport: "cli",
        route: { bin: "true", args: ["{name}"] },
      },
    ],
  };

  let dServer: ReturnType<typeof Bun.serve>;
  let dServerHome: string;
  let dClientHome: string;
  let dBaseUrl: string;
  const DEMO_AGENT = "cc-list";

  const runDemo = async (args: string[]) => {
    const proc = Bun.spawn(["node", CLI_BIN, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dClientHome,
        PLEXUS_HOME: dClientHome,
        PLEXUS_GATEWAY: dBaseUrl,
        PLEXUS_AGENT_ID: DEMO_AGENT,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { code: exit, stdout, stderr };
  };

  beforeAll(async () => {
    dServerHome = mkdtempSync(join(tmpdir(), "plexus-g2l-server-"));
    const prevHome = process.env.PLEXUS_HOME;
    process.env.PLEXUS_HOME = dServerHome;
    _resetSecretCacheForTests();

    const port = await pickFreePort();
    const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
    const { app, state } = createAppWithState(config);

    const reg = await state.capabilities.registerExtension(DEMO_EXT);
    if (!reg.ok) throw new Error(`failed to register demo extension: ${reg.reason}`);

    const { code } = state.agentEnrollment.mintEnrollmentCode(DEMO_AGENT);
    const now = Date.now();
    // AUTHORIZED-SUBSET (fail-closed): the agent's manifest shows ONLY its owner-declared
    // subset. Declare BOTH caps so `list` can bucket them (read = callable-now via the
    // standing grant below; write = needs-approval) — the discovery UX under test.
    state.agentSubsets.set(DEMO_AGENT, [DEMO_READ, DEMO_WRITE]);
    // Standing grant for the READ cap ONLY — the WRITE cap is deliberately left ungranted.
    state.grants.put({
      agentId: DEMO_AGENT,
      capabilityId: DEMO_READ,
      verbs: ["read"],
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      trustWindow: { kind: "7d" },
      standing: true,
    });

    dServer = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
    dBaseUrl = configBaseUrl(config);
    dClientHome = mkdtempSync(join(tmpdir(), "plexus-g2l-client-"));
    if (prevHome) process.env.PLEXUS_HOME = prevHome;
    else delete process.env.PLEXUS_HOME;

    const enrolled = await runDemo(["enroll", code]);
    if (enrolled.code !== 0) throw new Error(`demo enroll failed: ${enrolled.stderr}`);
  });

  afterAll(() => {
    try {
      dServer?.stop(true);
    } catch {
      /* ignore */
    }
    if (dServerHome) rmSync(dServerHome, { recursive: true, force: true });
    if (dClientHome) rmSync(dClientHome, { recursive: true, force: true });
  });

  it("groups granted caps under CALLABLE NOW and ungranted ones under NEEDS APPROVAL", async () => {
    const { code, stdout, stderr } = await runDemo(["list"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    // Both sections render, and each cap lands in the right bucket (positional check).
    const callableAt = stdout.indexOf("CALLABLE NOW");
    const needsAt = stdout.indexOf("NEEDS APPROVAL");
    expect(callableAt).toBeGreaterThanOrEqual(0);
    expect(needsAt).toBeGreaterThan(callableAt);

    const readAt = stdout.indexOf(DEMO_READ);
    const writeAt = stdout.indexOf(DEMO_WRITE);
    expect(readAt).toBeGreaterThan(callableAt); // granted read → callable-now section
    expect(readAt).toBeLessThan(needsAt);
    expect(writeAt).toBeGreaterThan(needsAt); // ungranted write → needs-approval section

    // The needs-approval cap carries a distinct marker (○) vs the callable one (●).
    expect(stdout).toContain("●");
    expect(stdout).toContain("○");

    // Auth stays hidden — no PAT, session, or bearer plumbing ever reaches stdout.
    expect(stdout).not.toContain("Bearer");
    expect(stdout).not.toContain("plx_agent_");
    expect(stdout).not.toContain("sessionId");
    expect(stdout).not.toContain("X-Plexus-Session");
  });

  it("--json emits a callable flag per capability (read: true, write: false)", async () => {
    const { code, stdout } = await runDemo(["list", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as {
      agent?: string;
      gateway: string;
      capabilities: { id: string; verbs: string[]; callable: boolean }[];
    };
    expect(doc.agent).toBe(DEMO_AGENT);
    const read = doc.capabilities.find((c) => c.id === DEMO_READ);
    const write = doc.capabilities.find((c) => c.id === DEMO_WRITE);
    expect(read?.callable).toBe(true);
    expect(read?.verbs).toEqual(["read"]);
    expect(write?.callable).toBe(false);
    expect(write?.verbs).toEqual(["write"]);
    // No credential leaks into the machine-readable form either.
    expect(stdout).not.toContain("plx_agent_");
  });

  it("without a stored PAT, `list` fails closed with the sanctioned enroll guidance (no auth guessing)", async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "plexus-g2l-noPat-"));
    try {
      const proc = Bun.spawn(["node", CLI_BIN, "list"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: emptyHome,
          PLEXUS_HOME: emptyHome, // no agents/*.pat here
          PLEXUS_GATEWAY: dBaseUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      expect(exit).not.toBe(0);
      expect(stderr.toLowerCase()).toContain("enroll");
      // It points at the sanctioned path, never at forging/self-minting a credential.
      expect(stderr.toLowerCase()).not.toContain("forge");
      expect(stderr.toLowerCase()).not.toContain("mint");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
