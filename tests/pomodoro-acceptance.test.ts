/**
 * pomodoro-acceptance — the SECURITY-CORE acceptance gate for the Plexus × DeepAgents
 * pomodoro demo (`examples/pomodoro-demo/GOAL.md` §6). NO live agent, NO LLM, NO real
 * Claude Code spawn, no network socket.
 *
 * This suite brings up the REAL Plexus gateway IN-PROCESS (via `app.request`, fetch-shaped
 * — same uniform pipeline, no port) with:
 *   - the WORKSPACE first-party source bound to a SEEDED temp dir (the "authorized dir"),
 *     using the REAL confined-fs provider (PLEXUS_WORKSPACE_DIR) so confinement is genuine
 *     against a secret we plant OUTSIDE that dir;
 *   - the CLAUDECODE source confined to the SAME dir (PLEXUS_CC_AUTHORIZED_DIR), in
 *     RECORD-MODE (PLEXUS_CC_HEADLESS_LAUNCH left OFF ⇒ no real CC spawn).
 *
 * It then drives the real handshake → grants → invoke → audit chain and asserts the
 * endpoint-verifiable, no-LLM half of the acceptance criteria. Each test is labeled with
 * its AC id:
 *
 *   AC2 — RESOURCE-SIDE APPROVAL: `workspace.write` / `claudecode.run` PEND (no token);
 *         `/invoke` without an approved token is refused (401, grant_required); only AFTER
 *         the owner approves (POST /admin/api/pending/:id, management-key) does
 *         `/grants/status` yield a token and `/invoke` succeed. `workspace.read` auto-grants.
 *   AC6 — PATH CONFINEMENT (negative): a `workspace.read` / `workspace.write` with a
 *         traversal / absolute path returns `ok:false` transport_error; the out-of-dir
 *         secret never leaks and nothing is written outside the dir.
 *   AC7 — NO SELF-ESCALATION / HIDDEN MANAGEMENT KEY: no agent-reachable route returns the
 *         connection-key; the agent's session JWT cannot authorize an un-approved write;
 *         `/admin/api/*` requires the management key (the agent never has it); the agent
 *         surface never exposes the management realm.
 *   AC8 — AUDITABLE: the audit trail carries grant.pending / grant.allow + invoke events
 *         with capability ids — a reconstructable record.
 *   AC5 — (reference) one assertion that `claudecode.run`'s record-mode result + audit
 *         carry the `sandboxed:true` + confinement posture. The LIVE-sandbox kernel-denial
 *         proof for AC5 lives in `tests/claudecode-run.test.ts` (the hermetic live sandbox
 *         negative) — NOT duplicated here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  WORKSPACE_LIST_ID,
  WORKSPACE_READ_ID,
  WORKSPACE_WRITE_ID,
} from "@plexus/runtime/sources/index.ts";
import {
  CLAUDECODE_RUN_ID,
} from "@plexus/runtime/sources/claudecode/entries.ts";

import type {
  AuditEvent,
  HandshakeResponse,
  InvokeResponse,
  PlatformServices,
  ScopedToken,
} from "@plexus/protocol";

// The secret content planted OUTSIDE the authorized dir; it must NEVER leak through any
// confined read, and must never be overwritten by any confined write.
const SECRET = "TOP-SECRET-pomodoro — must never be readable/writable via the workspace.";

// ── temp-dir bookkeeping ──────────────────────────────────────────────────────
const tmpDirs: string[] = [];
function tmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// ──────────────────────────────────────────────────────────────────────────────
// The hermetic harness: boot the REAL gateway in-process with the workspace + claudecode
// sources confined to a SEEDED authorized dir, place a secret OUTSIDE it, and hand back
// fetch-shaped helpers (agent surface + management surface) plus an approve helper.
// ──────────────────────────────────────────────────────────────────────────────

interface Harness {
  /** Absolute authorized (seeded) dir the sources are confined to. */
  authorizedDir: string;
  /** The parent of the authorized dir (where the out-of-dir SECRET lives). */
  outsideDir: string;
  /** Absolute path to the out-of-dir secret file. */
  secretPath: string;
  /** The handshake session id (the agent's only standing thing besides the connection-key). */
  sessionId: string;
  /** The management connection-key (the trusted human surface; the agent NEVER sees it). */
  adminKey: string;
  /** Agent-surface fetch (NO connection-key, NO management header). */
  req: (path: string, init?: RequestInit) => Promise<Response>;
  /** Management-surface fetch (attaches the connection-key). */
  adminReq: (path: string, init?: RequestInit) => Promise<Response>;
  /** Request a grant; returns a minted ScopedToken (auto-allow) OR a pending response. */
  requestGrant: (capId: string) => Promise<ScopedToken & { status?: string; pendingId?: string }>;
  /** Approve a pending item via the management approve channel (POST /admin/api/pending/:id). */
  approvePending: (pendingId: string) => Promise<Response>;
  /** Poll /grants/status until the pending grant resolves to an approved token. */
  awaitToken: (pendingId: string) => Promise<ScopedToken>;
  /** Read the audit trail oldest→newest via the management surface. */
  readAuditTrail: () => Promise<AuditEvent[]>;
}

