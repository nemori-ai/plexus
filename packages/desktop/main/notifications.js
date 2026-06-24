/**
 * ============================================================================
 * Native notifications (UX §1.2 / §4a) — Mode-1 approval comes to the user
 * ============================================================================
 *
 * On `pending_added`, fire a native macOS `Notification`:
 *   title  = "{agent} wants to {VERB} {capability}"
 *   body   = pendingNarration[].notificationLine (gateway-authored, spoof-proof)
 *   actions = Approve once / Approve {window} / Deny   (1-tap, single-cap grants)
 *            OR just "Review…" for bundle/register pendings (never 1-tap).
 *
 * Clicking an approve/deny action calls `POST /v1/admin/api/pending/:id` with the
 * chosen trustWindow (request built by the pure `buildResolvePendingRequest`).
 * A click on the notification body (or the Review action) opens the admin window.
 *
 * GUI code (Electron `Notification`). The payload MAPPING is pure (helpers.js);
 * this file is the thin binding: payload → Notification + action wiring.
 */

import { Notification } from "electron";
import { buildNotificationPayload, buildResolvePendingRequest } from "./helpers.js";

export class NotificationManager {
  /**
   * @param {{
   *   port: number,
   *   connectionKey: string | null,
   *   onReview: (pendingId: string) => void,
   *   onResolved?: (pendingId: string, decision: string) => void,
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** Whether native notifications are available on this platform/session. */
  static supported() {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  }

  /**
   * Fire a notification for a `pending_added` item. Returns the built payload (so
   * callers/tests can inspect what would be shown).
   * @param {import('@plexus/protocol').PendingEventItem} item
   */
  notifyPendingAdded(item) {
    const payload = buildNotificationPayload(item);
    if (!NotificationManager.supported()) return payload;

    // macOS shows action buttons only when there's a single primary action +
    // the rest under the "alternate actions" affordance. We attach the approve/
    // deny/review actions; Electron renders them on supported macOS versions.
    const actions = payload.actions.map((a) => ({ type: "button", text: a.text }));
    const notif = new Notification({
      title: payload.title,
      body: payload.body,
      actions,
      // Mode-1 must be a deliberate decision: dismiss ≠ approve (UX §1.2a).
      closeButtonText: "Dismiss",
    });

    notif.on("action", (_event, index) => {
      const action = payload.actions[index];
      if (!action) return;
      this._handleAction(payload.pendingId, action);
    });
    // Clicking the notification body → open the Review/admin window.
    notif.on("click", () => this.ctx.onReview(payload.pendingId));

    notif.show();
    return payload;
  }

  /** @param {string} pendingId @param {import('@plexus/protocol').NotificationAction|any} action */
  async _handleAction(pendingId, action) {
    if (action.intent === "review") {
      this.ctx.onReview(pendingId);
      return;
    }
    if (!this.ctx.connectionKey) {
      // Without a key we cannot make the call; fall back to opening the admin.
      this.ctx.onReview(pendingId);
      return;
    }
    const decision =
      action.intent === "approve"
        ? { action: "approve", trustWindow: action.trustWindow }
        : { action: "deny" };
    const req = buildResolvePendingRequest({
      port: this.ctx.port,
      connectionKey: this.ctx.connectionKey,
      pendingId,
      decision,
    });
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      if (res.ok && this.ctx.onResolved) this.ctx.onResolved(pendingId, decision.action);
    } catch {
      // Network/runtime hiccup — surface the admin so the user can retry.
      this.ctx.onReview(pendingId);
    }
  }
}
