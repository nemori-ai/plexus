/**
 * Enrollment aggregate — the proxy↔primary JOIN handshake and its durable ledger
 * (federated-mesh §3.1, Invariant F, §7 Q2/Q3; phase-1 plan seam (c) / T5).
 *
 * THIS IS THE SECOND TRUST BOUNDARY of the mesh, and it is SECURITY-CRITICAL. It is
 * NOT the agent↔primary boundary (that is the HS256 connection-key / JWT wire, which
 * this module never touches). It is the primary↔proxy boundary: a subordinate proxy
 * gateway proves, ONCE at join, that (a) it bears a valid one-time admission token the
 * primary itself minted, and (b) it controls the Ed25519 private key whose public half
 * the primary will PIN for every subsequent tunnel message. In return the primary
 * proves ITS identity to the proxy (mutual auth, §7 Q2). Everything here is
 * DEFAULT-DENY / FAIL-CLOSED: any malformed frame, bad/expired/reused token, or bad
 * signature rejects, admits nothing, and persists nothing.
 *
 * The flow (one `enroll` frame, request/reply over the T4 tunnel mux):
 *
 *   PROXY                                            PRIMARY (authority)
 *   ─────                                            ───────────────────
 *   buildEnrollRequest(payload, proxyId)             registry.mintJoinToken()  ← out-of-band
 *     signs role-tagged transcript with proxy key      delivers raw token to proxy operator
 *        │  { payload, sig }  ───────────────────►  registry.admit(request, primaryId)
 *        │                                            1. token valid + UNUSED (atomic consume)
 *        │                                            2. proxy signature verifies (key ownership)
 *        │                                            3. workload UNIQUE under primary (Inv F)
 *        │                                            4. PIN proxyPubKey, persist record active,
 *        │                                               ZERO-EXPOSURE marker (Q3 — join ≠ access)
 *        │  ◄───────────────  { ok, primaryPubKey, sig }  5. primary signs transcript (mutual)
 *   verifyEnrollAccepted(payload, accepted, …)
 *     verifies primary sig + PINS primaryPubKey
 *     (against configured upstream.primaryPubKey if set)
 *
 * WHY THE TOKEN IS THE NONCE: each minted token is a fresh 256-bit secret bound into
 * the signed transcript, so a signature/response from one handshake cannot be replayed
 * into another (different token ⇒ different transcript ⇒ signatures don't verify). The
 * token is SINGLE-USE: consumed atomically on success and recorded so a replay is
 * detected and rejected. Only its sha256 HASH is ever persisted — never the secret.
 *
 * WHY SIGN-WITH-CLAIMED-KEY IS CORRECT HERE: the proxy signs with the very key it asks
 * us to pin. That signature proves it holds the matching private key (key ownership);
 * the *authority* to join is the one-time token, not the key. So we pin whatever key
 * proved itself under a valid token — classic trust-on-first-use anchored by the
 * out-of-band token. Subsequent tunnel auth (T6+) verifies against this pinned key.
 */

import { createHash, randomBytes, createPublicKey } from "node:crypto";
import { join, dirname } from "node:path";

import type {
  EnrollFramePayload,
  EnrollmentRecord,
  EnrollmentStatus,
  IsoTimestamp,
  WorkloadName,
} from "@plexus/protocol";

import { ensureDir, plexusHome, readFileBestEffort, atomicWrite, atomicWriteFsync } from "../core/paths.ts";
import {
  verify,
  publicKeyFromPem,
  publicKeyFromRawBase64,
  type MeshIdentity,
} from "./keys.ts";

// ── Layout ────────────────────────────────────────────────────────────────────

/** Sub-tree + file holding the primary's durable enrollment ledger. */
const MESH_DIR = "mesh";
const ENROLLMENTS_FILE = "enrollments.json";
/** Bump if the persisted shape changes incompatibly. */
const LEDGER_VERSION = 1;
/** Default one-time token entropy — 256 bits, URL-safe. */
const TOKEN_BYTES = 32;

