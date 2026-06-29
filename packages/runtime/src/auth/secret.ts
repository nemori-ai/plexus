/**
 * Per-install signing secret + gateway instance id (ADR-006, ADR-009).
 *
 * The scoped-token JWTs are HS256-signed with a SECRET generated once per install
 * and stored under `~/.plexus/secret`. HS256 (symmetric) is deliberate: a single
 * local issuer-verifier needs no asymmetric keypair (ADR-006). The secret is
 * read-once and cached for the process lifetime.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { homePath, readFileBestEffort, atomicWrite } from "../core/paths.ts";

const SECRET_FILE = "secret";
const INSTANCE_FILE = "instance-id";

let _secret: Buffer | null = null;
let _instanceId: string | null = null;

/**
 * The per-install HS256 secret (256-bit). Generated + persisted on first use;
 * cached thereafter. Best-effort persistence — if the FS is unwritable the
 * in-process secret still signs/verifies for this run.
 */
export function getSigningSecret(): Buffer {
  if (_secret) return _secret;
  const path = homePath(SECRET_FILE);
  const existing = readFileBestEffort(path);
  if (existing && existing.trim().length >= 32) {
    _secret = Buffer.from(existing.trim(), "hex");
    return _secret;
  }
  const fresh = randomBytes(32);
  try {
    // Owner-only (0600): the HS256 signing secret is credential material.
    atomicWrite(path, fresh.toString("hex"), 0o600);
  } catch {
    /* best-effort persistence */
  }
  _secret = fresh;
  return _secret;
}

/**
 * Stable gateway instance id — the JWT `iss`. Generated + persisted on first use.
 */
export function getInstanceId(): string {
  if (_instanceId) return _instanceId;
  const path = homePath(INSTANCE_FILE);
  const existing = readFileBestEffort(path);
  if (existing && existing.trim().length > 0) {
    _instanceId = existing.trim();
    return _instanceId;
  }
  const fresh = `plexus-${randomUUID()}`;
  try {
    // Default perms by design: the instance-id is the JWT `iss` — a PUBLIC
    // identifier, not credential material — so it needs no owner-only mode.
    atomicWrite(path, fresh);
  } catch {
    /* best-effort */
  }
  _instanceId = fresh;
  return _instanceId;
}

/** Test-only: drop the cached secret/instance so a fresh PLEXUS_HOME is re-read. */
export function _resetSecretCacheForTests(): void {
  _secret = null;
  _instanceId = null;
}
