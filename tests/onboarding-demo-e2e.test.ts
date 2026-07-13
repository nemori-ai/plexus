/**
 * Onboarding demo story — the TWO ACTS, end-to-end through the REAL engine
 * (`tools/plexus-cli/plexus` under `node` against a booted gateway, exactly what a
 * connected agent runs; no mocks) with the demo set up via the REAL admin endpoint
 * (`POST /admin/api/demo-workspace` over HTTP, exactly what onboarding's CTA calls).
 *
 * Act 1 — the OPEN half: the agent lists, then reads `demo-intro.read` — the read
 *   flows with NO approval, and what comes back is the intro content an agent can
 *   introduce Plexus from (the docs-voice mds the endpoint materialized).
 * Act 2 — the PROTECTED half: `your-secret.read` PENDS (approval:"ask"); the owner
 *   approves (once) inline → the SAME waiting process prints the obviously-fake
 *   secret. A re-run pends AGAIN ("once" never stands) → the owner DENIES → the
 *   agent exits 77 with the explicit DENIED (deny is the other half of the lesson),
 *   and the denial lands in audit as grant.deny WITH detail.reason.
 *
 * Isolated homes (gateway ≠ agent), throwaway demo root, no ~/.plexus, no ~/PlexusDemo.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { bootScanCapabilities } from "@plexus/runtime/core/state.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  DEMO_FAKE_SECRET,
  DEMO_INTRO_SOURCE_ID,
  DEMO_SECRET_SOURCE_ID,
  type DemoWorkspaceResult,
} from "@plexus/runtime/core/demo-workspace.ts";

const CLI_BIN = join(import.meta.dir, "..", "tools", "plexus-cli", "plexus");
const AGENT_ID = "onboarding-demo-agent";

let server: ReturnType<typeof Bun.serve>;
let state: ReturnType<typeof createAppWithState>["state"];
let gwBaseUrl = "";
let gwHome = "";
let agentHome = "";
let demoParent = "";

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
      PLEXUS_HOME: agentHome,
      PLEXUS_GATEWAY: gwBaseUrl,
      PLEXUS_AGENT_ID: AGENT_ID,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = spawnCli(args, extraEnv);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

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
      ...(action === "deny" ? { reason: "not this folder — it is protected" } : {}),
    }),
  });
  if (res.status !== 200) throw new Error(`${action} failed: HTTP ${res.status}`);
}

beforeAll(async () => {
  gwHome = mkdtempSync(join(tmpdir(), "plexus-obdemo-gw-"));
  process.env.PLEXUS_HOME = gwHome;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const built = createAppWithState(config);
  state = built.state;
  await bootScanCapabilities(state);

  server = Bun.serve({ fetch: built.app.fetch, hostname: config.host, port: config.port });
  gwBaseUrl = configBaseUrl(config);

  // The onboarding CTA path, verbatim: HTTP POST to the admin endpoint (tmp root).
  demoParent = mkdtempSync(join(tmpdir(), "plexus-obdemo-root-"));
  const demoRoot = join(demoParent, "PlexusDemo");
  const res = await fetch(`${gwBaseUrl}/admin/api/demo-workspace`, {
    method: "POST",
    headers: {
      "X-Plexus-Connection-Key": state.connectionKey.current(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: demoRoot }),
  });
  if (res.status !== 200) throw new Error(`demo-workspace setup failed: HTTP ${res.status}`);
  const body = (await res.json()) as DemoWorkspaceResult;
  if (!body.ok) throw new Error(`demo-workspace setup not ok: ${body.reason}`);

  // AUTHORIZED-SUBSET (ADR-023, fail-closed): the owner declares the agent's subset at
  // connect; without one the agent is authorized NOTHING. Authorize both demo sources'
  // capabilities — the two-act lesson (open read vs protected pend/approve/deny) is what's
  // under test, and the "ask" posture still pends for a subset member with no standing grant.
  state.agentSubsets.set(
    AGENT_ID,
    state.capabilities
      .summaries()
      .map((s) => s.id)
      .filter(
        (id) => id.startsWith(`${DEMO_INTRO_SOURCE_ID}.`) || id.startsWith(`${DEMO_SECRET_SOURCE_ID}.`),
      ),
  );

  // Enroll the agent with its own PAT.
  agentHome = mkdtempSync(join(tmpdir(), "plexus-obdemo-agent-"));
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
  for (const d of [gwHome, agentHome, demoParent]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
  delete process.env.PLEXUS_HOME;
});

describe("onboarding demo — act 1: the open read (agent can introduce Plexus)", () => {
  it("`plexus list` shows BOTH demo sources' read capabilities", async () => {
    const { code, stdout } = await runCli(["list"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`${DEMO_INTRO_SOURCE_ID}.read`);
    expect(stdout).toContain(`${DEMO_SECRET_SOURCE_ID}.read`);
  });

  it("demo-intro.read flows with NO approval and returns the docs-voice intro", async () => {
    const { code, stdout, stderr } = await runCli(
      [`${DEMO_INTRO_SOURCE_ID}.read`, "welcome.md"],
      { PLEXUS_APPROVAL_WAIT_MS: "0" }, // fail-fast guard: this must NOT pend at all
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain("approval");
    // Enough substance for the agent to introduce Plexus from it.
    expect(stdout).toContain("Welcome to Plexus");
    expect(stdout).toContain("Default deny");
    expect(stdout).toContain("trust window");
  });

  it("demo-intro.list enumerates the intro folder (discovery before reading)", async () => {
    const { code, stdout } = await runCli([`${DEMO_INTRO_SOURCE_ID}.list`, "--json"], {
      PLEXUS_APPROVAL_WAIT_MS: "0",
    });
    expect(code).toBe(0);
    const res = JSON.parse(stdout) as { ok: boolean; output?: { entries?: { name: string }[] } };
    expect(res.ok).toBe(true);
    const names = (res.output?.entries ?? []).map((e) => e.name);
    expect(names).toContain("welcome.md");
    expect(names).toContain("the-trust-loop.md");
  });
});

describe("onboarding demo — act 2: the protected read (pend → approve / deny)", () => {
  it("your-secret.read PENDS → owner approves (once) → the fake secret comes back", async () => {
    const proc = spawnCli([`${DEMO_SECRET_SOURCE_ID}.read`, "secret.md"], {
      PLEXUS_APPROVAL_WAIT_MS: "30000",
    });

    const pendingId = await waitForPending(`${DEMO_SECRET_SOURCE_ID}.read`);
    await resolvePending(pendingId, "approve", { kind: "once" });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toContain("awaiting the owner's approval");
    expect(stdout).toContain(DEMO_FAKE_SECRET);
    expect(stdout.toLowerCase()).toContain("fake secret");
  }, 30000);

  it("a re-run pends AGAIN → owner DENIES → the agent gets an explicit DENIED (77)", async () => {
    const proc = spawnCli([`${DEMO_SECRET_SOURCE_ID}.read`, "secret.md"], {
      PLEXUS_APPROVAL_WAIT_MS: "30000",
    });

    const pendingId = await waitForPending(`${DEMO_SECRET_SOURCE_ID}.read`);
    await resolvePending(pendingId, "deny");

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(77);
    expect(stderr).toContain("DENIED");
    expect(stdout).not.toContain(DEMO_FAKE_SECRET);
  }, 30000);

  it("the denial is on the record: grant.deny with detail.reason (what Activity renders)", async () => {
    const res = await fetch(`${gwBaseUrl}/admin/api/audit?limit=200`, {
      headers: { "X-Plexus-Connection-Key": state.connectionKey.current() },
    });
    const body = (await res.json()) as {
      events: { type: string; capabilityId?: string; detail?: { reason?: string } }[];
    };
    const deny = body.events.find(
      (e) => e.type === "grant.deny" && e.capabilityId === `${DEMO_SECRET_SOURCE_ID}.read`,
    );
    expect(deny).toBeDefined();
    expect(typeof deny!.detail?.reason).toBe("string");
  });
});
