/**
 * Session store + liveness (§3 handshake, §5b liveness — review #8).
 *
 * A session is opened by `POST /link/handshake` (connection-key → session) and is
 * the unit invoke liveness is checked against. A token's `sessionId` must reference
 * a LIVE session at invoke time even if the JWT has not yet expired — so
 * connection-key rotation can cut off a rotated-out agent (it invalidates the
 * sessions bootstrapped under the old key and enqueues their jtis for revocation).
 *
 * In-memory (sessions are ephemeral, ≤ a process lifetime); no persistence needed.
 */

import { randomUUID } from "node:crypto";
import type { IsoTimestamp, SessionLiveness } from "../protocol/index.ts";

/** Default session lifetime — 60 min (the handshake manifest view's TTL). */
export const SESSION_LIFETIME_MS = 60 * 60 * 1000;

export interface Session {
  id: string;
  /** The connection-key the session was bootstrapped under (for rotation invalidation). */
  bootstrapKey: string;
  agentId?: string;
  client?: { name?: string; version?: string; agentId?: string };
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  /** False once invalidated by key rotation (review #8). */
  invalidated: boolean;
  /** jtis of tokens issued under this session (enqueued for revocation on invalidation). */
  issuedJtis: Set<string>;
}

export interface SessionStore {
  open(bootstrapKey: string, client?: Session["client"]): Session;
  get(id: string): Session | undefined;
  /** Liveness = exists, not expired, not invalidated (review #8). */
  liveness(id: string): SessionLiveness;
  /** Record a jti issued under a session (so rotation can enqueue its revocation). */
  trackJti(sessionId: string, jti: string): void;
  /**
   * Invalidate every session bootstrapped under `oldKey`; returns the jtis that
   * should be enqueued for revocation (review #8). The caller (wiring) revokes them.
   */
  invalidateByKey(oldKey: string): string[];
  all(): Session[];
}

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  open(bootstrapKey: string, client?: Session["client"]): Session {
    const now = Date.now();
    const id = `sess_${randomUUID()}`;
    const session: Session = {
      id,
      bootstrapKey,
      ...(client?.agentId ? { agentId: client.agentId } : {}),
      ...(client ? { client } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_LIFETIME_MS).toISOString(),
      invalidated: false,
      issuedJtis: new Set(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  liveness(id: string): SessionLiveness {
    const session = this.sessions.get(id);
    if (!session) return { sessionId: id, live: false, reason: "unknown session" };
    if (session.invalidated) {
      return { sessionId: id, live: false, reason: "session invalidated (connection-key rotated)" };
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      return { sessionId: id, live: false, reason: "session expired" };
    }
    return { sessionId: id, live: true };
  }

  trackJti(sessionId: string, jti: string): void {
    this.sessions.get(sessionId)?.issuedJtis.add(jti);
  }

  invalidateByKey(oldKey: string): string[] {
    const jtis: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.bootstrapKey === oldKey && !session.invalidated) {
        session.invalidated = true;
        jtis.push(...session.issuedJtis);
      }
    }
    return jtis;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }
}

export function createSessionStore(): SessionStore {
  return new InMemorySessionStore();
}
