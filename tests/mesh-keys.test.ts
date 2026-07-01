/**
 * T3 — Ed25519 mesh identity keys (federated-mesh §7 Q2).
 *
 * The primary↔proxy trust boundary uses Ed25519 mutual auth with pubkeys pinned
 * at enrollment. This is the leaf primitive: keypair gen/load/persist + a
 * sign/verify pair over `node:crypto` (no invented crypto). These tests assert:
 *
 *   - HAPPY PATH    — verify(sign(nonce)) === true (deterministic over the same key).
 *   - TAMPER        — wrong pubkey, mutated data, mutated signature → ALL reject.
 *   - PERSISTENCE   — generate → persist → load yields the SAME identity that
 *                     still verifies a signature made by the original.
 *   - PUBKEY EXPORT — a stable serialized pubkey (SPKI PEM + raw base64) round-trips
 *                     through verify, i.e. it is a usable pinning form.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateMeshIdentity,
  loadMeshIdentity,
  loadOrCreateMeshIdentity,
  verify,
  publicKeyFromPem,
  publicKeyFromRawBase64,
  _resetMeshIdentityCacheForTests,
} from "@plexus/runtime/mesh/keys.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-keys-"));
  process.env.PLEXUS_HOME = home;
  _resetMeshIdentityCacheForTests();
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  _resetMeshIdentityCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

const NONCE = Buffer.from("enrollment-challenge-nonce-deadbeef", "utf8");

describe("mesh keys — happy path", () => {
  it("verifies a signature made over a nonce (deterministic across calls)", () => {
    const id = generateMeshIdentity();
    const sig = id.sign(NONCE);

    // verify with the identity's own exported pubkey (PEM) — the pinning form.
    expect(verify(id.publicKeyPem, NONCE, sig)).toBe(true);

    // Ed25519 is deterministic: signing the same data yields the same signature,
    // and verification is stable across repeated calls.
    const sig2 = id.sign(NONCE);
    expect(sig2.equals(sig)).toBe(true);
    expect(verify(id.publicKeyPem, NONCE, sig2)).toBe(true);
  });

  it("accepts string data as well as Buffers", () => {
    const id = generateMeshIdentity();
    const sig = id.sign("hello-mesh");
    expect(verify(id.publicKeyPem, "hello-mesh", sig)).toBe(true);
  });
});

describe("mesh keys — tamper cases all reject", () => {
  it("TAMPER 1: wrong pubkey rejects", () => {
    const signer = generateMeshIdentity();
    const other = generateMeshIdentity();
    const sig = signer.sign(NONCE);
    expect(verify(other.publicKeyPem, NONCE, sig)).toBe(false);
  });

  it("TAMPER 2: mutated data rejects", () => {
    const id = generateMeshIdentity();
    const sig = id.sign(NONCE);
    const mutated = Buffer.from(NONCE);
    mutated.writeUInt8(mutated.readUInt8(0) ^ 0xff, 0);
    expect(verify(id.publicKeyPem, mutated, sig)).toBe(false);
  });

  it("TAMPER 3: mutated signature rejects", () => {
    const id = generateMeshIdentity();
    const sig = id.sign(NONCE);
    const badSig = Buffer.from(sig);
    const last = badSig.length - 1;
    badSig.writeUInt8(badSig.readUInt8(last) ^ 0x01, last);
    expect(verify(id.publicKeyPem, NONCE, badSig)).toBe(false);
  });

  it("TAMPER 4: truncated/garbage signature rejects without throwing", () => {
    const id = generateMeshIdentity();
    expect(verify(id.publicKeyPem, NONCE, Buffer.alloc(0))).toBe(false);
    expect(verify(id.publicKeyPem, NONCE, Buffer.from("not-a-signature"))).toBe(false);
  });
});

describe("mesh keys — persistence round-trip", () => {
  it("generate → persist → load yields the SAME identity that still verifies", () => {
    const original = loadOrCreateMeshIdentity(); // generates + persists on first use
    const sig = original.sign(NONCE);

    // Drop the in-process cache so load reads purely from disk.
    _resetMeshIdentityCacheForTests();

    const loaded = loadMeshIdentity();
    expect(loaded).toBeDefined();
    // Same identity ⇒ identical exported public key.
    expect(loaded!.publicKeyPem).toBe(original.publicKeyPem);
    expect(loaded!.publicKeyRawBase64).toBe(original.publicKeyRawBase64);
    // A signature minted by the ORIGINAL verifies under the LOADED pubkey…
    expect(verify(loaded!.publicKeyPem, NONCE, sig)).toBe(true);
    // …and a fresh signature from the loaded key verifies under the original pubkey.
    expect(verify(original.publicKeyPem, NONCE, loaded!.sign(NONCE))).toBe(true);
  });

  it("loadOrCreateMeshIdentity is stable across calls (same persisted identity)", () => {
    const a = loadOrCreateMeshIdentity();
    const b = loadOrCreateMeshIdentity();
    expect(b.publicKeyPem).toBe(a.publicKeyPem);
  });

  it("loadMeshIdentity returns undefined when no identity persisted", () => {
    expect(loadMeshIdentity()).toBeUndefined();
  });

  it("persists the private key owner-only (0600) under mesh/identity/", () => {
    loadOrCreateMeshIdentity();
    const keyPath = join(home, "mesh", "identity", "id_ed25519");
    expect(existsSync(keyPath)).toBe(true);
    // Owner-only — credential material (skip exact bits on non-POSIX).
    if (process.platform !== "win32") {
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe("mesh keys — pubkey export forms are usable for pinning", () => {
  it("SPKI PEM round-trips through publicKeyFromPem into verify", () => {
    const id = generateMeshIdentity();
    const sig = id.sign(NONCE);
    const pinned = publicKeyFromPem(id.publicKeyPem);
    expect(verify(pinned, NONCE, sig)).toBe(true);
  });

  it("raw base64 round-trips through publicKeyFromRawBase64 into verify", () => {
    const id = generateMeshIdentity();
    const sig = id.sign(NONCE);
    const pinned = publicKeyFromRawBase64(id.publicKeyRawBase64);
    expect(verify(pinned, NONCE, sig)).toBe(true);
    // Raw Ed25519 public keys are 32 bytes.
    expect(Buffer.from(id.publicKeyRawBase64, "base64").length).toBe(32);
  });

  it("a pubkey re-imported from raw base64 of a DIFFERENT key rejects", () => {
    const signer = generateMeshIdentity();
    const other = generateMeshIdentity();
    const sig = signer.sign(NONCE);
    expect(verify(publicKeyFromRawBase64(other.publicKeyRawBase64), NONCE, sig)).toBe(false);
  });
});
