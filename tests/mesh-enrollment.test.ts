/**
 * T5 — Enrollment handshake (mutual Ed25519) — federated-mesh §3.1, Inv F, §7 Q2/Q3.
 *
 * The SECOND trust boundary (primary↔proxy), default-deny / fail-closed. These tests
 * cover BOTH halves:
 *
 *   REGISTRY INVARIANTS (unit):
 *     - one-time token CONSUME (a token admits exactly once)
 *     - workload UNIQUENESS under the primary (Invariant F)
 *     - token is persisted HASHED, never in plaintext
 *
 *   HANDSHAKE (integration over the real registry + real Ed25519 keys):
 *     - HAPPY PATH       — admit + pin + persist + MUTUAL verify; zero-exposure marker
 *     - REUSED TOKEN     — second use of a consumed token rejects (replay guard)
 *     - DUPLICATE WORKLOAD — same active workload name rejects (Inv F)
 *     - BAD SIGNATURE    — tampered/foreign signature rejects
 *     - UNKNOWN/EXPIRED TOKEN — never-minted and past-TTL tokens reject
 *
 *   Every rejection asserts NO partial state (token not consumed where it must
 *   survive, no record written, ledger unchanged on disk).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { EnrollFramePayload } from "@plexus/protocol";

import { generateMeshIdentity, type MeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import {
  EnrollmentRegistry,
  createEnrollmentRegistry,
  buildEnrollRequest,
  verifyEnrollAccepted,
  samePublicKey,
  type EnrollAccepted,
} from "@plexus/runtime/mesh/enrollment.ts";

let home: string;
let primary: MeshIdentity;
let proxy: MeshIdentity;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-enroll-"));
  process.env.PLEXUS_HOME = home;
  primary = generateMeshIdentity();
  proxy = generateMeshIdentity();
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** A well-formed proxy claim for `workload`, pinning the proxy's own pubkey. */
function claim(workload: string, token: string, proxyId: MeshIdentity = proxy): EnrollFramePayload {
  return {
    workload,
    mode: "proxy",
    proxyPubKey: proxyId.publicKeyPem,
    joinToken: token,
    upstream: { url: "ws://primary.local:9443", primaryPubKey: primary.publicKeyPem },
  };
}

const ledgerPath = () => join(home, "mesh", "enrollments.json");

// ── Registry invariants (unit) ─────────────────────────────────────────────────

describe("enrollment registry — token is hashed, never plaintext", () => {
  it("persists only the sha256 hash of a minted token", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token, tokenHash } = reg.mintJoinToken();

    expect(existsSync(ledgerPath())).toBe(true);
    const onDisk = readFileSync(ledgerPath(), "utf8");
    // The raw secret must NEVER touch disk; its hash must.
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(tokenHash);
  });

  it("stores the join-token hash (not the token) on the admitted record", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token } = reg.mintJoinToken();
    const out = reg.admit(buildEnrollRequest(claim("laptop", token), proxy), primary);
    expect(out.ok).toBe(true);

    const onDisk = readFileSync(ledgerPath(), "utf8");
    expect(onDisk).not.toContain(token);
    if (out.ok) expect(out.record.joinTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

describe("enrollment registry — one-time token consume", () => {
  it("consumes a token on successful admit (no longer pending)", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token, tokenHash } = reg.mintJoinToken();
    expect(reg.hasPendingToken(tokenHash)).toBe(true);
    expect(reg.pendingTokenCount).toBe(1);

    const out = reg.admit(buildEnrollRequest(claim("w1", token), proxy), primary);
    expect(out.ok).toBe(true);
    expect(reg.hasPendingToken(tokenHash)).toBe(false);
    expect(reg.pendingTokenCount).toBe(0);
  });

  it("rejects a reused token and writes no second record (replay guard)", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token } = reg.mintJoinToken();

    expect(reg.admit(buildEnrollRequest(claim("w1", token), proxy), primary).ok).toBe(true);
    // Reuse the SAME token for a DIFFERENT workload so it is not caught by uniqueness.
    const second = reg.admit(buildEnrollRequest(claim("w2", token), proxy), primary);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("token_consumed");
    // No partial state: w2 never admitted.
    expect(reg.isActive("w2")).toBe(false);
    expect(reg.list().length).toBe(1);
  });
});

describe("enrollment registry — workload uniqueness (Invariant F)", () => {
  it("rejects a second active enrollment of the same workload name", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const t1 = reg.mintJoinToken().token;
    const t2 = reg.mintJoinToken().token;

    expect(reg.admit(buildEnrollRequest(claim("dup", t1), proxy), primary).ok).toBe(true);
    // A different proxy identity + a fresh valid token, but the same workload name.
    const otherProxy = generateMeshIdentity();
    const out = reg.admit(buildEnrollRequest(claim("dup", t2, otherProxy), otherProxy), primary);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("duplicate_workload");

    // The duplicate's token must remain UNCONSUMED (no partial state) and the original
    // pin must be untouched.
    expect(reg.hasPendingToken(createHash("sha256").update(t2).digest("hex"))).toBe(true);
    expect(reg.get("dup")!.pinnedProxyPubKey).toBe(proxy.publicKeyPem);
    expect(reg.list().length).toBe(1);
  });
});

// ── Durable consume (L1) ────────────────────────────────────────────────────────

