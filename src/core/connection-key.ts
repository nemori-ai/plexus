/**
 * Connection-key store (§5 security model, ADR-009).
 *
 * The connection-key is a SESSION-BOOTSTRAP secret — NOT call authority. The
 * gateway generates it, the management client surfaces it to the user, the user
 * pastes it into the agent (`connectionKeyDelivery: "user-paste"`). It is
 * generated/stored under `~/.plexus/` and verified at `POST /link/handshake`.
 *
 * Rotation invalidates sessions bootstrapped under the old key AND enqueues their
 * tokens' jtis for revocation (review #8); the actual session-invalidation hook is
 * supplied by the session store at wiring time.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { homePath, readFileBestEffort, atomicWrite } from "./paths.ts";

const KEY_FILE = "connection-key";

/** Generate a fresh, opaque connection-key string. */
function freshKey(): string {
  return `plx_live_${randomBytes(24).toString("hex")}`;
}

export interface ConnectionKeyStore {
  /** The current connection-key (surfaced to the management client). */
  current(): string;
  /** Constant-time check that a presented key is the current one. */
  verify(presented: string): boolean;
  /**
   * The current key EPOCH (AUTHZ-UX §2.N3 / D6). Starts at 0, bumped on every `rotate()`.
   * A task-bundle grant is stamped with this value; a grant whose stamped epoch is older
   * than the live epoch is dropped (a rotation invalidates the whole bundle). Process-life
   * scoped — sessions/tokens are already dropped on rotation, so persistence is unneeded.
   */
  epoch(): number;
  /**
   * Rotate the key. Returns the new key; bumps the epoch; invokes the registered rotation
   * hook (so sessions under the old key are invalidated + their jtis enqueued for
   * revocation — review #8).
   */
  rotate(): string;
  /** Register a hook fired on rotation with the OLD key (for session invalidation). */
  onRotate(hook: (oldKey: string) => void): void;
}

class FileConnectionKeyStore implements ConnectionKeyStore {
  private key: string;
  private currentEpoch = 0;
  private readonly path: string;
  private rotateHook: ((oldKey: string) => void) | null = null;

  constructor(path: string) {
    this.path = path;
    const existing = readFileBestEffort(path);
    if (existing && existing.trim().length > 0) {
      this.key = existing.trim();
    } else {
      this.key = freshKey();
      this.persist();
    }
  }

  current(): string {
    return this.key;
  }

  epoch(): number {
    return this.currentEpoch;
  }

  verify(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(this.key);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  rotate(): string {
    const old = this.key;
    this.key = freshKey();
    this.currentEpoch += 1;
    this.persist();
    this.rotateHook?.(old);
    return this.key;
  }

  onRotate(hook: (oldKey: string) => void): void {
    this.rotateHook = hook;
  }

  private persist(): void {
    try {
      atomicWrite(this.path, this.key);
    } catch {
      /* best-effort */
    }
  }
}

export function createConnectionKeyStore(): ConnectionKeyStore {
  return new FileConnectionKeyStore(homePath(KEY_FILE));
}
