/**
 * ============================================================================
 * Tray badge counter — open pending approvals (P1 hand-off note)
 * ============================================================================
 *
 * The tray badge = count of OPEN pending items =
 *   (number of `pending_added`) − (number of `pending_resolved`).
 * Both events carry a `pendingId`; we track the open SET (not a raw integer) so
 * duplicate `pending_added` (e.g. a redelivery) or a `pending_resolved` for an
 * id we never saw can't drive the count negative or double-count.
 *
 * The management SSE stream has NO replay: on reconnect we cannot trust the
 * delta history, so the supervisor re-snapshots `GET /v1/admin/api/pending` and
 * calls {@link PendingTracker.reset} with the authoritative open-id list.
 *
 * Pure + deterministic — no Electron, no sockets — so it is directly testable.
 */

import type { PendingAddedEvent, PendingResolvedEvent } from "@plexus/protocol";

export class PendingTracker {
  /** The set of currently-open pendingIds. Badge count = this.size. */
  private readonly open = new Set<string>();

  /** Apply a `pending_added` event. Idempotent on pendingId. */
  add(ev: PendingAddedEvent): void {
    const id = ev.item.pendingId;
    if (id) this.open.add(id);
  }

  /** Apply a `pending_resolved` event. No-op if the id was never open. */
  resolve(ev: PendingResolvedEvent): void {
    if (ev.pendingId) this.open.delete(ev.pendingId);
  }

  /**
   * Re-seed from an authoritative snapshot (after an SSE reconnect, since the
   * stream has no replay). Replaces the entire open set with these ids.
   */
  reset(openPendingIds: readonly string[]): void {
    this.open.clear();
    for (const id of openPendingIds) {
      if (id) this.open.add(id);
    }
  }

  /** The badge count: number of open pending items. */
  get count(): number {
    return this.open.size;
  }

  /** Snapshot of the open ids (e.g. to render a "N approvals waiting" submenu). */
  openIds(): string[] {
    return [...this.open];
  }
}

/**
 * Functional convenience for tests + the tray-label code: fold a sequence of
 * added/resolved events to a final badge count, starting from an optional seed
 * set of already-open ids.
 */
export function badgeCountFromEvents(
  events: ReadonlyArray<PendingAddedEvent | PendingResolvedEvent>,
  seedOpenIds: readonly string[] = [],
): number {
  const t = new PendingTracker();
  t.reset(seedOpenIds);
  for (const ev of events) {
    if (ev.type === "pending_added") t.add(ev);
    else t.resolve(ev);
  }
  return t.count;
}
