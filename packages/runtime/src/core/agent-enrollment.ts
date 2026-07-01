/**
 * Agent-enrollment aggregate — the agent↔primary bootstrap credential + its durable
 * per-agent ledger (agent-skill-compile §3 Auth model, Inv III/VI, ADR-3/ADR-4).
 *
 * THIS IS THE AGENT-FACING TRUST BOUNDARY. It is NOT the admin `connection-key`
 * (which stays ADMIN-ONLY and this module never touches) and NOT the mesh
 * primary↔proxy boundary (`mesh/enrollment.ts`, which pins an Ed25519 key). It is
 * the SAME one-time-code → durable-credential primitive as the mesh, re-applied to
 * HTTP agents: instead of pinning a proxy's public key, a valid one-time enrollment
 * code mints a durable per-agent BEARER PAT. The PAT is that agent's identity from
 * then on; the blast radius of a leaked PAT is exactly ONE agent's pre-granted caps,
 * independently revocable (ADR-3).
 *
 * The flow:
 *
 *   ADMIN (config-time)                       AGENT (first run, calling side)
 *   ───────────────────                       ───────────────────────────────
 *   mintEnrollmentCode(agentId)               POST /agents/enroll { code }
 *     → one-time, 15-min, 256-bit code          → redeemEnrollmentCode(code)
 *     recorded PENDING keyed to agentId            1. code valid + PENDING + unexpired
 *     delivered to the agent OUT OF BAND           2. mint durable PAT `plx_agent_<256b>`
 *                                                  3. store patHash, mark row ACTIVE,
 *                                                     CONSUME the code (single-use)
 *                                                  4. return the PAT ONCE (plaintext)
 *   revoke(agentId)  → row REVOKED             every call: verifyPat(pat) → agentId
 *     (kills THAT agent's PAT only)
 *
 * WHY THE CODE IS THE NONCE: each minted code is a fresh 256-bit secret bound to a
 * single agentId row. It is SINGLE-USE — consumed on the first successful redeem and
 * recorded so a replay is detected and rejected. Re-minting a code for an agent that
 * already redeemed (lost-PAT re-issue, ADR-4) resets the row to PENDING and clears the
 * old patHash, so the OLD PAT stops verifying the moment a new code is issued.
 *
 * NEVER-AT-REST-IN-PLAINTEXT: only the sha256 HASH of the code and of the PAT ever
 * touch disk (like a password file). The PAT plaintext is returned exactly once, at
 * redeem; it is never recoverable from the ledger. Everything here is DEFAULT-DENY /
 * FAIL-CLOSED: a malformed/unknown/expired/consumed code redeems nothing and a durable
 * write failure rolls back in-memory state and reports failure rather than a phantom PAT.
 */

import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";

import {
  ensureDir,
  homePath,
  readFileBestEffort,
  atomicWrite,
  atomicWriteFsync,
} from "./paths.ts";

// ── Layout ─────────────────────────────────────────────────────────────────────

/** The durable per-agent enrollment ledger, under `~/.plexus/`. */
const AGENT_ENROLLMENTS_FILE = "agent-enrollments.json";
/** Bump if the persisted shape changes incompatibly. */
const LEDGER_VERSION = 1;
/** Enrollment-code entropy — 256 bits, URL-safe. */
const CODE_BYTES = 32;
/** PAT entropy — 256 bits, URL-safe. */
const PAT_BYTES = 32;
/** Default enrollment-code TTL — 15 minutes (ADR-4: short-lived). */
const DEFAULT_CODE_TTL_MS = 15 * 60 * 1000;
/** PAT prefix — an operator-legible, greppable marker in `.env` files etc. */
const PAT_PREFIX = "plx_agent_";
/** Enrollment-code prefix — legible in the copy-able install command (ADR-8). */
const CODE_PREFIX = "plx_enroll_";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** Lifecycle of an agent's enrollment row. */
export type AgentEnrollmentStatus = "pending" | "active" | "revoked";

/**
 * A per-agent enrollment row — the persisted trust record for one agent. `codeHash`
 * is retained across the lifecycle (never the raw code) so a replay of a consumed
 * code is still detectable after a reload; `patHash` appears only once the code is
 * redeemed. NEITHER secret is ever stored in plaintext.
 */
