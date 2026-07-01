/**
 * T11 — targeted coverage gap-fill (federated-mesh §7 / phase-1 plan seam (b)).
 *
 * The narrative walking-skeleton (mesh-e2e-walking-skeleton) + the per-task specs cover the
 * HAPPY spine and the security boundary. These small unit probes close the remaining real,
 * un-exercised branches the coverage report flagged — NOT padding:
 *
 *   • frames.ts  — the binary-payload decode paths (ArrayBuffer / ArrayBufferView) and the
 *     malformed-frame throw (the mux's fail-closed catch-and-drop guard).
 *   • handshake.ts — the proxy-driver FAILURE branches: a malformed inbound message, an
 *     `auth-fail` from the primary, an `enroll-result` rejection, and an out-of-phase
 *     ("unexpected") message — every one fails closed.
 */

import { describe, it, expect } from "bun:test";
import type { Frame } from "@plexus/protocol";

import { decodeFrame, decodeText, encodeFrame } from "@plexus/runtime/mesh/frames.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import { createProxyHandshakeDriver } from "@plexus/runtime/mesh/handshake.ts";

// ── frames.ts — binary decode paths + malformed guard ───────────────────────────

describe("mesh/frames — binary payload normalization + malformed guard", () => {
  const frame: Frame = { t: "ping", corr: "c1" } as Frame;

  it("decodeFrame accepts a Uint8Array (ArrayBufferView) payload", () => {
    const bytes = new TextEncoder().encode(encodeFrame(frame)); // Uint8Array view
    expect(decodeFrame(bytes)).toEqual(frame);
  });

  it("decodeFrame accepts a raw ArrayBuffer payload", () => {
    const view = new TextEncoder().encode(encodeFrame(frame));
    const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    expect(decodeFrame(ab)).toEqual(frame);
  });

  it("decodeText normalizes an ArrayBufferView to its UTF-8 text", () => {
    const bytes = new TextEncoder().encode("hello-bytes");
    expect(decodeText(bytes)).toBe("hello-bytes");
  });

  it("decodeFrame THROWS on JSON that is missing the t/corr discriminants (fail-closed)", () => {
    expect(() => decodeFrame(JSON.stringify({ nope: 1 }))).toThrow(/malformed frame/);
    expect(() => decodeFrame(JSON.stringify({ t: "ping" }))).toThrow(/malformed frame/); // no corr
  });
});

// ── handshake.ts — proxy-driver failure branches (all fail-closed) ──────────────

describe("mesh/handshake — proxy driver fails closed on bad/out-of-phase input", () => {
  const primary = generateMeshIdentity();

  function driver(joinToken?: string) {
    return createProxyHandshakeDriver({
      workload: "w",
      identity: generateMeshIdentity(),
      pinnedPrimaryPubKey: primary.publicKeyPem,
      upstreamUrl: "ws://primary.local",
      joinToken,
    });
  }

  it("a malformed (non-JSON) inbound message fails the handshake", () => {
    const d = driver();
    d.open();
    const step = d.next("this-is-not-json{");
    expect(step.fail).toMatch(/malformed handshake message/);
  });

  it("an `auth-fail` from the primary aborts the handshake with the reason", () => {
    const d = driver();
    d.open();
    const step = d.next(JSON.stringify({ h: "auth-fail", reason: "not_enrolled" }));
    expect(step.fail).toMatch(/primary rejected auth: not_enrolled/);
  });

  it("an `enroll-result` rejection (enroll leg) fails closed with the reason", () => {
    const d = driver("a-join-token"); // joinToken ⇒ enroll leg
    const opened = d.open();
    expect(JSON.parse(opened!).h).toBe("enroll"); // proves we are in the enroll phase
    const step = d.next(JSON.stringify({ h: "enroll-result", outcome: { ok: false, reason: "duplicate_workload" } }));
    expect(step.fail).toMatch(/enroll rejected: duplicate_workload/);
  });

  it("an out-of-phase (unexpected) message fails closed", () => {
    const d = driver();
    d.open(); // now in auth-init, expecting an auth-challenge
    const step = d.next(JSON.stringify({ h: "auth-ok" })); // wrong message for this phase
    expect(step.fail).toMatch(/unexpected handshake message 'auth-ok'/);
  });
});
