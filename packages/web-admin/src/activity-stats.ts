/**
 * Activity summary — the pure derivations behind the Activity tab's stats band.
 *
 * Kept out of the component (like `nav.ts`) so the arithmetic is unit-testable without
 * a DOM. Everything here is a fold over the SAME event array the ledger below renders,
 * so a number in the band and a row in the table can never disagree: whatever the filter
 * bar is showing is exactly what was counted.
 */
import type { AuditEvent } from "@plexus/protocol";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The time windows offered by the range filter. */
export type RangeKey = "24h" | "7d" | "30d" | "12w" | "all";

export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "24h", label: "last 24 hours" },
  { value: "7d", label: "last 7 days" },
  { value: "30d", label: "last 30 days" },
  { value: "12w", label: "last 12 weeks" },
  { value: "all", label: "all time" },
];

const RANGE_MS: Record<Exclude<RangeKey, "all">, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "12w": 84 * DAY_MS,
};

/**
 * The oldest timestamp still inside `range`. `-Infinity` for "all time" so callers can
 * compare unconditionally instead of branching on the sentinel.
 */
export function rangeCutoff(range: RangeKey, now: number): number {
  return range === "all" ? -Infinity : now - RANGE_MS[range];
}

/** Whether an event falls inside the window. An unparseable timestamp is kept, not silently dropped. */
export function withinRange(event: AuditEvent, range: RangeKey, now: number): boolean {
  if (range === "all") return true;
  const t = Date.parse(event.at);
  if (Number.isNaN(t)) return true;
  return t >= rangeCutoff(range, now);
}

export interface ActivityStats {
  /** Every event in scope. */
  total: number;
  /** `type:"invoke"` only — the calls that actually reached a capability. */
  invokes: number;
  ok: number;
  denied: number;
  errors: number;
  /**
   * Share of invokes that succeeded, 0–1. `null` when there were no invokes at all —
   * deliberately not 0, so "nothing ran" never renders as "everything failed".
   */
  successRate: number | null;
  /** Distinct agents and capabilities seen. */
  agents: number;
  capabilities: number;
  /** Approvals that minted a standing or per-use grant. */
  grants: number;
  handshakes: number;
  /** Revocations of either kind (grant or token). */
  revokes: number;
  /** Local calendar days with at least one event. */
  activeDays: number;
  /** The heaviest single day, or `null` when nothing is in scope. */
  busiestDay: { key: string; count: number } | null;
  /** Epoch ms of the newest / oldest event in scope. */
  lastAt: number | null;
  firstAt: number | null;
}

/** Local YYYY-MM-DD key — buckets by the viewer's calendar day, matching the heatmap. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Fold an event list into the band's numbers. One pass, no allocation per event beyond the sets. */
export function summarize(events: AuditEvent[]): ActivityStats {
  const agents = new Set<string>();
  const capabilities = new Set<string>();
  const byDay = new Map<string, number>();
  let invokes = 0;
  let ok = 0;
  let denied = 0;
  let errors = 0;
  let grants = 0;
  let handshakes = 0;
  let revokes = 0;
  let lastAt: number | null = null;
  let firstAt: number | null = null;

  for (const e of events) {
    if (e.agentId) agents.add(e.agentId);
    if (e.capabilityId) capabilities.add(e.capabilityId);
    if (e.type === "invoke") {
      invokes++;
      if (e.outcome === "ok") ok++;
      else if (e.outcome === "denied") denied++;
      else if (e.outcome === "error") errors++;
    }
    if (e.type === "grant.allow") grants++;
    if (e.type === "handshake") handshakes++;
    if (e.type === "grant.revoke" || e.type === "token.revoke") revokes++;

    const t = Date.parse(e.at);
    if (!Number.isNaN(t)) {
      if (lastAt === null || t > lastAt) lastAt = t;
      if (firstAt === null || t < firstAt) firstAt = t;
      const k = dayKey(new Date(t));
      byDay.set(k, (byDay.get(k) ?? 0) + 1);
    }
  }

  let busiestDay: { key: string; count: number } | null = null;
  for (const [key, count] of byDay) {
    if (!busiestDay || count > busiestDay.count) busiestDay = { key, count };
  }

  return {
    total: events.length,
    invokes,
    ok,
    denied,
    errors,
    successRate: invokes > 0 ? ok / invokes : null,
    agents: agents.size,
    capabilities: capabilities.size,
    grants,
    handshakes,
    revokes,
    activeDays: byDay.size,
    busiestDay,
    lastAt,
    firstAt,
  };
}

/**
 * Compact relative time ("just now", "12m", "3h", "5d") for the band's freshness tile.
 * Coarse on purpose: the exact timestamp lives one row down in the ledger.
 */
export function formatRelative(at: number | null, now: number): string {
  if (at === null) return "—";
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return "just now";
  if (delta < HOUR_MS) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  return `${Math.floor(delta / DAY_MS)}d ago`;
}

/** `0.97` → `"97%"`; no invokes → an em dash rather than a misleading `0%`. */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** `"2026-08-14"` → `"Aug 14"` for the busiest-day tile. */
export function formatDayLabel(key: string | null): string {
  if (!key) return "—";
  const [y, m, d] = key.split("-").map((x) => Number.parseInt(x, 10));
  if (!y || !m || !d) return "—";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[m - 1]} ${d}`;
}
