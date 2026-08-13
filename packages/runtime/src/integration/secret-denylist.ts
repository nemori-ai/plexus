/**
 * The SHARED structural secret denylist + engine pin — the single oracle both the CC verifier
 * (`verify-plugin.ts` axis 1/2, `assertVerified`) and the generic verifier (`render-generic.ts`,
 * `assertGenericVerified`) enforce. Keeping it in ONE module removes the asymmetry a reviewer
 * flagged: previously the generic path lacked the `plx_live_` connection-key pattern and the
 * engine SHA pin that the CC path had. Not exploitable today, but defense-in-depth must be
 * aligned so neither path can drift below the other.
 *
 * A DURABLE credential = a fixed prefix + a substantial random body. The bare PREFIX strings
 * (`plx_agent_`, `plx_enroll_`) legitimately appear as greppable markers in the engine/prose, so
 * only a prefix followed by a real body (≥16 base64url chars / ≥32 hex) is treated as a baked
 * secret. Matched as patterns so a secret is blocked even when a caller forgets `forbiddenSecrets`.
 */

import { createHash } from "node:crypto";

/** A durable per-agent PAT (`plx_agent_<body>`) — must never be baked into a distributed file. */
export const BAKED_PAT = /plx_agent_[A-Za-z0-9_-]{16,}/;
/** A one-time enrollment code (`plx_enroll_<body>`) — must ride the mgmt response, never a file. */
export const BAKED_ENROLL_CODE = /plx_enroll_[A-Za-z0-9_-]{16,}/;
/**
 * The admin CONNECTION-KEY (`plx_live_<hex>`, see core/connection-key.ts) — the agent flow is
 * PAT-only, never the admin key. Real keys are `plx_live_` + 48 hex; the ≥32 floor keeps the bare
 * prefix (a greppable marker) from matching.
 */
export const BAKED_CONNECTION_KEY = /plx_live_[0-9a-f]{32,}/;

/** All three structural patterns with human labels, in scan order. */
export const STRUCTURAL_SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "durable PAT (plx_agent_…)", pattern: BAKED_PAT },
  { label: "one-time enrollment code (plx_enroll_…)", pattern: BAKED_ENROLL_CODE },
  { label: "admin connection-key (plx_live_…)", pattern: BAKED_CONNECTION_KEY },
];

/**
 * The pinned sha-256 of the committed sanctioned engine SOURCE (`tools/plexus-cli/plexus`). Both
 * verifiers assert the engine they embed/reference hashes to this — a source-level tamper (or an
 * un-reviewed edit) is caught deterministically, not silently blessed as the new oracle.
 *
 * Re-pin (deliberate review) with:
 *   node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(P)).digest("hex"))'
 * where P is the engine source. Last re-pinned 2026-08-14 (reviewed): the engine's invoke leg
 * now takes the ASYNC channel (ADR-029) for entries the manifest marks `longRunning` — accept a
 * run handle, poll it with the same token, return the same `InvokeResponse` — so a minutes-long
 * coding run survives a hop that caps request duration. The auth chain is untouched: no new
 * credential, no new decision point, and the collect leg presents the token it already held.
 */
export const ENGINE_SHA256_PIN = "85d9c298c7faae16e64e2043b9a7636bb16f8aac52c3d5ba74c254ea76179c34";

/** sha-256 hex of a UTF-8 string. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Assert the sanctioned engine SOURCE bytes hash to {@link ENGINE_SHA256_PIN}. Throws on drift.
 * The generic verifier calls this so its engine pin matches the CC verifier's axis-1 source pin.
 */
export function assertEngineSourceSanctioned(engineBytes: string): void {
  const got = sha256Hex(engineBytes);
  if (got !== ENGINE_SHA256_PIN) {
    throw new Error(
      `sanctioned engine source sha-256 ${got.slice(0, 12)}… does NOT match the pinned oracle ` +
        `${ENGINE_SHA256_PIN.slice(0, 12)}… — the engine changed without a re-pin (review + re-pin required).`,
    );
  }
}

/**
 * Scan every `{ label, text }` entry for a structural secret AND any caller-supplied literal
 * secret, throwing on the first hit. `where(label)` shapes the thrown message. Used by the
 * generic verifier (which throws); the CC verifier keeps its own per-file reason accumulation.
 */
export function assertNoSecretsIn(
  entries: { label: string; text: string }[],
  forbiddenSecrets: readonly string[] = [],
): void {
  const forbidden = forbiddenSecrets.filter((s) => typeof s === "string" && s.length > 0);
  for (const { label, text } of entries) {
    for (const { label: kind, pattern } of STRUCTURAL_SECRET_PATTERNS) {
      if (pattern.test(text)) {
        throw new Error(`a ${kind} appears in the served ${label} — a secret must never be baked into a served artifact`);
      }
    }
    for (const secret of forbidden) {
      if (text.includes(secret)) {
        throw new Error(`a forbidden caller-supplied secret leaked into the served ${label}`);
      }
    }
  }
}