/**
 * The exposure posture a freshly-admitted workload enters (§7 Q3). A remote proxy's
 * capabilities default HIDDEN (the opposite of a local source's default-exposed), so
 * a valid token admits the workload but grants it ZERO visibility/access until the
 * owner deliberately exposes + grants. T6's primary-mount reads this marker to default
 * the mounted caps hidden. Encoded as a stable string (not a bare bool) so the marker
 * is self-describing in the on-disk ledger and future-proof for other postures.
 */
export type ExposureDefault = "hidden";

/**
 * The primary's stored enrollment row — a STRICT SUPERSET of the protocol's
 * `EnrollmentRecord` (we never redefine that contract), adding the §7 Q3 zero-exposure
 * marker. `EnrollmentRecord` is the shape callers consume; this is what we persist.
 */
export interface StoredEnrollmentRecord extends EnrollmentRecord {
  /** §7 Q3 — caps from this workload default HIDDEN at mount (join ≠ access). */
  exposureDefault: ExposureDefault;
}

/** A minted-but-unconsumed admission token, stored as HASH ONLY (never the secret). */
interface PendingToken {
  /** sha256(token) hex — the only token material that ever touches disk. */
  hash: string;
  /** When minted (diagnostics / housekeeping). */
  issuedAt: IsoTimestamp;
  /** Optional expiry; absent ⇒ no TTL. A token past this rejects (and is pruned). */
  expiresAt?: IsoTimestamp;
}

/** The on-disk ledger shape. */
interface PersistedLedger {
  version: number;
  tokens: PendingToken[];
  records: StoredEnrollmentRecord[];
}

// ── Handshake envelopes (module-local; NOT protocol redefinitions) ─────────────
// `EnrollFramePayload` (T1) carries only the CLAIM. The signatures + mutual response
// are handshake-protocol details this module owns. The wire carries `{ payload, sig }`
// inside the `enroll` request and `{ ok, primaryPubKey, sig }` in its reply.

/** Proxy → primary: the signed enrollment claim. */
export interface SignedEnrollRequest {
  /** The protocol claim (workload, mode, proxyPubKey, joinToken, upstream?). */
  payload: EnrollFramePayload;
  /** base64 Ed25519 signature by the PROXY over the role-tagged transcript. */
  sig: string;
}

/** Why an enrollment was refused — coarse, secret-free codes safe to log/audit. */
export type EnrollRejectReason =
  | "malformed" // missing/invalid claim fields
  | "wrong_mode" // a non-proxy tried to enroll
  | "unknown_token" // token hash was never minted here (or already pruned)
  | "token_expired" // token was minted but is past its TTL
  | "token_consumed" // token already admitted a workload — replay
  | "bad_signature" // proxy did not prove ownership of proxyPubKey
  | "duplicate_workload" // workload name already active under this primary (Inv F)
  | "persist_failed"; // admit passed every check but the durable write FAILED (L1 — see admit())

/** Primary → proxy: admission granted, with the primary's identity for mutual pinning. */
export interface EnrollAccepted {
  ok: true;
  /** The durable record (protocol superset) the primary just pinned + persisted. */
  record: StoredEnrollmentRecord;
  /** The primary's Ed25519 public key (SPKI PEM) for the proxy to PIN. */
  primaryPubKey: string;
  /** base64 Ed25519 signature by the PRIMARY over the role-tagged transcript. */
  sig: string;
}

/** Primary → proxy: admission refused. No state changed. */
export interface EnrollRejected {
  ok: false;
  reason: EnrollRejectReason;
}

export type EnrollOutcome = EnrollAccepted | EnrollRejected;

// ── Transcript + signing (shared by both ends — must be byte-identical) ────────

/** Domain-separation tags so a proxy signature can never be read as a primary one. */
const PROXY_DOMAIN = "plexus-mesh-enroll-proxy\n";
const PRIMARY_DOMAIN = "plexus-mesh-enroll-primary\n";