export interface AgentEnrollmentRecord {
  /** The agent this row binds a credential to. */
  agentId: string;
  /** pending → active (redeemed) → revoked. */
  status: AgentEnrollmentStatus;
  /** sha256(code) hex — the current/last enrollment code minted for this agent. */
  codeHash: string;
  /** When the current code expires (ISO). A redeem past this rejects. */
  codeExpiresAt: string;
  /** sha256(pat) hex — present once ACTIVE; cleared on revoke / re-mint. */
  patHash?: string;
  /** When the current code was minted (ISO). */
  issuedAt: string;
  /** When the code was redeemed into a PAT (ISO). */
  redeemedAt?: string;
  /** When the row was revoked (ISO). */
  revokedAt?: string;
}

/** The on-disk ledger shape. */
interface PersistedAgentLedger {
  version: number;
  records: AgentEnrollmentRecord[];
}

/** A freshly-minted enrollment code — the raw `code` is returned to the admin ONCE. */
export interface MintedEnrollmentCode {
  /** The raw one-time code, delivered to the agent out of band. Never persisted. */
  code: string;
  agentId: string;
  /** ISO expiry. */
  expiresAt: string;
}

/** Why a redeem was refused — coarse, secret-free reason codes safe to log/return. */
export type RedeemRejectReason =
  | "malformed" // missing/empty/non-string code
  | "unknown_code" // code hash was never minted here
  | "code_expired" // minted but past its TTL
  | "code_consumed" // already redeemed (or the row is revoked) — replay
  | "persist_failed"; // every check passed but the durable write FAILED (fail-closed)

/** Redeem succeeded — the PAT is returned in plaintext exactly ONCE, here. */
export interface RedeemAccepted {
  ok: true;
  /** The durable bearer PAT. Store it (agent's own paradigm); it is never returned again. */
  pat: string;
  agentId: string;
}

/** Redeem refused — no state changed. */
export interface RedeemRejected {
  ok: false;
  reason: RedeemRejectReason;
}

export type RedeemOutcome = RedeemAccepted | RedeemRejected;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** sha256 hex — the ONLY form of a code/PAT that is persisted or compared. */
function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

// ── The registry aggregate ─────────────────────────────────────────────────────

/**
 * The durable per-agent enrollment ledger + redeem authority. Persisted to
 * `~/.plexus/agent-enrollments.json` (owner-only 0600). Holds one row per agentId.
 *
 * Single-threaded JS ⇒ `redeemEnrollmentCode()` / `revoke()` run to completion
 * atomically; the durable mutation happens only on the success path after every check
 * passes, and a write failure rolls the in-memory mutation back and reports failure.
 */
export class AgentEnrollmentRegistry {
  private readonly path: string;
  /** Rows keyed by agentId (the uniqueness index — one credential state per agent). */
  private readonly records = new Map<string, AgentEnrollmentRecord>();
  /** codeHash → agentId, for O(1) redeem lookup (covers pending AND consumed rows). */
  private readonly codeHashToAgent = new Map<string, string>();
  /** patHash → agentId, for O(1) `verifyPat` over ACTIVE rows only. */
  private readonly activeByPatHash = new Map<string, string>();

  constructor(path: string) {
    this.path = path;
    ensureDir(dirname(path));
    this.load();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private load(): void {
    const raw = readFileBestEffort(this.path);
    if (!raw) return;
    let parsed: Partial<PersistedAgentLedger>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedAgentLedger>;
    } catch {
      // Corrupt ledger — start empty (fail-closed: no rows ⇒ no PAT verifies until
      // re-enrolled). Never crash the gateway on a bad file.
      return;
    }
    if (!Array.isArray(parsed.records)) return;
    for (const r of parsed.records) {
      if (
        !r ||
        typeof r.agentId !== "string" ||
        r.agentId.length === 0 ||
        typeof r.codeHash !== "string" ||
        r.codeHash.length === 0 ||
        typeof r.status !== "string"
      ) {
        continue;
      }
      // N2 (defensive hardening): validate the persisted status against the closed
      // lifecycle set, and require the secret a row's state implies — an ACTIVE row
      // MUST carry a non-empty patHash (else it could authenticate), a PENDING row
      // MUST carry its codeHash (already checked above). A locally-tampered ledger
      // row that violates these is a malformed credential: DROP it rather than trust
      // it into the in-memory indexes (fail-safe — a bad row must never become usable).
      const status = r.status;
      if (status !== "pending" && status !== "active" && status !== "revoked") {
        continue;
      }
      if (status === "active" && (typeof r.patHash !== "string" || r.patHash.length === 0)) {
        continue;
      }
      const record: AgentEnrollmentRecord = {
        agentId: r.agentId,
        status,
        codeHash: r.codeHash,
        codeExpiresAt: typeof r.codeExpiresAt === "string" ? r.codeExpiresAt : nowIso(),
        ...(typeof r.patHash === "string" ? { patHash: r.patHash } : {}),
        issuedAt: typeof r.issuedAt === "string" ? r.issuedAt : nowIso(),
        ...(typeof r.redeemedAt === "string" ? { redeemedAt: r.redeemedAt } : {}),
        ...(typeof r.revokedAt === "string" ? { revokedAt: r.revokedAt } : {}),
      };
      this.records.set(record.agentId, record);
      this.codeHashToAgent.set(record.codeHash, record.agentId);
      if (record.status === "active" && record.patHash) {
        this.activeByPatHash.set(record.patHash, record.agentId);
      }
    }
  }

