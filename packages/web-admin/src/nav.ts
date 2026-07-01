/**
 * Navigation seams for the admin shell — small, DOM-free helpers so they stay
 * unit-testable without rendering React (App.tsx has module-load side effects).
 */

/**
 * The Activity tab's initial agent-filter value. A non-empty pending agent id
 * (threaded from a "Recent activity →" jump) pre-selects that agent; anything
 * else falls back to the "all" sentinel so a plain top-nav visit stays unfiltered.
 * Pure + total.
 */
export function initialAgentFilter(pending: string | null | undefined): string {
  return pending && pending.trim() ? pending : "all";
}
