/**
 * P3-2 — Linux-mode proxy BOOTS + EXECUTES a portable cap (HERMETIC e2e, NO docker).
 *
 * Proves the Linux PORT LOGIC end-to-end on the macOS dev box, with zero docker / zero
 * subprocess: a proxy whose source registry is built with a FAKE
 * `PlatformServices{ platform: "linux" }` (so P3-1's `activeModulesForPlatform("linux")`
 * gates its active modules to the portable allowlist `{workspace, sysinfo}`) is wired
 * into the REAL mesh against an in-process primary, and:
 *
 *   (a) GATING — the linux proxy's ACTIVE first-party source set is EXACTLY
 *       {workspace, sysinfo}; the macOS-native + exec sources (apple-calendar /
 *       apple-reminders / things / claudecode / codex) are NOT scanned/advertised — no
 *       `apple.* / codex.* / claudecode.* / things.*` capability id exists on the proxy.
 *   (b) ENROLL + LIVE ASCENT — the proxy enrolls (Ed25519 mutual handshake) and its
 *       PUSHED bare catalog AUTO-mounts `workspace.*` on the primary under
 *       `tenant/workload/` with NO in-process mount call (A2 live catalog ascent).
 *   (c) PORTABLE EXECUTION — the primary forwards an agent invoke that EXECUTES on the
 *       LINUX-MODE proxy and returns a REAL result: a `workspace.read` of a seeded temp
 *       file, its content coming back through the forward boundary (bare id on the wire).
 *
 * The Linux code paths can never EXECUTE on this macOS box (mirrors
 * `p3-platform-gate-modules.test.ts` + `xplat-platform-seam.test.ts`): the FAKE platform
 * only steers the registry-build FILTER. The portable `workspace` cap is in-process
 * confined-fs (ipc), so it runs identically regardless of host OS — which is the whole
 * point of "portable". EPHEMERAL tunnel port + a unique temp PLEXUS_HOME + a temp
 * PLEXUS_WORKSPACE_DIR keep it isolated; teardown drops the dialer before the acceptor.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HandshakeResponse,
  InvokeResponse,
  PlatformServices,
  ScopedToken,
  WellKnownDocument,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import { WORKSPACE_READ_ID } from "@plexus/runtime/sources/index.ts";

const TENANT = "local";
const WORKLOAD = "linux-box";

// The first-party id roster (mirrors p3-platform-gate-modules.test.ts).
const LINUX_PORTABLE = ["workspace", "sysinfo"] as const;
const GATED_ON_LINUX = ["apple-calendar", "apple-reminders", "things", "claudecode", "codex"] as const;
// Capability-id PREFIXES that must NOT appear on a linux proxy (the gated sources' caps).
const GATED_CAP_PREFIXES = ["apple-calendar.", "apple-reminders.", "things.", "claudecode.", "codex."];

const SEED_REL = "notes/welcome.txt";
const SEED_BODY = "portable-cap-ran-on-linux-mode-proxy";

/**
 * A FAKE PlatformServices pinned to the given OS — exactly the seam
 * `p3-platform-gate-modules.test.ts` uses. It steers ONLY the registry-build filter;
 * the portable sources are in-process and never touch these OS hooks at scan time.
 */
function fakePlatform(platform: PlatformServices["platform"]): PlatformServices {
  return {
    platform,
    async resolveBinary() {
      return undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("linux proxy must not spawn a subprocess for a portable in-process cap");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

let home: string;
let workspaceDir: string;
let base: GatewayConfig;
let host: string;
let tunnelUrl: string;
let primary: ReturnType<typeof createAppWithState>;
let proxy: ReturnType<typeof createAppWithState>;
let proxySources: ReturnType<typeof createSourceRegistry>;
let mountedReadAddress: string;

async function req(path: string, init?: RequestInit): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    ...init,
    headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function wellKnownIds(): Promise<string[]> {
  const res = await req("/.well-known/plexus");
  const doc = (await res.json()) as WellKnownDocument;
  return doc.capabilities.map((c) => c.id);
}

async function handshake(): Promise<HandshakeResponse> {
  const res = await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: primary.state.connectionKey.current(),
      client: { name: "p3-2", agentId: "agent-p3-2" },
    }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grantAllow(sessionId: string, id: string): Promise<ScopedToken> {
  const res = await req("/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

/** A full agent invoke of the mounted address through the primary's agent surface. */
async function invokeMounted(
  address: string,
  input: Record<string, unknown>,
): Promise<{ status: number; body: InvokeResponse }> {
  const hs = await handshake();
  const token = await grantAllow(hs.sessionId, address);
  const res = await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ id: address, input }),
  });
  return { status: res.status, body: (await res.json()) as InvokeResponse };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-p3-2-"));
  process.env.PLEXUS_HOME = home;

  // The portable cap is a path-confined REAL fs read: point the workspace at a throwaway
  // temp dir with a seed file (NEVER a user dir). The proxy's workspace module resolves
  // its root from PLEXUS_WORKSPACE_DIR — hermetic + isolated.
  workspaceDir = mkdtempSync(join(tmpdir(), "plexus-workspace-p3-2-"));
  process.env.PLEXUS_WORKSPACE_DIR = workspaceDir;
  mkdirSync(join(workspaceDir, "notes"), { recursive: true });
  writeFileSync(join(workspaceDir, SEED_REL), SEED_BODY + "\n");

  _resetSecretCacheForTests();
  base = loadConfig(); // no proxy env ⇒ primary mode
  host = expectedHost(base);

  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  // PRIMARY — authority root + tunnel acceptor. AutoApprove so the agent grant yields a
  // token deterministically (grant UX is not under test here).
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0); // EPHEMERAL port (config port:0)
  tunnelUrl = `ws://127.0.0.1:${tunnelPort}`;

  const minted = primary.state.mesh.enrollment!.mintJoinToken();

  // PROXY — its source registry is built with the FAKE linux platform, so P3-1 gates the
  // active modules to {workspace, sysinfo}. THIS is the linux port logic under test.
  proxySources = createSourceRegistry(fakePlatform("linux"));
  const proxyCaps = createCapabilityRegistry(proxySources);
  const proxyConfig: GatewayConfig = {
    ...base,
    mode: "proxy",
    upstream: { url: tunnelUrl, primaryPubKey: primaryId.publicKeyPem },
    workload: WORKLOAD,
  };
  proxy = createAppWithState(proxyConfig, {
    sources: proxySources,
    capabilities: proxyCaps,
    mesh: { identity: proxyId, joinToken: minted.token },
  });
  await proxy.state.capabilities.start(); // scan the gated linux set ⇒ workspace.* invocable
  await proxy.state.mesh.start(); // dial + enroll + mutually authenticate
});