  private serialize(): string {
    const ledger: PersistedAgentLedger = {
      version: LEDGER_VERSION,
      records: [...this.records.values()],
    };
    return JSON.stringify(ledger, null, 2);
  }

  /** Best-effort persist for housekeeping (mint) — authoritative state stays in memory. */
  private persist(): void {
    try {
      atomicWrite(this.path, this.serialize(), 0o600);
    } catch {
      /* best-effort */
    }
  }

  /** DURABLE persist for the redeem/revoke consume — fsync + THROW on failure. */
  private persistDurable(): void {
    atomicWriteFsync(this.path, this.serialize(), 0o600);
  }

  // ── Mint ──────────────────────────────────────────────────────────────────

  /**
   * ADMIN: mint a one-time enrollment code for `agentId` and record a PENDING row.
   * Returns the raw code ONCE (delivered to the agent out of band); only its hash is
   * persisted. Re-minting for an agent that already enrolled is the lost-PAT re-issue
   * path (ADR-4): it resets the row to PENDING with a fresh code + clears the old
   * `patHash`, so the previous PAT immediately stops verifying.
   */
  mintEnrollmentCode(agentId: string, opts: { ttlMs?: number } = {}): MintedEnrollmentCode {
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error("mintEnrollmentCode: agentId must be a non-empty string");
    }
    const code = CODE_PREFIX + randomBytes(CODE_BYTES).toString("base64url");
    const codeHash = sha256Hex(code);
    const ttlMs = opts.ttlMs ?? DEFAULT_CODE_TTL_MS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    // Drop any prior code-hash / active-PAT index for this agent (re-issue supersedes).
    const prior = this.records.get(agentId);
    if (prior) {
      this.codeHashToAgent.delete(prior.codeHash);
      if (prior.patHash) this.activeByPatHash.delete(prior.patHash);
    }

