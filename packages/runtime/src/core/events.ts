/**
 * In-process event bus for the `GET /events` SSE stream (§3b, ADR-014).
 *
 * Publishers (grant resolution, revocation, manifest change, source status) emit a
 * `PlexusEvent`; subscribers (one per open SSE connection) receive it. A tiny
 * synchronous fan-out — single local process, no backpressure concerns in M0.
 */

import type { PlexusEvent } from "@plexus/protocol";

export type EventListener = (event: PlexusEvent) => void;

export interface EventBus {
  publish(event: PlexusEvent): void;
  /** Subscribe; returns an unsubscribe fn. */
  subscribe(listener: EventListener): () => void;
}

class InMemoryEventBus implements EventBus {
  private readonly listeners = new Set<EventListener>();

  publish(event: PlexusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken subscriber must not break publish for others */
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createEventBus(): EventBus {
  return new InMemoryEventBus();
}