/** A platform seam that fakes `claude` so the claudecode source surfaces hermetically. */
function platformWithFakeClaude(): PlatformServices {
  const real = getPlatformServices();
  return {
    ...real,
    resolveBinary: async (name: string) =>
      name === "claude" ? "/usr/local/bin/claude" : real.resolveBinary(name),
  };
}

let savedEnv: Record<string, string | undefined> = {};

async function boot(): Promise<Harness> {
  // ── seeded authorized dir + an out-of-dir secret ─────────────────────────────
  const outsideDir = tmpRoot("plexus-pomodoro-");
  const authorizedDir = join(outsideDir, "pomodoro");
  mkdirSync(join(authorizedDir, "refs"), { recursive: true });
  writeFileSync(join(authorizedDir, "me.md"), "# Me\nI like a pixel-art 番茄喵 mascot, lo-fi palette.\n");
  writeFileSync(join(authorizedDir, "refs", "notes.md"), "# Notes\nPomodoro apps I tried.\n");
  // The sensitive file lives OUTSIDE the authorized dir (a sibling) — the confinement target.
  const secretPath = join(outsideDir, "SECRET.txt");
  writeFileSync(secretPath, SECRET + "\n");

  // ── isolated temp PLEXUS_HOME (signing secret + audit live here) ─────────────
  const plexusHome = tmpRoot("plexus-home-");

  // ── env: bind the REAL confined-fs provider to the seeded dir (NOT the fake) so
  //    confinement is genuine against our out-of-dir secret; confine CC to the same
  //    dir; keep the CC headless gate OFF (record-mode, no real spawn). ──────────
  savedEnv = {
    PLEXUS_HOME: process.env.PLEXUS_HOME,
    PLEXUS_WORKSPACE_DIR: process.env.PLEXUS_WORKSPACE_DIR,
    PLEXUS_FAKE_WORKSPACE: process.env.PLEXUS_FAKE_WORKSPACE,
    PLEXUS_CC_AUTHORIZED_DIR: process.env.PLEXUS_CC_AUTHORIZED_DIR,
    PLEXUS_CC_HEADLESS_LAUNCH: process.env.PLEXUS_CC_HEADLESS_LAUNCH,
  };
  process.env.PLEXUS_HOME = plexusHome;
  process.env.PLEXUS_WORKSPACE_DIR = authorizedDir;
  delete process.env.PLEXUS_FAKE_WORKSPACE; // REAL provider ⇒ real confinement on our seeded dir
  process.env.PLEXUS_CC_AUTHORIZED_DIR = authorizedDir;
  delete process.env.PLEXUS_CC_HEADLESS_LAUNCH; // record-mode (no real CC spawn)
  _resetSecretCacheForTests();

  // ── boot the real gateway in-process ─────────────────────────────────────────
  const config = loadConfig();
  const HOST = expectedHost(config);
  const platform = platformWithFakeClaude();
  const sources = createSourceRegistry(platform);
  const capabilities = createCapabilityRegistry(sources);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  await state.capabilities.start();

  const adminKey = state.connectionKey.current();

  // in-process fetch helpers (fetch-shaped; same pipeline, no socket).
  const req = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request("http://" + HOST + path, {
      ...init,
      headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const adminReq = async (path: string, init?: RequestInit): Promise<Response> =>
    req(path, { ...init, headers: { "X-Plexus-Connection-Key": adminKey, ...(init?.headers ?? {}) } });

  // ── handshake: the agent has ONLY the connection-key; it gets a session ───────
  const hs = (await (await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: adminKey,
      client: { name: "deepagent-pomodoro", version: "0.1.0", agentId: "agent-pomodoro" },
    }),
  })).json()) as HandshakeResponse;

  const requestGrant = async (capId: string) =>
    (await (await req("/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [capId]: "allow" } }),
    })).json()) as ScopedToken & { status?: string; pendingId?: string };

  const approvePending = (pendingId: string) =>
    adminReq(`/admin/api/pending/${pendingId}`, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });

  const awaitToken = async (pendingId: string): Promise<ScopedToken> => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      // /grants/status is bound to the originating session or the management key (P6-STATUS-AUTH);
      // the harness polls via the management surface (connection-key).
      const st = (await (await adminReq(`/grants/status?pendingId=${pendingId}`)).json()) as {
        state: string;
        token?: ScopedToken;
      };
      if (st.state === "approved" && st.token) return st.token;
      if (st.state === "denied" || st.state === "expired") throw new Error(`grant ${pendingId} ${st.state}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`grant ${pendingId} never resolved`);
  };

  const readAuditTrail = async (): Promise<AuditEvent[]> => {
    const body = (await (await adminReq("/admin/api/audit?limit=500")).json()) as { events: AuditEvent[] };
    // readAudit returns newest→oldest; present oldest→newest for reconstruction.
    return [...body.events].reverse();
  };

  return {
    authorizedDir,
    outsideDir,
    secretPath,
    sessionId: hs.sessionId,
    adminKey,
    req,
    adminReq,
    requestGrant,
    approvePending,
    awaitToken,
    readAuditTrail,
  };
}

let H: Harness;

beforeEach(async () => {
  H = await boot();
});

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — RESOURCE-SIDE APPROVAL (the owner's side gates every mutating move).
// ══════════════════════════════════════════════════════════════════════════════
describe("AC2 — resource-side approval (write/execute PEND; read auto-grants)", () => {
  it("workspace.read AUTO-GRANTS (mints a token, no pend) and invoke succeeds", async () => {
    const res = await H.requestGrant(WORKSPACE_READ_ID);
    // A low-risk first-party read auto-allows: a token is minted right on /grants, no pendingId.
    expect(res.status).toBeUndefined();
    expect(res.pendingId).toBeUndefined();
    expect(res.token).toBeTruthy();
    expect(res.scopes.some((s) => s.id === WORKSPACE_READ_ID)).toBe(true);

    const inv = (await (await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${res.token}` },
      body: JSON.stringify({ id: WORKSPACE_READ_ID, input: { path: "me.md" } }),
    })).json()) as InvokeResponse;
    expect(inv.ok).toBe(true);
    expect(String((inv.output as { content?: string }).content ?? "")).toContain("番茄喵");
  });

  it("workspace.write PENDS (status grant_pending_user, NO token); the agent cannot mint its own write token", async () => {
    const res = await H.requestGrant(WORKSPACE_WRITE_ID);
    expect(res.status).toBe("grant_pending_user");
    expect(res.pendingId).toBeTruthy();
    // No token leaked from the wire — the agent cannot self-grant a mutating capability.
    expect((res as { token?: string }).token).toBeFalsy();
  });

  it("claudecode.run PENDS (execute) — same resource-side gate as write", async () => {
    const res = await H.requestGrant(CLAUDECODE_RUN_ID);
    expect(res.status).toBe("grant_pending_user");
    expect(res.pendingId).toBeTruthy();
    expect((res as { token?: string }).token).toBeFalsy();
  });

  it("invoke of workspace.write WITHOUT an approved token is REFUSED (401, grant_required); nothing written", async () => {
    // Request the grant so it PENDS, but DO NOT approve it.
    const pend = await H.requestGrant(WORKSPACE_WRITE_ID);
    expect(pend.status).toBe("grant_pending_user");

    // An invoke with NO bearer is default-denied before any execution.
    const res = await H.req("/invoke", {
      method: "POST",
      body: JSON.stringify({ id: WORKSPACE_WRITE_ID, input: { path: "PRD.html", content: "<h1>premature</h1>" } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
    // The would-be file never landed in the authorized dir.
    expect(existsSync(join(H.authorizedDir, "PRD.html"))).toBe(false);
  });

  it("only AFTER the owner APPROVES does /grants/status yield a token and the write succeed (pend → approve → live)", async () => {
    // 1) request → pends
    const pend = await H.requestGrant(WORKSPACE_WRITE_ID);
    expect(pend.status).toBe("grant_pending_user");
    const pendingId = pend.pendingId!;

    // Before approval, /grants/status has NO token.
    const before = (await (await H.adminReq(`/grants/status?pendingId=${pendingId}`)).json()) as {
      state: string;
      token?: ScopedToken;
    };
    expect(before.state).toBe("pending");
    expect(before.token).toBeUndefined();

    // 2) the OWNER approves via the management approve channel (connection-key gated).
    const approveRes = await H.approvePending(pendingId);
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as { ok: boolean; action: string };
    expect(approveBody.ok).toBe(true);
    expect(approveBody.action).toBe("approve");

    // 3) now /grants/status yields a token with the write verb.
    const token = await H.awaitToken(pendingId);
    expect(token.token).toBeTruthy();
    expect(token.scopes.find((s) => s.id === WORKSPACE_WRITE_ID)?.verbs).toContain("write");

    // 4) the write now succeeds and the file really lands in the authorized dir.
    const inv = (await (await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: WORKSPACE_WRITE_ID, input: { path: "PRD.html", content: "<h1>Pomodoro PRD</h1>" } }),
    })).json()) as InvokeResponse;
    expect(inv.ok).toBe(true);
    expect(readFileSync(join(H.authorizedDir, "PRD.html"), "utf8")).toContain("Pomodoro PRD");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC6 — PATH CONFINEMENT (negative): no confined capability can escape the dir.
// ══════════════════════════════════════════════════════════════════════════════
describe("AC6 — path confinement (negative): traversal/absolute paths are rejected; the secret never leaks", () => {
  /** Mint an approved WRITE token (read auto-grants) — confinement is enforced even WITH a valid grant. */
  async function approvedWriteToken(): Promise<string> {
    const pend = await H.requestGrant(WORKSPACE_WRITE_ID);
    await H.approvePending(pend.pendingId!);
    const token = await H.awaitToken(pend.pendingId!);
    return token.token;
  }

  it("a traversal READ (`../SECRET.txt`) is REJECTED (transport_error) and the secret content never leaks", async () => {
    const read = await H.requestGrant(WORKSPACE_READ_ID); // auto-granted

    const res = await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${read.token}` },
      body: JSON.stringify({ id: WORKSPACE_READ_ID, input: { path: "../SECRET.txt" } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("transport_error");
    // The out-of-dir secret content is NEVER present in the response.
    expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
  });

  it("an ABSOLUTE-path READ of the out-of-dir secret is REJECTED and never leaks", async () => {
    const read = await H.requestGrant(WORKSPACE_READ_ID);

    const res = await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${read.token}` },
      body: JSON.stringify({ id: WORKSPACE_READ_ID, input: { path: H.secretPath } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("transport_error");
    expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    // The secret file is untouched on disk.
    expect(readFileSync(H.secretPath, "utf8")).toContain("TOP-SECRET");
  });

  it("a traversal WRITE (`../HACKED.txt`) is REJECTED and nothing is written outside the dir", async () => {
    const token = await approvedWriteToken();

    const res = await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: WORKSPACE_WRITE_ID, input: { path: "../HACKED.txt", content: "pwned" } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("transport_error");
    // No escape file was created as a sibling of the authorized dir.
    expect(existsSync(join(H.outsideDir, "HACKED.txt"))).toBe(false);
  });

  it("an ABSOLUTE-path WRITE onto the out-of-dir secret is REJECTED and never overwrites it", async () => {
    const token = await approvedWriteToken();

    const res = await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: WORKSPACE_WRITE_ID, input: { path: H.secretPath, content: "pwned" } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("transport_error");
    // The secret file's original content is intact — the write never reached outside the dir.
    expect(readFileSync(H.secretPath, "utf8")).toContain("TOP-SECRET");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 — NO SELF-ESCALATION / HIDDEN MANAGEMENT KEY.
// ══════════════════════════════════════════════════════════════════════════════
describe("AC7 — no self-escalation: the management realm is invisible + unreachable to the agent", () => {
  it("there is NO agent-reachable route that returns the connection-key", async () => {
    // The deliberately-absent route (F2): GET /admin/api/connection-key must NOT exist as an
    // agent-readable surface. Even WITH the key it 404s; without it, it is guard-rejected —
    // in NO case does it ever return the key.
    const withKey = await H.adminReq("/admin/api/connection-key");
    expect(withKey.status).not.toBe(200);
    const bare = await H.req("/admin/api/connection-key");
    expect(bare.status).not.toBe(200);
    expect(JSON.stringify(await bare.json()).toLowerCase()).not.toContain(H.adminKey.toLowerCase());
  });

  it("`/admin/api/*` requires the management key — the agent (session JWT only) is rejected", async () => {
    // The agent never holds the connection-key. A bare management request (no key) is denied.
    const bare = await H.req("/admin/api/audit");
    expect(bare.status).toBe(401);
    // WITH the key (the trusted human surface) it works — proving the gate is the key, not the route.
    const withKey = await H.adminReq("/admin/api/audit");
    expect(withKey.status).toBe(200);
  });

  it("the agent's session cannot self-approve its OWN pending write (no agent-reachable approve route)", async () => {
    const pend = await H.requestGrant(WORKSPACE_WRITE_ID);
    const pendingId = pend.pendingId!;
    // The agent tries to approve its own pending grant WITHOUT the connection-key → denied.
    const selfApprove = await H.req(`/admin/api/pending/${pendingId}`, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(selfApprove.status).toBe(401);
    // The grant stays pending — no token was minted by the agent's own action.
    const st = (await (await H.adminReq(`/grants/status?pendingId=${pendingId}`)).json()) as {
      state: string;
      token?: ScopedToken;
    };
    expect(st.state).toBe("pending");
    expect(st.token).toBeUndefined();
  });

  it("the agent surface (.well-known / handshake / grants / manifest) never exposes the connection-key or a management route", async () => {
    // discover
    const wk = await (await H.req("/.well-known/plexus")).text();
    // manifest (session-authed pull)
    const manifest = await (await H.req("/manifest", { headers: { "X-Plexus-Session": H.sessionId } })).text();
    // grants context (what the agent can request)
    const grantsCtx = await (await H.req(`/grants/context?sessionId=${H.sessionId}`)).text();

    for (const surface of [wk, manifest, grantsCtx]) {
      // The connection-key never bleeds onto the agent surface.
      expect(surface.toLowerCase()).not.toContain(H.adminKey.toLowerCase());
      // The management realm ("admin/api", connection-key rotate) is not advertised to the agent.
      expect(surface).not.toContain("/admin/api");
      expect(surface).not.toContain("connection-key/rotate");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC8 — AUDITABLE: the trail is a reconstructable record of grants + invokes.
// AC5 (reference) — the claudecode.run record-mode result + audit carry the sandbox posture.
//   The LIVE-sandbox kernel-denial proof for AC5 lives in tests/claudecode-run.test.ts.
// ══════════════════════════════════════════════════════════════════════════════
describe("AC8 — auditable trail (grant.pending + grant.allow + invoke, scoped to the dir)", () => {
  it("after an approved write + a pending(denied) flow, the audit trail reconstructs what happened", async () => {
    // (a) auto-granted read + a real read invoke.
    const read = await H.requestGrant(WORKSPACE_READ_ID);
    await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${read.token}` },
      body: JSON.stringify({ id: WORKSPACE_READ_ID, input: { path: "me.md" } }),
    });

    // (b) a write grant that PENDS (audited grant.pending) then is APPROVED (audited grant.allow).
    const pend = await H.requestGrant(WORKSPACE_WRITE_ID);
    await H.approvePending(pend.pendingId!);
    const token = await H.awaitToken(pend.pendingId!);
    await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: WORKSPACE_WRITE_ID, input: { path: "PRD.html", content: "<h1>PRD</h1>" } }),
    });

    const audit = await H.readAuditTrail();
    const kinds = new Set(audit.map((e) => e.type));

    // The grant lifecycle is reconstructable: it PENDED for the owner, then was ALLOWED.
    expect(kinds.has("grant.pending")).toBe(true);
    expect(kinds.has("grant.allow")).toBe(true);
    expect(kinds.has("handshake")).toBe(true);

    // Both invokes are recorded WITH their capability ids — scoped to the workspace surface.
    const invokedCaps = audit.filter((e) => e.type === "invoke").map((e) => e.capabilityId);
    expect(invokedCaps).toContain(WORKSPACE_READ_ID);
    expect(invokedCaps).toContain(WORKSPACE_WRITE_ID);

    // Ordering sanity: the grant pended BEFORE it was allowed (a real human-in-the-loop record).
    const firstPending = audit.findIndex((e) => e.type === "grant.pending" && e.capabilityId === WORKSPACE_WRITE_ID);
    const firstAllow = audit.findIndex((e) => e.type === "grant.allow" && e.capabilityId === WORKSPACE_WRITE_ID);
    expect(firstPending).toBeGreaterThanOrEqual(0);
    expect(firstAllow).toBeGreaterThan(firstPending);
  });

  it("AC5 reference — claudecode.run record-mode result + audit carry sandboxed:true + the confinement posture", async () => {
    // Approve the execute grant (PENDS like write), then invoke in RECORD-MODE (no real CC spawn).
    const pend = await H.requestGrant(CLAUDECODE_RUN_ID);
    await H.approvePending(pend.pendingId!);
    const token = await H.awaitToken(pend.pendingId!);

    const inv = (await (await H.req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: CLAUDECODE_RUN_ID, input: { prompt: "scaffold the pomodoro app" } }),
    })).json()) as InvokeResponse;

    expect(inv.ok).toBe(true);
    const out = inv.output as Record<string, unknown>;
    // The result carries the sandbox posture: sandboxed, NOT launched (record-mode), confined to the dir.
    expect(out.sandboxed).toBe(true);
    expect(out.launched).toBe(false);
    // The jail is the authorized dir (compared via realpath — macOS symlinks /var → /private/var).
    expect(realpathSync(String(out.jail))).toBe(realpathSync(H.authorizedDir));
    expect((out.confinement as { mechanism?: string }).mechanism).toBe("sandbox-exec");

    // The audit carries the same posture (AC8 ∩ AC5): sandboxed + the confinement mechanism, prompt-redacted.
    const audit = await H.readAuditTrail();
    const ev = audit.find((e) => e.type === "invoke" && e.capabilityId === CLAUDECODE_RUN_ID)!;
    expect(ev).toBeTruthy();
    expect((ev.detail as Record<string, unknown>).sandboxed).toBe(true);
    expect((ev.detail as Record<string, unknown>).mechanism).toBe("sandbox-exec");
    expect(JSON.stringify(ev.detail)).not.toContain("scaffold the pomodoro app");
    // NOTE: the LIVE-sandbox kernel-denial proof for AC5 (real sandbox-exec confines a fake
    // claude: writes inside the jail OK, outside DENIED) lives in tests/claudecode-run.test.ts.
  });
});