describe("enrollment registry — durable consume (L1)", () => {
  it("surfaces a persist failure as an admission failure and leaves the token pending", () => {
    const dir = join(home, "ledger-ro");
    mkdirSync(dir);
    const path = join(dir, "enrollments.json");
    const reg = new EnrollmentRegistry(path);
    const { token, tokenHash } = reg.mintJoinToken(); // writes fine (dir still writable)

    // Make the ledger directory unwritable so the DURABLE (fsync'd) admit write fails.
    chmodSync(dir, 0o500);
    try {
      const out = reg.admit(buildEnrollRequest(claim("w", token), proxy), primary);
      // The token can NOT be reported consumed if the consume could not be persisted —
      // otherwise a crash + reload would resurrect the one-time token (L1).
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("persist_failed");

      // ROLLED BACK: token still pending (the legit proxy can retry), nothing admitted.
      expect(reg.hasPendingToken(tokenHash)).toBe(true);
      expect(reg.isActive("w")).toBe(false);
      expect(reg.list().length).toBe(0);
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach cleanup can remove the tree
    }
  });
});

// ── Handshake integration ───────────────────────────────────────────────────────

describe("enrollment handshake — happy path (admit + pin + persist + mutual)", () => {
  it("admits a valid token+signature, pins the proxy key, and mutually verifies", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token } = reg.mintJoinToken({ ttlMs: 60_000 });
    const payload = claim("laptop", token);
    const request = buildEnrollRequest(payload, proxy);

    const out = reg.admit(request, primary);
    expect(out.ok).toBe(true);
    const accepted = out as EnrollAccepted;

    // PIN: the record pins exactly the proxy's pubkey.
    expect(samePublicKey(accepted.record.pinnedProxyPubKey, proxy.publicKeyPem)).toBe(true);
    expect(accepted.record.status).toBe("active");

    // ZERO-EXPOSURE (§7 Q3): the fresh workload's caps default hidden.
    expect(accepted.record.exposureDefault).toBe("hidden");
    expect(reg.exposureDefaultFor("laptop")).toBe("hidden");

    // MUTUAL: the proxy verifies the primary's reply + pins the primary key. The
    // configured upstream.primaryPubKey matches, so the pin check passes.
    expect(verifyEnrollAccepted(payload, accepted)).toBe(true);
    expect(samePublicKey(accepted.primaryPubKey, primary.publicKeyPem)).toBe(true);

    // PERSIST: a fresh registry over the same home sees the admitted record + the
    // consumed token (durable across "restart").
    const reloaded = createEnrollmentRegistry();
    expect(reloaded.isActive("laptop")).toBe(true);
    expect(reloaded.get("laptop")!.exposureDefault).toBe("hidden");
    expect(reloaded.pendingTokenCount).toBe(0);
  });

  it("proxy REJECTS a primary reply that fails the configured pin (MITM substitution)", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token } = reg.mintJoinToken();
    const payload = claim("laptop", token);
    const out = reg.admit(buildEnrollRequest(payload, proxy), primary);
    expect(out.ok).toBe(true);
    const accepted = out as EnrollAccepted;

    // A different configured pin than the key the primary actually returned ⇒ reject,
    // even though the signature itself is valid.
    const attacker = generateMeshIdentity();
    expect(verifyEnrollAccepted(payload, accepted, { pinnedPrimaryPubKey: attacker.publicKeyPem })).toBe(false);
  });
});

describe("enrollment handshake — rejection paths (fail-closed, no partial state)", () => {
  it("rejects an UNKNOWN token (never minted here)", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const out = reg.admit(buildEnrollRequest(claim("w", "forged-token-not-minted"), proxy), primary);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unknown_token");
    expect(reg.list().length).toBe(0);
    // Nothing was persisted (no admit, no mint after construction).
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it("rejects an EXPIRED token and admits nothing", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token, tokenHash } = reg.mintJoinToken({ ttlMs: 1_000 });
    // now() pushed past the TTL.
    const out = reg.admit(buildEnrollRequest(claim("w", token), proxy), primary, new Date(Date.now() + 5_000));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("token_expired");
    expect(reg.isActive("w")).toBe(false);
    // The dead token is pruned, not consumed-into-a-record.
    expect(reg.hasPendingToken(tokenHash)).toBe(false);
    expect(reg.list().length).toBe(0);
  });

  it("rejects a BAD signature (tampered payload) and leaves the token pending", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token, tokenHash } = reg.mintJoinToken();
    const payload = claim("w", token);
    const request = buildEnrollRequest(payload, proxy);
    // Tamper AFTER signing: the signature no longer matches the (mutated) transcript.
    const tampered = { ...request, payload: { ...payload, workload: "evil" } };

    const out = reg.admit(tampered, primary);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("bad_signature");
    // Fail-closed: token NOT consumed (legit proxy can retry), nothing admitted.
    expect(reg.hasPendingToken(tokenHash)).toBe(true);
    expect(reg.isActive("evil")).toBe(false);
    expect(reg.list().length).toBe(0);
  });

  it("rejects a signature made by the WRONG key (foreign signer)", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token, tokenHash } = reg.mintJoinToken();
    const payload = claim("w", token); // pins the real proxy key…
    const attacker = generateMeshIdentity();
    const forged = buildEnrollRequest(payload, attacker); // …but signed by the attacker

    const out = reg.admit(forged, primary);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("bad_signature");
    expect(reg.hasPendingToken(tokenHash)).toBe(true);
    expect(reg.list().length).toBe(0);
  });

  it("rejects a non-proxy mode claim", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const { token } = reg.mintJoinToken();
    const payload = { ...claim("w", token), mode: "primary" as const };
    const out = reg.admit(buildEnrollRequest(payload, proxy), primary);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("wrong_mode");
  });

  it("rejects a malformed claim (empty workload / missing token)", () => {
    const reg = new EnrollmentRegistry(ledgerPath());
    const empty = reg.admit({ payload: { workload: "", mode: "proxy", proxyPubKey: proxy.publicKeyPem, joinToken: "x" }, sig: "AA" }, primary);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("malformed");
  });
});
