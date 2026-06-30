/**
 * Ed25519 mesh identity keys — the primary↔proxy trust boundary primitive
 * (federated-mesh §7 Q2).
 *
 * The mesh's SECOND trust boundary (distinct from today's agent↔primary HS256
 * connection-key) is Ed25519 MUTUAL AUTH: each gateway holds a long-lived
 * identity keypair; the counterpart's PUBLIC key is pinned at enrollment. This
 * module is the isolated leaf that owns:
 *
 *   - keypair GENERATION  (`generateKeyPairSync("ed25519")`),
 *   - LOAD / PERSIST of a long-lived per-gateway identity under
 *     `~/.plexus/mesh/identity/` (atomic write, owner-only private key —
 *     mirroring the `auth/secret.ts` + `core/paths.ts` persistence patterns),
 *   - SIGN / VERIFY over `node:crypto` (`crypto.sign`/`crypto.verify` with the
 *     null algorithm Ed25519 requires) — NO invented crypto,
 *   - a STABLE serialized public key for pinning (SPKI PEM + raw 32-byte base64).
 *
 * Why asymmetric here (vs. HS256 for agent tokens): the two tiers are separate
 * trust principals with separate lifecycles; neither should hold the other's
 * signing secret. Pinning a public key gives the verifier identity without a
 * shared secret, and works over an already-encrypted underlay (identity ⟂
 * encryption, per Q2).
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { join } from "node:path";
import { ensureDir, plexusHome, readFileBestEffort, atomicWrite } from "../core/paths.ts";

/** Sub-tree under `~/.plexus/` holding the long-lived mesh identity. */
const IDENTITY_DIR = ["mesh", "identity"];
/** PKCS#8 PEM of the Ed25519 PRIVATE key — credential material, owner-only. */
const PRIVATE_KEY_FILE = "id_ed25519";
/** SPKI PEM of the PUBLIC key — a public identifier, written for inspection/pinning. */
const PUBLIC_KEY_FILE = "id_ed25519.pub";

/** Anything `verify` will accept as the pinned counterpart public key. */
export type PublicKeyInput = KeyObject | string;

/**
 * A loaded mesh identity: the private half (kept in a `KeyObject`, never exported
 * off this object except as PEM for persistence) plus stable public serializations
 * for pinning, and a `sign` bound to this key.
 */
export interface MeshIdentity {
  /** SPKI PEM of the public key — the canonical pinning form. */
  readonly publicKeyPem: string;
  /** Raw 32-byte Ed25519 public key, standard-base64 encoded — compact pinning form. */
  readonly publicKeyRawBase64: string;
  /** Sign `data` with this identity's private key (Ed25519, deterministic). */
  sign(data: Buffer | string): Buffer;
}

// ── Private-key (PKCS#8 PEM) persistence ──────────────────────────────────────

let _cached: MeshIdentity | null = null;

/** Absolute path to the identity directory, ensuring it exists. */
function identityDir(): string {
  // homePath would only ensure the home root; the identity sub-tree needs its own
  // recursive mkdir (mirrors `ensureDir` usage elsewhere).
  ensureDir(plexusHome());
  return ensureDir(join(plexusHome(), ...IDENTITY_DIR));
}

function privateKeyPath(): string {
  return join(identityDir(), PRIVATE_KEY_FILE);
}

function publicKeyPath(): string {
  return join(identityDir(), PUBLIC_KEY_FILE);
}

// ── Serialization helpers ─────────────────────────────────────────────────────

function toBuffer(data: Buffer | string): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

/** SPKI PEM of a public `KeyObject`. */
function spkiPem(pub: KeyObject): string {
  return pub.export({ type: "spki", format: "pem" }) as string;
}

/**
 * Raw 32-byte Ed25519 public key, standard-base64 encoded. Derived from the JWK
 * `x` member (base64url) — the only built-in path to the bare key bytes.
 */
function rawBase64(pub: KeyObject): string {
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("mesh/keys: public key is not an Ed25519 OKP key");
  // JWK `x` is base64url; re-encode as standard base64 for a stable pinning string.
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** Build a `MeshIdentity` from a private `KeyObject` (public is derived). */
function identityFrom(privateKey: KeyObject): MeshIdentity {
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = spkiPem(publicKey);
  const publicKeyRawBase64 = rawBase64(publicKey);
  return {
    publicKeyPem,
    publicKeyRawBase64,
    sign(data: Buffer | string): Buffer {
      // Ed25519 mandates the null algorithm — it carries its own hashing.
      return cryptoSign(null, toBuffer(data), privateKey);
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Generate a FRESH (un-persisted) Ed25519 mesh identity. */
export function generateMeshIdentity(): MeshIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  return identityFrom(privateKey);
}

/**
 * Load the persisted per-gateway identity from `~/.plexus/mesh/identity/`, or
 * `undefined` if none is stored (or the file is unreadable/corrupt).
 */
export function loadMeshIdentity(): MeshIdentity | undefined {
  const pem = readFileBestEffort(privateKeyPath());
  if (!pem || pem.trim().length === 0) return undefined;
  try {
    return identityFrom(createPrivateKey(pem));
  } catch {
    // Corrupt/unparseable key material — treat as absent rather than crash.
    return undefined;
  }
}

/**
 * The long-lived per-gateway mesh identity: load the persisted one, or generate +
 * persist a fresh keypair on first use. Cached for the process lifetime. Best-effort
 * persistence — if the FS is unwritable the in-process identity still works for this
 * run (mirrors `auth/secret.ts`).
 */
export function loadOrCreateMeshIdentity(): MeshIdentity {
  if (_cached) return _cached;

  const existing = loadMeshIdentity();
  if (existing) {
    _cached = existing;
    return _cached;
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = identityFrom(privateKey);
  const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  try {
    // Private key = credential material → owner-only (0600).
    atomicWrite(privateKeyPath(), pkcs8Pem, 0o600);
    // Public key is a PUBLIC identifier → default perms, for inspection/pinning export.
    atomicWrite(publicKeyPath(), identity.publicKeyPem);
  } catch {
    /* best-effort persistence — authoritative identity stays in memory */
  }

  _cached = identity;
  return _cached;
}

// ── Pinned-pubkey import + verification ───────────────────────────────────────

/** Re-import a pinned public key from its SPKI PEM serialization. */
export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** Re-import a pinned public key from its raw 32-byte standard-base64 serialization. */
export function publicKeyFromRawBase64(b64: string): KeyObject {
  const x = Buffer.from(b64, "base64").toString("base64url");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/** Normalize any accepted pinned-pubkey form to a `KeyObject`. */
function toPublicKey(pubkey: PublicKeyInput): KeyObject {
  if (typeof pubkey === "string") {
    // A PEM block, else assume raw base64.
    return pubkey.includes("-----BEGIN") ? publicKeyFromPem(pubkey) : publicKeyFromRawBase64(pubkey);
  }
  return pubkey;
}

/**
 * Verify `sig` over `data` against a pinned `pubkey` (SPKI PEM string, raw-base64
 * string, or a `KeyObject`). Returns a boolean — NEVER throws on malformed input
 * (garbage/truncated signatures reject as `false`), so it is safe on the hot path.
 */
export function verify(pubkey: PublicKeyInput, data: Buffer | string, sig: Buffer): boolean {
  try {
    return cryptoVerify(null, toBuffer(data), toPublicKey(pubkey), sig);
  } catch {
    return false;
  }
}

/** Test-only: drop the cached identity so a fresh `PLEXUS_HOME` is re-read. */
export function _resetMeshIdentityCacheForTests(): void {
  _cached = null;
}
