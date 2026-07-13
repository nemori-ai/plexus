/**
 * workspace-dir `approval:"ask"` — the PROTECTED-FOLDER posture, END-TO-END through
 * the REAL engine (`tools/plexus-cli/plexus` as a `node` subprocess against a booted
 * gateway — the exact script a compiled agent runs; no mocks).
 *
 * Two managed workspace-dir instances on ONE gateway:
 *   - `docs-auto` (default posture)  — a managed READ auto-allows (today's behavior);
 *   - `docs-ask`  (approval:"ask")   — EVERY verb pends for the owner on first use.
 *
 * Pins:
 *   1. PER-INSTANCE posture: the same agent, the same verb (read), the same kind —
 *      auto instance answers immediately; ask instance PENDS.
 *   2. APPROVE path: the waiting CLI process completes with the real file content the
 *      moment the owner approves (trust window chosen on the approval card: "once").
 *   3. DENY path: a later call pends again ("once" never stands); the owner DENIES;
 *      the CLI exits 77 with the owner-denied message (the sanctioned dead end).
 *   4. The denial lands in the audit trail as `grant.deny` WITH `detail.reason`
 *      (the data the Activity view's deny row renders).
 *   5. "ask" only TIGHTENS: an approved standing grant (owner picks "1h") re-uses
 *      without re-pending — hasPriorApproval still short-circuits.
 *
 * Isolated homes (gateway home ≠ agent home), throwaway dirs, no ~/.plexus.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { bootScanCapabilities } from "@plexus/runtime/core/state.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { WORKSPACE_DIR_KIND } from "@plexus/runtime/sources/index.ts";
import type { ConfiguredSource } from "@plexus/runtime/sources/config/types.ts";

const CLI_BIN = join(import.meta.dir, "..", "tools", "plexus-cli", "plexus");
const AGENT_ID = "wsdir-ask-agent";
const AUTO_NOTE = "readable without asking — the auto posture.";
const ASK_NOTE = "the PROTECTED note — only after the owner approves.";

let server: ReturnType<typeof Bun.serve>;
let state: ReturnType<typeof createAppWithState>["state"];
let gwBaseUrl: string;
let gwHome: string;
let agentHome: string;
let rootsParent: string;

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

function spawnCli(args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawn(["node", CLI_BIN, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: agentHome,
      PLEXUS_HOME: agentHome, // the agent's OWN store — no connection-key lives here
      PLEXUS_GATEWAY: gwBaseUrl,
      PLEXUS_AGENT_ID: AGENT_ID,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawnCli(args, extraEnv);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Poll the admin pending list until THIS agent's pend for `capabilityId` appears. */
async function waitForPending(capabilityId: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const res = await fetch(`${gwBaseUrl}/admin/api/pending`, {
      headers: { "X-Plexus-Connection-Key": state.connectionKey.current() },
    });
    const body = (await res.json()) as {
      pending: { pendingId: string; state?: string; agentId?: string; capabilities?: string[] }[];
    };
    const item = body.pending.find(
      (p) =>
        p.agentId === AGENT_ID &&
        (p.state === undefined || p.state === "pending") &&
        (p.capabilities ?? []).includes(capabilityId),
    );
    if (item) return item.pendingId;
  }
  throw new Error(`no pending item surfaced for ${capabilityId}`);
}

async function resolvePending(
  pendingId: string,
  action: "approve" | "deny",
  trustWindow?: { kind: string },
): Promise<void> {
  const res = await fetch(`${gwBaseUrl}/admin/api/pending/${pendingId}`, {
    method: "POST",
    headers: {
      "X-Plexus-Connection-Key": state.connectionKey.current(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action,
      agentId: AGENT_ID,
      ...(trustWindow ? { trustWindow } : {}),
      ...(action === "deny" ? { reason: "owner said no — protected folder" } : {}),
    }),
  });
  if (res.status !== 200) throw new Error(`${action} failed: HTTP ${res.status}`);
}