/**
 * The canonical handshake transcript: a deterministic serialization of every claim
 * field BOTH ends sign. Fixed key order ⇒ identical bytes on both sides. Binding the
 * one-time `joinToken` makes the transcript a fresh nonce (anti-replay); binding the
 * `proxyPubKey` ties the signature to the exact key being pinned; binding `upstream`
 * ties it to the primary the proxy believes it is joining.
 */
function enrollTranscript(p: EnrollFramePayload): string {
  return JSON.stringify({
    v: LEDGER_VERSION,
    workload: p.workload,
    mode: p.mode,
    proxyPubKey: p.proxyPubKey,
    joinToken: p.joinToken,
    upstream: p.upstream ? { url: p.upstream.url, primaryPubKey: p.upstream.primaryPubKey } : null,
  });
}

/** Role-tagged bytes that get signed/verified (domain separation, see above). */
function signedBytes(domain: string, p: EnrollFramePayload): Buffer {
  return Buffer.from(domain + enrollTranscript(p), "utf8");
}

// ── Token + pubkey helpers ─────────────────────────────────────────────────────

/** sha256 hex of a token — the ONLY token form that is persisted or compared. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Normalize any accepted pubkey serialization (PEM or raw-base64) to SPKI-DER base64. */
function spkiDerBase64(input: string): string | undefined {
  try {
    const key = input.includes("-----BEGIN") ? publicKeyFromPem(input) : publicKeyFromRawBase64(input);
    return (key.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  } catch {
    return undefined;
  }
}

/**
 * Stable public-key equality across serialization forms (PEM vs raw-base64). Used to
 * enforce the proxy-side pin: the primary key we just received MUST equal the one the
 * proxy was pre-configured to trust (`upstream.primaryPubKey`), if any.
 */
export function samePublicKey(a: string, b: string): boolean {
  const da = spkiDerBase64(a);
  const db = spkiDerBase64(b);
  return da !== undefined && db !== undefined && da === db;
}

/** Reject obviously-malformed pubkey strings early (fail-closed on the claim itself). */
function isImportablePubKey(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  try {
    if (input.includes("-----BEGIN")) createPublicKey(input);
    else publicKeyFromRawBase64(input);
    return true;
  } catch {
    return false;
  }
}

function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

// ── Proxy-side helpers ─────────────────────────────────────────────────────────

/**
 * PROXY: build the signed enrollment request for `payload`, signing the role-tagged
 * transcript with the proxy's own Ed25519 identity. The `payload.proxyPubKey` MUST be
 * this identity's public key (it is the key the primary will pin + verify against).
 */
export function buildEnrollRequest(payload: EnrollFramePayload, proxyIdentity: MeshIdentity): SignedEnrollRequest {
  const sig = proxyIdentity.sign(signedBytes(PROXY_DOMAIN, payload)).toString("base64");
  return { payload, sig };
}

/**
 * PROXY: verify the primary's admission reply (mutual auth) and apply the pin.
 *
 *  1. The primary's signature must verify over the SAME transcript the proxy signed,
 *     under the `primaryPubKey` the reply carries — proving the primary controls it.
 *  2. If the proxy was pre-configured with an expected `upstream.primaryPubKey`
 *     (pinned-key deployment, not bare TOFU), the received key MUST match it — else a
 *     man-in-the-middle could substitute its own primary identity.
 *
 * Returns `true` only if BOTH hold (fail-closed). On `true`, the caller pins
 * `accepted.primaryPubKey`.
 */
export function verifyEnrollAccepted(
  payload: EnrollFramePayload,
  accepted: EnrollAccepted,
  opts: { pinnedPrimaryPubKey?: string } = {},
): boolean {
  // (2) Pin check first — cheap, and a mismatch means we must not even trust the sig.
  const pinned = opts.pinnedPrimaryPubKey ?? payload.upstream?.primaryPubKey;
  if (pinned && !samePublicKey(pinned, accepted.primaryPubKey)) return false;

  // (1) The primary must have signed our exact handshake transcript.
  let sig: Buffer;
  try {
    sig = Buffer.from(accepted.sig, "base64");
  } catch {
    return false;
  }
  return verify(accepted.primaryPubKey, signedBytes(PRIMARY_DOMAIN, payload), sig);
}

// ── The registry aggregate (primary side) ──────────────────────────────────────

/**
 * The primary's durable enrollment ledger + admission authority. Persisted to
 * `~/.plexus/mesh/enrollments.json` (atomic write, dir-create — mirroring
 * `core/exposure.ts`). Holds: the set of minted-but-unconsumed token HASHES, and the
 * admitted records (each pinning a proxy pubkey + carrying the zero-exposure marker).
 *
 * Single-threaded JS ⇒ `admit()` runs to completion atomically; the only persisted
 * mutation happens on the SUCCESS path, after every check passes. Any failure returns
 * a structured rejection having changed NO in-memory or on-disk state.
 */
export class EnrollmentRegistry {
  private readonly path: string;
  /** Minted, not-yet-consumed tokens, keyed by hash. */
  private readonly tokens = new Map<string, PendingToken>();
  /** Admitted workloads, keyed by workload name (uniqueness index — Invariant F). */
  private readonly records = new Map<WorkloadName, StoredEnrollmentRecord>();
  /** Hashes of tokens already consumed by an admit — the replay guard. */
  private readonly consumed = new Set<string>();

  constructor(path: string) {
    this.path = path;
    // Ensure the ledger's parent dir exists up front, so best-effort atomic writes
    // (which write a temp sibling then rename) don't silently no-op on a missing dir.
    ensureDir(dirname(path));
    this.load();
  }

  // ── Persistence (mirror exposure.ts: in-memory truth + best-effort atomic write) ──

  private load(): void {
    const raw = readFileBestEffort(this.path);
    if (!raw) return;
    let parsed: Partial<PersistedLedger>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedLedger>;
    } catch {
      // Corrupt ledger — start empty (fail-closed for ADMISSION: no tokens ⇒ nothing
      // can join until re-minted). Never crash the gateway on a bad file.
      return;
    }
    if (Array.isArray(parsed.tokens)) {
      for (const t of parsed.tokens) {
        if (t && typeof t.hash === "string" && typeof t.issuedAt === "string") {
          this.tokens.set(t.hash, {
            hash: t.hash,
            issuedAt: t.issuedAt,
            expiresAt: typeof t.expiresAt === "string" ? t.expiresAt : undefined,
          });
        }
      }
    }
    if (Array.isArray(parsed.records)) {
      for (const r of parsed.records) {
        if (r && typeof r.workload === "string" && typeof r.pinnedProxyPubKey === "string") {
          this.records.set(r.workload, {
            workload: r.workload,
            pinnedProxyPubKey: r.pinnedProxyPubKey,
            joinTokenHash: r.joinTokenHash,
            claimedAt: r.claimedAt,
            status: (r.status as EnrollmentStatus) ?? "active",
            exposureDefault: "hidden",
          });
          if (typeof r.joinTokenHash === "string") this.consumed.add(r.joinTokenHash);
        }
      }
    }
  }

  /** Serialize the current ledger to its on-disk JSON shape. */
  private serialize(): string {
    const ledger: PersistedLedger = {
      version: LEDGER_VERSION,
      tokens: [...this.tokens.values()],
      records: [...this.records.values()],
    };
    return JSON.stringify(ledger, null, 2);
  }

  private persist(): void {
    try {
      // 0600: this is the primary's TRUST LEDGER (pinned keys + token hashes). No raw
      // secrets live here, but owner-only is the conservative default for trust state.
      atomicWrite(this.path, this.serialize(), 0o600);
    } catch {
      /* best-effort — authoritative state stays in memory (mint/prune housekeeping) */
    }
  }

  /**
   * DURABLE persist for the admission path (L1). `fsync`s the ledger so a consumed
   * one-time token is on stable storage before we report success, and THROWS on
   * failure so `admit()` can fail-closed rather than silently report an admission a
   * crash could undo (which would let the one-time token resurrect on reload).
   */
  private persistDurable(): void {
    atomicWriteFsync(this.path, this.serialize(), 0o600);
  }

  // ── Token minting ─────────────────────────────────────────────────────────────

  /**
   * Mint a fresh ONE-TIME join token. Returns the raw token for the operator to
   * deliver to the proxy OUT OF BAND; only its sha256 hash is retained/persisted. An
   * optional `ttlMs` sets an expiry after which the token rejects.
   */
  mintJoinToken(opts: { ttlMs?: number } = {}): { token: string; tokenHash: string; expiresAt?: IsoTimestamp } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const hash = hashToken(token);
    const issuedAt = nowIso();
    const expiresAt = opts.ttlMs !== undefined ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
    this.tokens.set(hash, { hash, issuedAt, expiresAt });
    this.persist();
    return { token, tokenHash: hash, expiresAt };
  }

  // ── The admission handshake (THE security-critical gate) ───────────────────────

  /**
   * PRIMARY: validate + admit (or reject) a signed enrollment request. Order of checks
   * is deliberate and FAIL-CLOSED — the token is only consumed and the record only
   * persisted if EVERY check passes:
   *
   *   1. CLAIM SHAPE   — required fields present, importable pubkey, mode === "proxy".
   *   2. TOKEN STATE   — replay (already consumed) → unknown → expired → else valid.
   *   3. SIGNATURE     — proxy proved ownership of `proxyPubKey` (over the transcript).
   *   4. UNIQUENESS    — workload not already active under this primary (Invariant F).
   *   5. ADMIT         — pin pubkey, persist active record + ZERO-EXPOSURE marker,
   *                      consume the token atomically, sign the mutual reply.
   *
   * A failure at any step returns `{ ok:false, reason }` and leaves NO partial state
   * (no token consumed, no record written, no persist). Reasons are coarse + secret-free.
   */
  admit(request: SignedEnrollRequest, primary: MeshIdentity, now: Date = new Date()): EnrollOutcome {
    // ── 1. Claim shape ──────────────────────────────────────────────────────────
    const payload = request?.payload;
    if (
      !payload ||
      typeof payload.workload !== "string" ||
      payload.workload.length === 0 ||
      typeof payload.proxyPubKey !== "string" ||
      typeof payload.joinToken !== "string" ||
      payload.joinToken.length === 0 ||
      typeof request.sig !== "string" ||
      request.sig.length === 0
    ) {
      return { ok: false, reason: "malformed" };
    }
    if (payload.mode !== "proxy") return { ok: false, reason: "wrong_mode" };
    if (!isImportablePubKey(payload.proxyPubKey)) return { ok: false, reason: "malformed" };

    // ── 2. Token state ──────────────────────────────────────────────────────────
    // Hash the presented token; the raw secret never leaves this frame.
    const hash = hashToken(payload.joinToken);
    // Replay: a token whose hash already admitted a workload is dead, even though it
    // is no longer in the pending set. This is the explicit single-use TOCTOU guard.
    if (this.consumed.has(hash)) return { ok: false, reason: "token_consumed" };
    const pending = this.tokens.get(hash);
    if (!pending) return { ok: false, reason: "unknown_token" };
    if (pending.expiresAt && now.getTime() >= Date.parse(pending.expiresAt)) {
      // Prune the dead token, but this is housekeeping for an already-doomed request:
      // no admission, and we persist the prune so it can't linger forever.
      this.tokens.delete(hash);
      this.persist();
      return { ok: false, reason: "token_expired" };
    }

    // ── 3. Signature (key ownership) ────────────────────────────────────────────
    let sig: Buffer;
    try {
      sig = Buffer.from(request.sig, "base64");
    } catch {
      return { ok: false, reason: "bad_signature" };
    }
    // Verify against the CLAIMED pubkey: a valid sig proves the claimant holds the
    // matching private key, i.e. it is safe to PIN that key. `verify` never throws.
    if (!verify(payload.proxyPubKey, signedBytes(PROXY_DOMAIN, payload), sig)) {
      return { ok: false, reason: "bad_signature" };
    }

    // ── 4. Workload uniqueness (Invariant F) ────────────────────────────────────
    // A name already bound to an ACTIVE record cannot be re-claimed (would let a new
    // proxy hijack an existing workload's address space). Note: this runs BEFORE any
    // mutation, so a duplicate leaves the still-pending token untouched for the
    // legitimate holder.
    const existing = this.records.get(payload.workload);
    if (existing && existing.status === "active") {
      return { ok: false, reason: "duplicate_workload" };
    }

    // ── 5. Admit — the ONLY mutation path ───────────────────────────────────────
    const record: StoredEnrollmentRecord = {
      workload: payload.workload,
      pinnedProxyPubKey: payload.proxyPubKey, // PIN: trusted for all subsequent tunnel auth
      joinTokenHash: hash, // hash only — the raw token is never stored
      claimedAt: nowIso(),
      status: "active",
      exposureDefault: "hidden", // §7 Q3 — join ≠ access; caps default hidden at mount
    };
    // Atomic consume: remove from pending + mark consumed + index the record, then one
    // DURABLE write. Single-threaded ⇒ no interleaving between these lines.
    this.tokens.delete(hash);
    this.consumed.add(hash);
    this.records.set(record.workload, record);
    // L1 — the consume MUST be durable before we admit. If the fsync'd write fails we
    // ROLL BACK the in-memory mutation (restoring the still-pending token so the legit
    // proxy can retry) and reject as an ADMISSION FAILURE — never report a success the
    // on-disk ledger does not reflect, which is how a one-time token could otherwise
    // silently resurrect after a lost write + reload.
    try {
      this.persistDurable();
    } catch {
      this.records.delete(record.workload);
      this.consumed.delete(hash);
      this.tokens.set(hash, pending);
      return { ok: false, reason: "persist_failed" };
    }

    // Mutual auth: sign the SAME transcript under the primary domain tag so the proxy
    // can verify the primary controls `primaryPubKey` for THIS specific handshake.
    const primarySig = primary.sign(signedBytes(PRIMARY_DOMAIN, payload)).toString("base64");
    return { ok: true, record, primaryPubKey: primary.publicKeyPem, sig: primarySig };
  }

  // ── Read side ───────────────────────────────────────────────────────────────

  /** The stored record for `workload`, or undefined. */
  get(workload: WorkloadName): StoredEnrollmentRecord | undefined {
    return this.records.get(workload);
  }

  /** All stored enrollment records. */
  list(): StoredEnrollmentRecord[] {
    return [...this.records.values()];
  }

  /** Whether `workload` is currently an ACTIVE enrollment. */
  isActive(workload: WorkloadName): boolean {
    return this.records.get(workload)?.status === "active";
  }

  /**
   * The exposure default for a workload's mounted caps (T6 mount hook). An active
   * enrollment is ALWAYS zero-exposure ("hidden", §7 Q3); unknown workloads return
   * undefined (no opinion).
   */
  exposureDefaultFor(workload: WorkloadName): ExposureDefault | undefined {
    return this.records.get(workload)?.exposureDefault;
  }

  /** Test/diagnostic: count of minted-but-unconsumed tokens. */
  get pendingTokenCount(): number {
    return this.tokens.size;
  }

  /** Test/diagnostic: whether a token hash is still pending (unconsumed). */
  hasPendingToken(tokenHash: string): boolean {
    return this.tokens.has(tokenHash);
  }
}

/** Absolute path to the primary's enrollment ledger under `~/.plexus/mesh/`. */
function enrollmentsPath(): string {
  ensureDir(plexusHome());
  ensureDir(join(plexusHome(), MESH_DIR));
  return join(plexusHome(), MESH_DIR, ENROLLMENTS_FILE);
}

/** Construct a registry bound to the real `~/.plexus/mesh/enrollments.json`. */
export function createEnrollmentRegistry(): EnrollmentRegistry {
  return new EnrollmentRegistry(enrollmentsPath());
}
