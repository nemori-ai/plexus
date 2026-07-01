/**
 * ADR-5 (Inv IV — through-primary equivalence): standing-grant eligibility is a per-cap
 * SENSITIVITY policy, ORIGIN-INDEPENDENT. Whether a capability is served locally or routed
 * to a mesh node is a routing detail, never an authz distinction.
 *
 * This proves the load-bearing change: a mesh/extension cap the owner grants with a durable
 * window becomes a REAL STANDING grant — exactly like an equivalent LOCAL cap — instead of
 * the old "mesh caps hardcoded to `once`" conflation. It also pins the invariants the fix
 * must NOT weaken:
 *   1. A mesh WRITE cap owner-approved (1d default OR explicit 7d) is STANDING — same as a
 *      local write cap of the same verb class.
 *   2. A genuinely-per-use (`execute`) cap is STILL `once` (non-standing) for BOTH a local and
 *      a mesh instance — origin-independent (the once rides on the verb, not the origin).
 *   3. `anon:*` sessions are STILL capped at `once` (no durable standing) — unchanged.
 *   4. The FIRST grant of an extension/mesh cap STILL PENDs for owner approval — the
 *      mount-provenance security posture from the prior epic is preserved (not regressed).
 *
 * Driven through the published wire + the admin approve channel — no fake-green.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  CapabilityId,
  SourceRegistry,
  SourceModule,
  Transport,
  TransportKind,
  BridgeDeps,
  HandshakeResponse,
  GrantResponse,
  GrantPendingResponse,
  ScopedToken,
  TrustWindow,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { isStandingAndUnexpired } from "@plexus/runtime/core/grants.ts";
import { mountAddress, DEFAULT_TENANT } from "@plexus/runtime/mesh/addressing.ts";

const WORKLOAD = "laptop";

// A LOCAL first-party write + execute cap (source "mock", a reserved first-party id).
const LOCAL_WRITE: CapabilityEntry = {
  id: "mock.doc.write",
  source: "mock",
  kind: "capability",
  label: "Write a local doc",
  describe: "Write a local doc.",
  grants: ["write"],
  transport: "mcp",
};
const LOCAL_EXEC: CapabilityEntry = {
  id: "mock.proc.run",
  source: "mock",
  kind: "capability",
  label: "Run a local process",
  describe: "Run a local process.",
  grants: ["execute"],
  transport: "mcp",
};
const LOCAL_READ: CapabilityEntry = {
  id: "mock.doc.read",
  source: "mock",
  kind: "capability",
  label: "Read a local doc",
  describe: "Read a local doc.",
  grants: ["read"],
  transport: "mcp",
};

// The BARE remote caps a proxy pushes over the tunnel (workload-agnostic ids). Their MOUNTED
// addresses re-derive to `extension` provenance (the strictest class) at the primary.
const REMOTE_WRITE: CapabilityEntry = {
  id: "svc.doc.write",
  source: "svc",
  kind: "capability",
  label: "Write a remote doc",
  describe: "Write a remote doc.",
  grants: ["write"],
  transport: "mcp",
};
const REMOTE_EXEC: CapabilityEntry = {
  id: "svc.proc.run",
  source: "svc",
  kind: "capability",
  label: "Run a remote process",
  describe: "Run a remote process.",
  grants: ["execute"],
  transport: "mcp",
};

const MESH_WRITE_ADDR = mountAddress(DEFAULT_TENANT, WORKLOAD, REMOTE_WRITE.id);
const MESH_EXEC_ADDR = mountAddress(DEFAULT_TENANT, WORKLOAD, REMOTE_EXEC.id);

/** A trivial SourceRegistry — mounting never scans; we seed local entries directly. */
function trivialRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "mcp",
    createSource: () => ({
      id: "mock",
      label: "Mock",
      transport: "mcp" as const,
      checkRequirements: async () => ({ ok: true }),
      scan: async () => [LOCAL_WRITE, LOCAL_EXEC, LOCAL_READ],
      start: async () => {},
      stop: async () => {},
    }),
    createBridge: (_deps: BridgeDeps, _sid: string) => {
      throw new Error("bridge not used in this test");
    },
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind: TransportKind) => ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];
let activeKey = "";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-standing-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = trivialRegistry();
  const capabilities = createCapabilityRegistry(sources);
  // Seed the LOCAL caps directly (like auth-trust-model) …
  for (const e of [LOCAL_WRITE, LOCAL_EXEC, LOCAL_READ])
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  // … and MOUNT the remote caps (address-rewrite → source `mesh:<workload>` → extension).
  capabilities.mountRemoteWorkload(WORKLOAD, [REMOTE_WRITE, REMOTE_EXEC]);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  // The owner ENABLES the mounted (default-hidden, zero-exposure) mesh caps — the connect-time
  // action that makes them grantable. Local caps are default-exposed.
  state.exposure.setEnabled(MESH_WRITE_ADDR, true);
  state.exposure.setEnabled(MESH_EXEC_ADDR, true);
  activeKey = state.connectionKey.current();
  return { app, state, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  agentId?: string,
) {
  const key = state.connectionKey.current();
  const client: Record<string, unknown> = { name: "test" };
  if (agentId) client.agentId = agentId;
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client }),
  });
  return (await res.json()) as HandshakeResponse;
}
async function putGrants(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  grants: Record<string, unknown>,
) {
  const res = await req(app, "/grants", { method: "PUT", body: JSON.stringify({ sessionId, grants }) });
  return (await res.json()) as GrantResponse;
}
async function adminApprove(
  app: ReturnType<typeof freshApp>["app"],
  pendingId: string,
  trustWindow?: TrustWindow,
) {
  const res = await req(app, `/admin/api/pending/${pendingId}`, {
    method: "POST",
    headers: { "X-Plexus-Connection-Key": activeKey },
    body: JSON.stringify({ action: "approve", ...(trustWindow ? { trustWindow } : {}) }),
  });
  return res;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

// ════════════════════════════════════════════════════════════════════════════
// 1 — A mesh WRITE cap becomes a REAL STANDING grant (same as a local write cap).
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-5: mesh/extension write is standing-eligible (origin-independent)", () => {
  it("FIRST grant of a mesh cap PENDs for owner approval (mount-prov posture preserved)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-mesh");
    const res = (await putGrants(app, hs.sessionId, {
      [MESH_WRITE_ADDR]: { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    // Extension/mesh provenance ⇒ the first grant awaits a human (NOT auto-allowed).
    expect(res.status).toBe("grant_pending_user");
    expect(res.pending).toContain(MESH_WRITE_ADDR);
    const n = res.pendingNarration!.find((p) => p.id === MESH_WRITE_ADDR)!;
    expect(n.provenance).toBe("extension");
    // …and the ADVERTISED default window is now a STANDING window (1d), not `once`.
    expect(n.defaultTrustWindow.kind).toBe("1d");
  });

  it("owner-approved (default 1d) → the mesh write is STANDING, same as a local write cap", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-mesh");

    // MESH write cap: pend → approve with NO explicit window (uses the recommended default).
    const meshPend = (await putGrants(app, hs.sessionId, {
      [MESH_WRITE_ADDR]: { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    expect((await adminApprove(app, meshPend.pendingId)).status).toBe(200);

    const meshGrant = state.grants.get("agent-mesh", MESH_WRITE_ADDR);
    expect(meshGrant).toBeDefined();
    expect(meshGrant!.standing).toBe(true); // ← the fix: NOT a `once`/non-standing grant
    expect(isStandingAndUnexpired(meshGrant!)).toBe(true);
    expect(meshGrant!.trustWindow?.kind).toBe("1d");

    // LOCAL write cap: same flow, same outcome — equivalence proven.
    const localPend = (await putGrants(app, hs.sessionId, {
      "mock.doc.write": { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    expect((await adminApprove(app, localPend.pendingId)).status).toBe(200);

    const localGrant = state.grants.get("agent-mesh", "mock.doc.write");
    expect(localGrant).toBeDefined();
    expect(localGrant!.standing).toBe(true);
    expect(isStandingAndUnexpired(localGrant!)).toBe(true);
    // Same standing-eligibility + window as the mesh cap (origin-agnostic).
    expect(localGrant!.trustWindow?.kind).toBe(meshGrant!.trustWindow?.kind);
  });

  it("owner may pick an explicit durable window (7d) on a mesh write → honored + STANDING", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-mesh7");
    const pend = (await putGrants(app, hs.sessionId, {
      [MESH_WRITE_ADDR]: { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    expect((await adminApprove(app, pend.pendingId, { kind: "7d" })).status).toBe(200);

    const g = state.grants.get("agent-mesh7", MESH_WRITE_ADDR);
    expect(g).toBeDefined();
    expect(g!.standing).toBe(true);
    expect(g!.trustWindow?.kind).toBe("7d");
    expect(isStandingAndUnexpired(g!)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — A genuinely-per-use (`execute`) cap stays `once` for BOTH local and mesh.
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-5: genuinely-per-use (`execute`) is `once` for ANY origin", () => {
  it("a mesh execute cap → `once` (non-standing), even owner-approved", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-x");
    const pend = (await putGrants(app, hs.sessionId, {
      [MESH_EXEC_ADDR]: { decision: "allow", verbs: ["execute"] },
    })) as GrantPendingResponse;
    expect(pend.status).toBe("grant_pending_user");
    const n = pend.pendingNarration!.find((p) => p.id === MESH_EXEC_ADDR)!;
    expect(n.defaultTrustWindow.kind).toBe("once"); // genuinely-per-use
    // Approve with the recommended default → `once` ⇒ no durable standing record (Fix 2).
    expect((await adminApprove(app, pend.pendingId)).status).toBe(200);
    expect(state.grants.get("agent-x", MESH_EXEC_ADDR)).toBeUndefined();
  });

  it("a LOCAL execute cap → `once` too (identical outcome, origin-independent)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-x2");
    const pend = (await putGrants(app, hs.sessionId, {
      "mock.proc.run": { decision: "allow", verbs: ["execute"] },
    })) as GrantPendingResponse;
    expect(pend.status).toBe("grant_pending_user");
    const n = pend.pendingNarration!.find((p) => p.id === "mock.proc.run")!;
    expect(n.defaultTrustWindow.kind).toBe("once");
    expect((await adminApprove(app, pend.pendingId)).status).toBe(200);
    expect(state.grants.get("agent-x2", "mock.proc.run")).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — `anon:*` is STILL capped at `once` (unchanged).
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-5: anonymous sessions are still capped at `once` (unchanged)", () => {
  it("an anon session gets a single-use token (no durable standing), even for a low-risk read", async () => {
    const { app, state } = freshApp();
    // No agentId ⇒ the session is `anon:<sessionId>` — never a durable standing grant.
    const hs = await handshake(app, state);
    // A local first-party read auto-allows under confirm-risky, but anon caps the window at once.
    const read = (await putGrants(app, hs.sessionId, {
      "mock.doc.read": { decision: "allow", verbs: ["read"] },
    })) as ScopedToken;
    expect("token" in read).toBe(true);
    expect(read.trustWindow?.kind).toBe("once"); // anon cap — no durable standing
    // …and nothing durable was written for the anon identity.
    const anonId = `anon:${hs.sessionId}`;
    expect(state.grants.get(anonId, "mock.doc.read")).toBeUndefined();
  });
});
