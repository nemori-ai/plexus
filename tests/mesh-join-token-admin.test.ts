/**
 * A1 — Join-token mint surface (admin route). federated-mesh §7 Q3.
 *
 * The primary's `mintJoinToken()` authority was in-process only. This suite pins the
 * out-of-process surface (`POST /admin/api/mesh/join-token` + `GET /admin/api/mesh`):
 *
 *   1. PRIMARY MINTS — a started primary returns { token, tunnelPort, primaryPubKey };
 *      the token is a real, single-use admission token (the enrollment registry admits
 *      it once, then a replay is rejected `token_consumed`).
 *   2. WRONG MODE — a proxy gateway 409s (only a primary mints).
 *   3. ABSENT AUTHORITY — a primary whose mesh tunnel has NOT started 409s (no
 *      enrollment authority yet).
 *   4. AUTH — the blanket `/admin/api/*` management-key gate fronts the route: no key
 *      (or a wrong key) → 401.
 *   5. STATUS — GET /admin/api/mesh reports mode/tunnelPort/pubkey.
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import { buildEnrollRequest } from "@plexus/runtime/mesh/enrollment.ts";
import type { EnrollFramePayload } from "@plexus/protocol";

const config = loadConfig(); // no-env ⇒ primary mode
const HOST = expectedHost(config);
const dirs: string[] = [];

function freshHome(): void {
  const dir = mkdtempSync(join(tmpdir(), "plexus-a1-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
}

/** A request with a loopback Host. `key` controls the management header. */
function req(
  app: ReturnType<typeof createAppWithState>["app"],
  path: string,
  opts: { method?: string; body?: unknown; key?: string | null } = {},
) {
  const headers: Record<string, string> = { host: HOST };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key) headers["X-Plexus-Connection-Key"] = opts.key;
  return app.request("http://" + HOST + path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

afterAll(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("A1: a started PRIMARY mints a usable, single-use join token", () => {
  it("POST /admin/api/mesh/join-token → token + tunnelPort + primaryPubKey", async () => {
    freshHome();
    const primaryId = generateMeshIdentity();
    const built = createAppWithState(config, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId },
    });
    await built.state.mesh.start();
    const key = built.state.connectionKey.current();

    const res = await req(built.app, "/admin/api/mesh/join-token", { method: "POST", body: {}, key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      tunnelPort: number;
      primaryPubKey: string;
      expiresAt?: string;
    };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.tunnelPort).toBe(built.state.mesh.tunnelPort);
    expect(body.tunnelPort).toBeGreaterThan(0);
    expect(body.primaryPubKey).toBe(primaryId.publicKeyPem);

    // The minted token is a REAL pending admission token …
    const enrollment = built.state.mesh.enrollment!;
    const hash = createHash("sha256").update(body.token, "utf8").digest("hex");
    expect(enrollment.hasPendingToken(hash)).toBe(true);

    // … and it is SINGLE-USE: a full enroll admits it once, a replay is rejected.
    const proxyId = generateMeshIdentity();
    const payload: EnrollFramePayload = {
      workload: "laptop",
      mode: "proxy",
      proxyPubKey: proxyId.publicKeyPem,
      joinToken: body.token,
    };
    const enrollReq = buildEnrollRequest(payload, proxyId);
    const first = enrollment.admit(enrollReq, primaryId);
    expect(first.ok).toBe(true);
    const replay = enrollment.admit(enrollReq, primaryId);
    expect(replay.ok).toBe(false);
    expect((replay as { reason: string }).reason).toBe("token_consumed");

    built.state.mesh.stop();
  });

  it("honors a --ttl (ttlMs) and rejects a malformed ttlMs with 400", async () => {
    freshHome();
    const built = createAppWithState(config, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: generateMeshIdentity() },
    });
    await built.state.mesh.start();
    const key = built.state.connectionKey.current();

    const ok = await req(built.app, "/admin/api/mesh/join-token", { method: "POST", body: { ttlMs: 60_000 }, key });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { expiresAt?: string };
    expect(typeof okBody.expiresAt).toBe("string");

    const bad = await req(built.app, "/admin/api/mesh/join-token", { method: "POST", body: { ttlMs: -1 }, key });
    expect(bad.status).toBe(400);

    built.state.mesh.stop();
  });

  it("GET /admin/api/mesh reports mode/tunnelPort/pubkey", async () => {
    freshHome();
    const primaryId = generateMeshIdentity();
    const built = createAppWithState(config, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId },
    });
    await built.state.mesh.start();
    const key = built.state.connectionKey.current();

    const res = await req(built.app, "/admin/api/mesh", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; tunnelPort: number; primaryPubKey?: string };
    expect(body.mode).toBe("primary");
    expect(body.tunnelPort).toBeGreaterThan(0);
    expect(body.primaryPubKey).toBe(primaryId.publicKeyPem);

    built.state.mesh.stop();
  });
});

describe("A1: mint refuses when this gateway cannot be the authority (409)", () => {
  it("a PROXY gateway → 409 (only a primary mints)", async () => {
    freshHome();
    const proxyConfig: GatewayConfig = {
      ...config,
      mode: "proxy",
      upstream: { url: "ws://127.0.0.1:1", primaryPubKey: generateMeshIdentity().publicKeyPem },
    };
    const built = createAppWithState(proxyConfig, { authorizer: new AutoApproveAuthorizer() });
    const key = built.state.connectionKey.current();

    const res = await req(built.app, "/admin/api/mesh/join-token", { method: "POST", body: {}, key });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("mesh_not_primary");
  });

  it("a PRIMARY whose mesh has NOT started → 409 (no enrollment authority)", async () => {
    freshHome();
    const built = createAppWithState(config, { authorizer: new AutoApproveAuthorizer() });
    const key = built.state.connectionKey.current();
    // No `mesh.start()` ⇒ enrollment registry absent.
    const res = await req(built.app, "/admin/api/mesh/join-token", { method: "POST", body: {}, key });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("mesh_not_started");
  });
});

describe("A1: the management-key gate fronts the mint route", () => {
  it("no key → 401", async () => {
    freshHome();
    const built = createAppWithState(config, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: generateMeshIdentity() },
    });
    await built.state.mesh.start();
    const res = await req(built.app, "/admin/api/mesh/join-token", { method: "POST", body: {} });
    expect(res.status).toBe(401);
    built.state.mesh.stop();
  });

  it("a WRONG key → 401 (the key is verified, not just present)", async () => {
    freshHome();
    const built = createAppWithState(config, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: generateMeshIdentity() },
    });
    await built.state.mesh.start();
    const res = await req(built.app, "/admin/api/mesh/join-token", {
      method: "POST",
      body: {},
      key: "plx_live_not_the_real_key",
    });
    expect(res.status).toBe(401);
    built.state.mesh.stop();
  });
});
