/**
 * A2-PATAUTH — per-agent PAT at the handshake (agent-skill-compile §3, §9 #1, Inv III).
 *
 * The handshake's agent credential moves from the shared connection-key + a self-asserted
 * `agentId` to a per-agent bearer PAT. The load-bearing security property: the session's
 * bound `agentId` comes from the VERIFIED PAT and is NOT overridable by a client-supplied
 * string — so an agent can no longer spoof another agent's identity. The connection-key
 * stays a distinct, admin-only management credential and keeps working.
 *
 * Covers:
 *   - valid PAT → session bound to the PAT's REAL agentId (client.agentId ignored);
 *   - a client that supplies a DIFFERENT agentId cannot override the PAT-derived one;
 *   - forged / revoked / absent PAT → clean 401, no session;
 *   - admin connection-key path still opens a session (management surface preserved);
 *   - a Bearer PAT wins over a body connectionKey (agent path selected by credential).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import type { HandshakeResponse, ErrorResponse } from "@plexus/protocol";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plexus-pat-handshake-"));
  process.env.PLEXUS_HOME = home;
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  rmSync(home, { recursive: true, force: true });
});

const config = loadConfig();
const HOST = expectedHost(config);

function freshApp() {
  _resetSecretCacheForTests();
  return createAppWithState(config);
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Mint + redeem an enrollment code the way an agent would, returning its durable PAT. */
function enroll(state: ReturnType<typeof freshApp>["state"], agentId: string): string {
  const { code } = state.agentEnrollment.mintEnrollmentCode(agentId);
  const out = state.agentEnrollment.redeemEnrollmentCode(code);
  if (!out.ok) throw new Error(`enroll failed: ${out.reason}`);
  return out.pat;
}

describe("POST /link/handshake — per-agent PAT auth", () => {
  it("a valid PAT opens a session bound to the PAT's REAL agentId", async () => {
    const { app, state } = freshApp();
    const pat = enroll(state, "agent-real");

    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
      body: JSON.stringify({ client: { name: "cc" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HandshakeResponse;
    expect(body.sessionId).toMatch(/^sess_/);
    expect(state.sessions.get(body.sessionId)?.agentId).toBe("agent-real");
    // Full manifest is returned exactly as on the connection-key path.
    expect(Array.isArray(body.manifest.entries)).toBe(true);
    expect(body.grantsUrl).toContain("/grants");
  });

  it("a PAT works with NO request body at all (PAT-only agent)", async () => {
    const { app, state } = freshApp();
    const pat = enroll(state, "agent-nobody");

    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HandshakeResponse;
    expect(state.sessions.get(body.sessionId)?.agentId).toBe("agent-nobody");
  });

  it("a client-supplied DIFFERENT agentId CANNOT override the PAT-derived identity (no spoof)", async () => {
    const { app, state } = freshApp();
    const pat = enroll(state, "agent-true");

    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
      // Attacker tries to act as "victim-agent" while authenticating as agent-true.
      body: JSON.stringify({ client: { name: "cc", agentId: "victim-agent" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HandshakeResponse;
    // Bound to the PAT owner, NEVER the spoofed string.
    expect(state.sessions.get(body.sessionId)?.agentId).toBe("agent-true");
    expect(state.sessions.get(body.sessionId)?.agentId).not.toBe("victim-agent");
  });

  it("a forged / never-issued PAT fails cleanly with 401 and opens NO session", async () => {
    const { app, state } = freshApp();
    const before = state.sessions.all().length;

    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: "Bearer plx_agent_totally-forged" },
      body: JSON.stringify({ client: { agentId: "agent-x" } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("session_expired");
    expect(state.sessions.all().length).toBe(before); // no session created
  });

  it("a REVOKED agent's PAT no longer handshakes (401)", async () => {
    const { app, state } = freshApp();
    const pat = enroll(state, "agent-doomed");
    expect(state.agentEnrollment.revoke("agent-doomed")).toBe(true);

    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorResponse).error.code).toBe("session_expired");
  });

  it("a Bearer PAT does NOT fall through to a connectionKey when invalid (agent attempt is final)", async () => {
    const { app, state } = freshApp();
    // Present the VALID admin connection-key in the body alongside a FORGED bearer: because a
    // bearer is present the request is an agent auth attempt and must fail — the connection-key
    // is not a fallback that a forged bearer can smuggle past.
    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: "Bearer plx_agent_forged" },
      body: JSON.stringify({ connectionKey: state.connectionKey.current() }),
    });
    expect(res.status).toBe(401);
  });

  it("a valid Bearer PAT wins over a body connectionKey (credential-presence selects the path)", async () => {
    const { app, state } = freshApp();
    const pat = enroll(state, "agent-both");
    const res = await req(app, "/link/handshake", {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
      body: JSON.stringify({
        connectionKey: state.connectionKey.current(),
        client: { agentId: "someone-else" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HandshakeResponse;
    expect(state.sessions.get(body.sessionId)?.agentId).toBe("agent-both");
  });
});

describe("POST /link/handshake — admin connection-key path preserved (Inv III)", () => {
  it("a valid connection-key still opens a management session (no PAT required)", async () => {
    const { app, state } = freshApp();
    const res = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: state.connectionKey.current(), client: { name: "mgmt", agentId: "agent-1" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HandshakeResponse;
    expect(body.sessionId).toMatch(/^sess_/);
    expect(Array.isArray(body.manifest.entries)).toBe(true);
    // The admin (holding the connection-key) may legitimately name the agentId it manages.
    expect(state.sessions.get(body.sessionId)?.agentId).toBe("agent-1");
  });

  it("a bad connection-key with NO bearer is a clean 401", async () => {
    const { app } = freshApp();
    const res = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: "plx_live_wrong" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorResponse).error.code).toBe("session_expired");
  });

  it("neither credential → clean 401 (no session)", async () => {
    const { app, state } = freshApp();
    const before = state.sessions.all().length;
    const res = await req(app, "/link/handshake", { method: "POST", body: JSON.stringify({ client: { name: "x" } }) });
    expect(res.status).toBe(401);
    expect(state.sessions.all().length).toBe(before);
  });
});