    const record: AgentEnrollmentRecord = {
      agentId,
      status: "pending",
      codeHash,
      codeExpiresAt: expiresAt,
      issuedAt: nowIso(now),
    };
    this.records.set(agentId, record);
    this.codeHashToAgent.set(codeHash, agentId);
    this.persist();
    return { code, agentId, expiresAt };
  }

  // ── Redeem (the security-critical gate) ─────────────────────────────────────

  /**
   * AGENT: redeem a one-time enrollment code for a durable bearer PAT. FAIL-CLOSED —
   * the code is consumed and the PAT minted only if EVERY check passes:
   *
   *   1. SHAPE     — code is a non-empty string.
   *   2. KNOWN     — code hash maps to an agent row minted here (else unknown_code).
   *   3. STATE     — the row is PENDING (a non-pending row ⇒ code_consumed / replay).
   *   4. FRESH     — the code is not past its TTL (else code_expired).
   *   5. MINT      — generate PAT, store its hash, mark ACTIVE, stamp redeemedAt.
   *   6. DURABLE   — fsync the ledger BEFORE returning success; on write failure ROLL
   *                  BACK the in-memory mutation and return persist_failed (never hand
   *                  out a PAT the on-disk ledger does not reflect).
   *
   * Returns the PAT in plaintext exactly ONCE. A failure at any step changes no state.
   */
  redeemEnrollmentCode(code: unknown, now: Date = new Date()): RedeemOutcome {
    // 1. Shape.
    if (typeof code !== "string" || code.length === 0) {
      return { ok: false, reason: "malformed" };
    }
    // 2. Known.
    const codeHash = sha256Hex(code);
    const agentId = this.codeHashToAgent.get(codeHash);
    if (!agentId) return { ok: false, reason: "unknown_code" };
    const record = this.records.get(agentId);
    if (!record) return { ok: false, reason: "unknown_code" };
    // 3. State — only a PENDING row can be redeemed (active/revoked ⇒ replay/dead).
    if (record.status !== "pending") return { ok: false, reason: "code_consumed" };
    // 4. Fresh.
    if (now.getTime() >= Date.parse(record.codeExpiresAt)) {
      return { ok: false, reason: "code_expired" };
    }

    // 5. Mint the durable PAT + flip the row ACTIVE (in memory).
    const pat = PAT_PREFIX + randomBytes(PAT_BYTES).toString("base64url");
    const patHash = sha256Hex(pat);
    const prevStatus = record.status;
    record.status = "active";
    record.patHash = patHash;
    record.redeemedAt = nowIso(now);
    this.activeByPatHash.set(patHash, agentId);

    // 6. Durable consume — roll back the in-memory flip if the write fails.
    try {
      this.persistDurable();
    } catch {
      record.status = prevStatus;
      delete record.patHash;
      delete record.redeemedAt;
      this.activeByPatHash.delete(patHash);
      return { ok: false, reason: "persist_failed" };
    }
    return { ok: true, pat, agentId };
  }

  // ── Verify ──────────────────────────────────────────────────────────────────

  /**
   * Verify a presented PAT → the bound `agentId` if it hashes to an ACTIVE row, else
   * `null`. A revoked or never-issued PAT returns null (the revoke/reissue paths drop
   * the row's `patHash` from the active index). Malformed input ⇒ null.
   */
  verifyPat(pat: unknown): string | null {
    if (typeof pat !== "string" || pat.length === 0) return null;
    const agentId = this.activeByPatHash.get(sha256Hex(pat));
    if (!agentId) return null;
    // Defensive re-check against the record's live status (the index only ever holds
    // active rows, but never let a stale index out-authorize the record of truth).
    return this.records.get(agentId)?.status === "active" ? agentId : null;
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  /**
   * ADMIN: REVOKE `agentId` — flip its row to `"revoked"` and drop its PAT from the
   * active index, so that agent's PAT stops verifying immediately. Kills ONLY that
   * agent (per-agent blast radius, ADR-3); other agents are untouched. Durable +
   * fail-closed: the tombstone is fsync'd before success, and a write failure rolls
   * the flip back and throws. Idempotent — returns `false` for an unknown or
   * already-revoked agent (no write), `true` when an active/pending row was revoked.
   */
  revoke(agentId: string): boolean {
    const record = this.records.get(agentId);
    if (!record || record.status === "revoked") return false;
    const prev: AgentEnrollmentRecord = { ...record };
    record.status = "revoked";
    record.revokedAt = nowIso();
    if (record.patHash) this.activeByPatHash.delete(record.patHash);
    try {
      this.persistDurable();
    } catch (err) {
      // Roll back — the row stays as it was, and the caller aborts.
      this.records.set(agentId, prev);
      if (prev.status === "active" && prev.patHash) {
        this.activeByPatHash.set(prev.patHash, agentId);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    return true;
  }

  // ── Read side ───────────────────────────────────────────────────────────────

  /** The stored row for `agentId`, or undefined. */
  get(agentId: string): AgentEnrollmentRecord | undefined {
    return this.records.get(agentId);
  }

  /** All enrollment rows. */
  list(): AgentEnrollmentRecord[] {
    return [...this.records.values()];
  }

  /** Whether `agentId` currently has an ACTIVE (redeemed, non-revoked) PAT. */
  isActive(agentId: string): boolean {
    return this.records.get(agentId)?.status === "active";
  }
}

/** Construct a registry bound to the real `~/.plexus/agent-enrollments.json`. */
export function createAgentEnrollmentRegistry(): AgentEnrollmentRegistry {
  return new AgentEnrollmentRegistry(homePath(AGENT_ENROLLMENTS_FILE));
}
