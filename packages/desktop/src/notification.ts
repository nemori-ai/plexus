/**
 * ============================================================================
 * Notification payload mapping — pending_added → native notification (UX §1.2)
 * ============================================================================
 *
 * Maps a redaction-safe `PendingEventItem` (carried on the management SSE
 * stream) to the fields a native macOS `Notification` needs:
 *
 *   title  = "{agent} wants to {VERB} {capability}"   (gateway-authored facts)
 *   body   = pendingNarration[].notificationLine       (spoof-proof, P1 note)
 *   actions = the trust-window choices  (Approve once / Approve {window} / Deny)
 *
 * Two archetypes (UX §1.2):
 *  - GRANT pendings → a glanceable Mode-1 card with 1-tap approve actions.
 *  - REGISTER / BUNDLE pendings → NEVER 1-tap; only a "Review…" action that
 *    opens the admin window (broader standing trust must be inspected).
 *
 * The `notificationLine` is GATEWAY-authored and spoof-proof (P1 note) — we use
 * it verbatim as the body and never splice agent-supplied text in. Pure mapping,
 * no Electron: directly unit-testable.
 */

import type {
  GrantVerb,
  PendingEventItem,
  PendingNarration,
  TrustWindow,
  TrustWindowKind,
} from "@plexus/protocol";

/** A single notification action button → maps to a trust-window or to "open admin". */
export interface NotificationAction {
  /** Stable id the main process keys on when the user clicks an action. */
  readonly id: string;
  /** The button label, e.g. "Approve once", "Approve 1d", "Deny", "Review…". */
  readonly text: string;
  /** What clicking it does. */
  readonly intent: "approve" | "deny" | "review";
  /** Present iff intent==="approve": the trust-window to send on the approve call. */
  readonly trustWindow?: TrustWindow;
}

/** The fully-resolved payload the main process feeds to a native `Notification`. */
export interface NotificationPayload {
  readonly pendingId: string;
  readonly title: string;
  /** The gateway-authored notificationLine, verbatim (spoof-proof). */
  readonly body: string;
  readonly actions: NotificationAction[];
  /**
   * `false` for register/bundle pendings (open admin, never 1-tap). When false the
   * main process should NOT attach inline approve/deny buttons — only "Review…".
   */
  readonly oneTapAllowed: boolean;
}

const VERB_LABEL: Record<GrantVerb, string> = {
  read: "READ",
  write: "WRITE",
  execute: "EXECUTE",
};

const WINDOW_LABEL: Record<TrustWindowKind, string> = {
  once: "once",
  "1h": "1h",
  "1d": "1 day",
  "7d": "7 days",
  "until-revoked": "until revoked",
  custom: "custom",
};

/**
 * Map a `PendingEventItem` to a {@link NotificationPayload}. `agentLabel`/capability
 * label fall back to the raw ids if no friendlier label is available.
 */
export function buildNotificationPayload(item: PendingEventItem): NotificationPayload {
  const agent = item.agentId ?? "An agent";

  // REGISTER (extension install) pendings → never 1-tap, open admin (UX §1.2b).
  if (item.kind === "register") {
    const source = item.source ?? "a new source";
    return {
      pendingId: item.pendingId,
      title: `${agent} wants to register ${source}`,
      body: "Review the source before installing it. Opens Plexus to inspect.",
      actions: [reviewAction()],
      oneTapAllowed: false,
    };
  }

  const narrations = item.pendingNarration ?? [];
  const verbs = collectVerbs(narrations);
  const capLabel = capabilityLabel(item, narrations);
  const title = `${agent} wants to ${verbs} ${capLabel}`;

  const body = bodyLine(narrations);

  // A grant touching MULTIPLE capabilities (bundle-shaped) → open admin, no 1-tap.
  if (narrations.length > 1 || (item.capabilities?.length ?? 0) > 1) {
    return {
      pendingId: item.pendingId,
      title,
      body,
      actions: [reviewAction()],
      oneTapAllowed: false,
    };
  }

  // Single-capability Mode-1 grant → glanceable approve buttons (UX §4a).
  return {
    pendingId: item.pendingId,
    title,
    body,
    actions: approveActions(narrations[0]?.defaultTrustWindow),
    oneTapAllowed: true,
  };
}

/** The "Review…" action that opens the admin/Review window. */
function reviewAction(): NotificationAction {
  return { id: "review", text: "Review…", intent: "review" };
}

/**
 * The two recommended approve buttons + Deny. We always offer `once`, plus the
 * gateway's recommended `defaultTrustWindow` (deduped) — exactly the UX §1.2a
 * "two recommended trust-windows for this provenance×verb" rule.
 */
function approveActions(recommended: TrustWindow | undefined): NotificationAction[] {
  const actions: NotificationAction[] = [];
  const once: TrustWindow = { kind: "once" };
  actions.push({
    id: "approve:once",
    text: "Approve once",
    intent: "approve",
    trustWindow: once,
  });
  if (recommended && recommended.kind !== "once") {
    actions.push({
      id: `approve:${recommended.kind}`,
      text: `Approve ${WINDOW_LABEL[recommended.kind]}`,
      intent: "approve",
      trustWindow: recommended,
    });
  }
  actions.push({ id: "deny", text: "Deny", intent: "deny" });
  return actions;
}

/** Collect + render the union of verbs across narrations, e.g. "WRITE", "READ + WRITE". */
function collectVerbs(narrations: readonly PendingNarration[]): string {
  const set = new Set<GrantVerb>();
  for (const n of narrations) for (const v of n.verbs) set.add(v);
  const order: GrantVerb[] = ["read", "write", "execute"];
  const labels = order.filter((v) => set.has(v)).map((v) => VERB_LABEL[v]);
  return labels.length ? labels.join(" + ") : "use";
}

/** A human capability label: first narration's id, or item.capabilities, or "a capability". */
function capabilityLabel(
  item: PendingEventItem,
  narrations: readonly PendingNarration[],
): string {
  const first = narrations[0]?.id ?? item.capabilities?.[0];
  if (!first) return "a capability";
  if (narrations.length > 1 || (item.capabilities?.length ?? 0) > 1) {
    return `${first} +${(narrations.length || item.capabilities!.length) - 1} more`;
  }
  return first;
}

/**
 * The notification body. Prefer the gateway-authored, spoof-proof
 * `notificationLine` (P1 note); fall back to the narration `summary`; finally a
 * generic line. Never agent-supplied purpose text (anti-injection).
 */
function bodyLine(narrations: readonly PendingNarration[]): string {
  for (const n of narrations) {
    if (n.notificationLine && n.notificationLine.trim()) return n.notificationLine.trim();
  }
  for (const n of narrations) {
    if (n.summary && n.summary.trim()) return n.summary.trim();
  }
  return "Plexus needs your approval.";
}
