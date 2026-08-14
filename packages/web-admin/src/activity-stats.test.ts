/**
 * Unit tests for the Activity summary band's pure derivations — the arithmetic behind
 * every figure the band shows. No DOM: these test the fold, not the render.
 *
 * The property that matters most is the one asserted last: the band counts EXACTLY the
 * events the ledger below it renders, so a number and a row can never disagree.
 */
import { describe, it, expect } from "bun:test";
import type { AuditEvent } from "@plexus/protocol";
import {
  summarize,
  withinRange,
  rangeCutoff,
  formatRelative,
  formatRate,
  formatDayLabel,
} from "./activity-stats.ts";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function ev(partial: Partial<AuditEvent> & { at: string }): AuditEvent {
  return { id: `evt_${Math.random()}`, type: "invoke", ...partial } as AuditEvent;
}

describe("rangeCutoff / withinRange — the time filter", () => {
  it("all-time admits everything via a -Infinity floor (no sentinel branch for callers)", () => {
    expect(rangeCutoff("all", NOW)).toBe(-Infinity);
    expect(withinRange(ev({ at: "1999-01-01T00:00:00.000Z" }), "all", NOW)).toBe(true);
  });

  it("bounds each window at its own edge", () => {
    expect(rangeCutoff("24h", NOW)).toBe(NOW - DAY);
    expect(rangeCutoff("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(rangeCutoff("30d", NOW)).toBe(NOW - 30 * DAY);
    expect(rangeCutoff("12w", NOW)).toBe(NOW - 84 * DAY);
  });

  it("keeps an event inside the window and drops one outside it", () => {
    const recent = ev({ at: new Date(NOW - 2 * HOUR).toISOString() });
    const old = ev({ at: new Date(NOW - 3 * DAY).toISOString() });
    expect(withinRange(recent, "24h", NOW)).toBe(true);
    expect(withinRange(old, "24h", NOW)).toBe(false);
    expect(withinRange(old, "7d", NOW)).toBe(true);
  });

  it("KEEPS an unparseable timestamp rather than silently dropping it from the audit view", () => {
    expect(withinRange(ev({ at: "not-a-date" }), "24h", NOW)).toBe(true);
  });
});

describe("summarize — the band's figures", () => {
  const events: AuditEvent[] = [
    ev({ at: "2026-08-14T10:00:00.000Z", type: "invoke", outcome: "ok", agentId: "tanka", capabilityId: "codex.run" }),
    ev({ at: "2026-08-14T10:05:00.000Z", type: "invoke", outcome: "ok", agentId: "tanka", capabilityId: "codex.run" }),
    ev({ at: "2026-08-14T10:06:00.000Z", type: "invoke", outcome: "denied", agentId: "raven", capabilityId: "sysinfo.processes.list" }),
    ev({ at: "2026-08-14T10:07:00.000Z", type: "invoke", outcome: "error", agentId: "raven", capabilityId: "sysinfo.processes.list" }),
    ev({ at: "2026-08-13T09:00:00.000Z", type: "grant.allow", agentId: "tanka", capabilityId: "codex.run" }),
    ev({ at: "2026-08-13T09:00:01.000Z", type: "handshake", agentId: "tanka" }),
    ev({ at: "2026-08-13T09:00:02.000Z", type: "token.revoke", agentId: "tanka" }),
  ];

  const s = summarize(events);

  it("separates every event from the invokes among them", () => {
    expect(s.total).toBe(7);
    expect(s.invokes).toBe(4);
  });

  it("splits invoke outcomes and rates success against invokes only", () => {
    expect(s.ok).toBe(2);
    expect(s.denied).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.successRate).toBe(0.5);
  });

  it("counts distinct principals and capabilities, not occurrences", () => {
    expect(s.agents).toBe(2);
    expect(s.capabilities).toBe(2);
  });

  it("counts lifecycle events by type", () => {
    expect(s.grants).toBe(1);
    expect(s.handshakes).toBe(1);
    expect(s.revokes).toBe(1);
  });

  it("finds the busiest local day and the active-day count", () => {
    expect(s.activeDays).toBe(2);
    expect(s.busiestDay?.count).toBe(4);
  });

  it("brackets the window with the newest and oldest timestamps", () => {
    expect(s.lastAt).toBe(Date.parse("2026-08-14T10:07:00.000Z"));
    expect(s.firstAt).toBe(Date.parse("2026-08-13T09:00:00.000Z"));
  });

  it("reports NO success rate rather than 0% when nothing ran", () => {
    // The distinction matters: 0% reads as "everything failed", which would be a lie.
    const quiet = summarize([ev({ at: "2026-08-14T10:00:00.000Z", type: "handshake", agentId: "tanka" })]);
    expect(quiet.invokes).toBe(0);
    expect(quiet.successRate).toBeNull();
    expect(formatRate(quiet.successRate)).toBe("—");
  });

  it("is empty-safe", () => {
    const none = summarize([]);
    expect(none.total).toBe(0);
    expect(none.busiestDay).toBeNull();
    expect(none.lastAt).toBeNull();
    expect(none.activeDays).toBe(0);
  });

  it("counts EXACTLY the filtered array it is handed — band and ledger cannot disagree", () => {
    const filtered = events.filter((e) => e.agentId === "tanka");
    const only = summarize(filtered);
    expect(only.total).toBe(filtered.length);
    expect(only.agents).toBe(1);
    expect(only.denied + only.errors).toBe(0);
  });
});

describe("formatters", () => {
  it("renders relative time coarsely, and an em dash for nothing", () => {
    expect(formatRelative(null, NOW)).toBe("—");
    expect(formatRelative(NOW - 5_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(formatRelative(NOW - 3 * HOUR, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 5 * DAY, NOW)).toBe("5d ago");
  });

  it("never renders a future timestamp as negative", () => {
    expect(formatRelative(NOW + 10_000, NOW)).toBe("just now");
  });

  it("renders rates as whole percents", () => {
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0.5)).toBe("50%");
    expect(formatRate(0)).toBe("0%");
  });

  it("renders a day key as a short label", () => {
    expect(formatDayLabel("2026-08-14")).toBe("Aug 14");
    expect(formatDayLabel(null)).toBe("—");
    expect(formatDayLabel("garbage")).toBe("—");
  });
});