afterAll(() => {
  // Drop the DIALER (proxy) before the ACCEPTOR (primary) — leak-free teardown convention.
  proxy?.state.mesh.stop();
  primary?.state.mesh.stop();
  delete process.env.PLEXUS_HOME;
  delete process.env.PLEXUS_WORKSPACE_DIR;
  for (const d of [home, workspaceDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("P3-2 — linux-mode proxy boots + executes a portable cap (hermetic e2e)", () => {
  it("(a) the linux proxy's ACTIVE first-party source set is EXACTLY {workspace, sysinfo}", () => {
    const active = new Set(proxySources.all().map((m) => m.id));
    expect([...active].sort()).toEqual([...LINUX_PORTABLE].sort());

    // The macOS-native + exec sources are gated OUT — not even resolvable on the proxy.
    for (const id of GATED_ON_LINUX) {
      expect(proxySources.get(id)).toBeUndefined();
    }
  });

  it("(a') NO Apple/exec CAPABILITY id is scanned/advertised on the linux proxy", () => {
    const capIds = proxy.state.capabilities.all().map((e) => e.id);
    // The portable workspace cap IS present…
    expect(capIds).toContain(WORKSPACE_READ_ID);
    // …and not a single gated source contributes a capability id.
    for (const prefix of GATED_CAP_PREFIXES) {
      expect(capIds.some((id) => id.startsWith(prefix))).toBe(false);
    }
  });

  it("(b) the proxy enrolls + its workspace.* AUTO-mounts on the primary (live catalog ascent)", async () => {
    mountedReadAddress = `${TENANT}/${WORKLOAD}/${WORKSPACE_READ_ID}`;

    // Enrolled + authenticated.
    await until(() => primary.state.mesh.connected && primary.state.mesh.enrollment!.isActive(WORKLOAD));
    expect(primary.state.mesh.connected).toBe(true);
    expect(primary.state.mesh.enrollment!.isActive(WORKLOAD)).toBe(true);

    // A2 LIVE ASCENT: no in-process mount call — the primary mounts purely from the catalog
    // the proxy PUSHED up the tunnel on authentication.
    await until(() => primary.state.capabilities.get(mountedReadAddress) !== undefined);
    const entry = primary.state.capabilities.get(mountedReadAddress)!;
    expect(entry).toBeDefined();
    expect(entry.transport).toBe("mesh");
    expect(entry.source).toBe(`mesh:${WORKLOAD}`);

    // ADDRESS ⟂ ROUTE: the bare id is NEVER a key on the mounted surface.
    expect(primary.state.capabilities.get(WORKSPACE_READ_ID)).toBeUndefined();
    // ZERO-EXPOSURE: mounted ⇒ hidden by default, invisible in `.well-known` pre-enable.
    expect(primary.state.exposure.isEnabled(mountedReadAddress)).toBe(false);
    expect(await wellKnownIds()).not.toContain(mountedReadAddress);
  });

  it("(c) the primary forwards an invoke that EXECUTES on the linux proxy ⇒ real workspace read", async () => {
    // Wait for the workload to be reachable, then expose the mounted read cap (owner consent).
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok");
    primary.state.exposure.setEnabled(mountedReadAddress, true);
    expect(await wellKnownIds()).toContain(mountedReadAddress);

    // An AGENT (talking ONLY to the primary) invokes the mounted address; the call is
    // forwarded to the LINUX-MODE proxy, which executes the portable confined-fs read.
    const { status, body } = await invokeMounted(mountedReadAddress, { path: SEED_REL });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(mountedReadAddress); // reply keyed by the mounted URN

    // The REAL result: the seeded temp file's content came back through the forward.
    const out = body.output as { type: string; content: string; relativePath: string };
    expect(out.type).toBe("file");
    expect(out.relativePath).toBe(SEED_REL);
    expect(out.content).toContain(SEED_BODY);

    // BARE ON WIRE: the proxy executed the bare `workspace.read` id — the location prefix
    // translated off exactly once at the forward boundary (never executed as a key).
    const forwarded = proxy.state.mesh.lastForwardedInvoke;
    expect(forwarded).toBeDefined();
    expect(forwarded!.id).toBe(WORKSPACE_READ_ID);
    expect(forwarded!.id.includes("/")).toBe(false);
    expect(forwarded!.address).toBe(mountedReadAddress);
  });
});
