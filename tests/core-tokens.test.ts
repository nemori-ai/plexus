/**
 * Scoped-token sign/verify/refresh + revocation registry (t6, §4 / ADR-006).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  signToken,
  verifyToken,
  verifyTokenForRefresh,
  createRevocationRegistry,
  TokenExpiredError,
  TokenInvalidError,
  getInstanceId,
  _resetSecretCacheForTests,
} from "@plexus/runtime/auth/index.ts";
import type { TokenScope } from "@plexus/protocol";

const SCOPES: TokenScope[] = [{ id: "mock.note.read", verbs: ["read"] }];
let dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "plexus-tok-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

describe("signToken / verifyToken", () => {
  it("signs a JWT that verifies and round-trips its claims", () => {
    const { token, claims } = signToken({
      sub: "agent-1",
      iss: getInstanceId(),
      sessionId: "sess_x",
      scopes: SCOPES,
    });
    expect(token.split(".").length).toBe(3);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe("agent-1");
    expect(decoded.sessionId).toBe("sess_x");
    expect(decoded.jti).toBe(claims.jti);
    expect(decoded.scopes).toEqual(SCOPES);
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  // FIX-4: gexp (grant/trust-window expiry, epoch seconds) is emitted when the
  // backing grant expiry is supplied, and omitted otherwise (no dangling field).
  it("emits gexp (epoch seconds) when grantExpiresAtMs is supplied", () => {
    const grantExpiresAtMs = Date.parse("2027-01-01T00:00:00.000Z");
    const { token, claims } = signToken({
      sub: "agent-g",
      iss: getInstanceId(),
      sessionId: "sess_g",
      scopes: SCOPES,
      grantExpiresAtMs,
    });
    const expectedGexp = Math.floor(grantExpiresAtMs / 1000);
    expect(claims.gexp).toBe(expectedGexp);
    // The emitted claim survives a sign→verify round-trip in the signed JWT body.
    expect(verifyToken(token).gexp).toBe(expectedGexp);
  });

  it("omits gexp when no grant expiry is supplied", () => {
    const { claims } = signToken({ sub: "a", iss: "i", sessionId: "s", scopes: SCOPES });
    expect(claims.gexp).toBeUndefined();
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const { token } = signToken({ sub: "a", iss: "i", sessionId: "s", scopes: SCOPES });
    const [h, , sig] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "evil", scopes: [] })).toString("base64url");
    const forged = `${h}.${forgedPayload}.${sig}`;
    expect(() => verifyToken(forged)).toThrow(TokenInvalidError);
  });

  it("rejects an expired token for invoke but accepts it within the refresh grace", () => {
    const { token } = signToken({
      sub: "a",
      iss: "i",
      sessionId: "s",
      scopes: SCOPES,
      lifetimeMs: -1000, // already expired
    });
    expect(() => verifyToken(token)).toThrow(TokenExpiredError);
    // verifyTokenForRefresh tolerates a just-expired token (within grace).
    const claims = verifyTokenForRefresh(token);
    expect(claims.sub).toBe("a");
  });
});

describe("revocation registry", () => {
  it("revokes a jti and persists it", () => {
    const reg = createRevocationRegistry();
    expect(reg.isRevoked("tok_1")).toBe(false);
    reg.revoke("tok_1", "test");
    expect(reg.isRevoked("tok_1")).toBe(true);
    // A fresh registry over the same PLEXUS_HOME re-reads the persisted set.
    const reg2 = createRevocationRegistry();
    expect(reg2.isRevoked("tok_1")).toBe(true);
  });
});