beforeAll(async () => {
  gwHome = mkdtempSync(join(tmpdir(), "plexus-wsask-gw-"));
  process.env.PLEXUS_HOME = gwHome;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const built = createAppWithState(config);
  state = built.state;
  await bootScanCapabilities(state);

  // Two directory instances: same kind, different roots, different postures.
  rootsParent = mkdtempSync(join(tmpdir(), "plexus-wsask-roots-"));
  const autoRoot = join(rootsParent, "AutoDocs");
  const askRoot = join(rootsParent, "AskDocs");
  mkdirSync(autoRoot, { recursive: true });
  mkdirSync(askRoot, { recursive: true });
  writeFileSync(join(autoRoot, "open.md"), `# Open\n${AUTO_NOTE}\n`);
  writeFileSync(join(askRoot, "secret.md"), `# Guarded\n${ASK_NOTE}\n`);

  const add = async (cfg: ConfiguredSource) => {
    const res = await state.managedSources.add(cfg, { approvedByHuman: true });
    if (!res.ok) throw new Error(`add ${cfg.id} failed: ${res.reason}`);
  };
  await add({
    id: "docs-auto",
    kind: WORKSPACE_DIR_KIND,
    label: "Open docs",
    enabled: true,
    transport: "ipc",
    route: { path: autoRoot },
  });
  await add({
    id: "docs-ask",
    kind: WORKSPACE_DIR_KIND,
    label: "Guarded docs",
    enabled: true,
    transport: "ipc",
    route: { path: askRoot },
    approval: "ask",
  });

  server = Bun.serve({ fetch: built.app.fetch, hostname: config.host, port: config.port });
  gwBaseUrl = configBaseUrl(config);
  agentHome = mkdtempSync(join(tmpdir(), "plexus-wsask-agent-"));

  // AUTHORIZED-SUBSET (ADR-023, fail-closed): the owner declares the agent's subset at
  // connect; without one the agent is authorized NOTHING. Authorize every capability of
  // the two workspace-dir instances — the POSTURE (auto vs ask) is what's under test, and
  // it is orthogonal to the subset gate (a subset member with no standing grant still
  // pends per its instance's approval posture).
  state.agentSubsets.set(
    AGENT_ID,
    state.capabilities
      .summaries()
      .map((s) => s.id)
      .filter((id) => id.startsWith("docs-auto.") || id.startsWith("docs-ask.")),
  );

  // Enroll the agent with its own PAT (the owner mints the one-time code).
  const { code } = state.agentEnrollment.mintEnrollmentCode(AGENT_ID);
  const enrolled = await runCli(["enroll", code]);
  if (enrolled.code !== 0) throw new Error(`enroll failed: ${enrolled.stderr}`);
});

afterAll(() => {
  try {
    server?.stop(true);
  } catch {
    /* ignore */
  }
  for (const d of [gwHome, agentHome, rootsParent]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
  delete process.env.PLEXUS_HOME;
});

describe("workspace-dir approval — per-instance posture on one gateway", () => {
  it("the AUTO instance's read answers immediately (managed read auto-allows, no pend)", async () => {
    const { code, stdout, stderr } = await runCli(["docs-auto.read", "open.md"]);
    expect(code).toBe(0);
    expect(stdout).toContain(AUTO_NOTE);
    // It never sat waiting for an approval.
    expect(stderr).not.toContain("awaiting the owner's approval");
  }, 20000);

  it("the ASK instance's read PENDS → owner APPROVES (once) → the SAME process gets the content", async () => {
    const proc = spawnCli(["docs-ask.read", "secret.md"], { PLEXUS_APPROVAL_WAIT_MS: "30000" });

    const pendingId = await waitForPending("docs-ask.read");
    await resolvePending(pendingId, "approve", { kind: "once" });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain(ASK_NOTE);
    expect(stderr).toContain("awaiting the owner's approval");
  }, 30000);

  it("a later call pends AGAIN ('once' never stands) → owner DENIES → CLI exits 77 DENIED", async () => {
    const proc = spawnCli(["docs-ask.read", "secret.md"], { PLEXUS_APPROVAL_WAIT_MS: "30000" });

    const pendingId = await waitForPending("docs-ask.read");
    await resolvePending(pendingId, "deny");

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(77);
    expect(stderr).toContain("DENIED");
    // The protected content never leaked on the deny path.
    expect(stdout).not.toContain(ASK_NOTE);
  }, 30000);

  it("the denial is in the audit trail as grant.deny WITH detail.reason (Activity's deny row data)", async () => {
    const res = await fetch(`${gwBaseUrl}/admin/api/audit?limit=200`, {
      headers: { "X-Plexus-Connection-Key": state.connectionKey.current() },
    });
    const body = (await res.json()) as {
      events: { type: string; capabilityId?: string; detail?: { reason?: string } }[];
    };
    const deny = body.events.find(
      (e) => e.type === "grant.deny" && e.capabilityId === "docs-ask.read",
    );
    expect(deny).toBeDefined();
    expect(typeof deny!.detail?.reason).toBe("string");
    expect(deny!.detail!.reason!.length).toBeGreaterThan(0);
  });

  it("'ask' only tightens: an approved STANDING grant (1h) re-uses without re-pending", async () => {
    // Owner approves this pend with a STANDING window…
    const first = spawnCli(["docs-ask.read", "secret.md"], { PLEXUS_APPROVAL_WAIT_MS: "30000" });
    const pendingId = await waitForPending("docs-ask.read");
    await resolvePending(pendingId, "approve", { kind: "1h" });
    expect(await first.exited).toBe(0);

    // …so the NEXT call short-circuits on hasPriorApproval — no pend, immediate content.
    const second = await runCli(["docs-ask.read", "secret.md"], {
      PLEXUS_APPROVAL_WAIT_MS: "0",
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(ASK_NOTE);
    expect(second.stderr).not.toContain("awaiting the owner's approval");
  }, 30000);
});
