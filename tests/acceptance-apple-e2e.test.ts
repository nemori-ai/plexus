/**
 * acceptance-apple-e2e — the Apple-native first-party sources acceptance gate.
 *
 * Runs the codex × Plexus Apple-sources 玩法 (`tests/harnesses/acceptance-apple/scenario.ts`
 * `runScenario()`) HEADLESS against a freshly-booted real gateway (in-process via
 * `app.request`, fetch-shaped — same uniform pipeline, no socket) and asserts EVERY
 * step is genuinely green: the three Apple sources auto-register first-party (each with
 * a health field on `.well-known`), codex handshakes + is granted events.list (read,
 * auto-approved) and reminders.create / apple-notes.notes.create (writes, first-party-elevated →
 * PEND → human-approved), runs the dispatched daily-review task (lists today's events →
 * creates a follow-up reminder + a prep note → both verified present in the fake
 * stores), the full audit chain is present + ordered, and a revoked reminders-write token
 * is rejected with HTTP 401 `token_revoked` while the calendar read still works.
 *
 * Hermetic: `PLEXUS_FAKE_APPLE=1` (fake Apple providers — no real macOS / TCC / network),
 * temp PLEXUS_HOME, in-process gateway (never binds :7077). The scenario restores env +
 * cleans up its temp fixtures in a `finally`.
 */

import { describe, it, expect } from "bun:test";
import {
  runScenario,
  silentLogger,
  TASK,
  EVENTS_LIST_ID,
  REMINDERS_CREATE_ID,
  REMINDERS_LIST_ID,
  NOTES_CREATE_ID,
  NOTES_SEARCH_ID,
} from "./harnesses/acceptance-apple/scenario.ts";

describe("Plexus — codex × Apple-native first-party sources acceptance玩法", () => {
  it("runs the whole pipeline end-to-end and every step is genuinely green", async () => {
    const report = await runScenario({ logger: silentLogger() });

    // Every individual harness check passed (the per-step ✓ assertions).
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.label)).toEqual([]);
    expect(report.pass).toBe(true);

    // ── Step 2: discover — the three Apple capabilities are first-party + carry health ─
    expect(report.sessionId).toBeTruthy();
    const discoveredIds = report.discovered.map((d) => d.id);
    expect(discoveredIds).toContain(EVENTS_LIST_ID);
    expect(discoveredIds).toContain(REMINDERS_CREATE_ID);
    expect(discoveredIds).toContain(NOTES_CREATE_ID);
    expect(report.discovered.every((d) => d.provenance === "first-party")).toBe(true);
    expect(report.discovered.every((d) => typeof d.health === "string" && d.health!.length > 0)).toBe(true);

    // ── Step 3: the authz story — read auto-approves, writes PEND → approved ──────────
    const flow = new Map(report.grantFlow.map((g) => [g.id, g.pended]));
    expect(flow.get(EVENTS_LIST_ID)).toBe(false); // first-party read auto-approves.
    expect(flow.get(REMINDERS_CREATE_ID)).toBe(true); // first-party-elevated write pends.
    expect(flow.get(NOTES_CREATE_ID)).toBe(true); // first-party-elevated write pends.
    expect(report.grantedCaps).toContain(EVENTS_LIST_ID);
    expect(report.grantedCaps).toContain(REMINDERS_CREATE_ID);
    expect(report.grantedCaps).toContain(NOTES_CREATE_ID);

    // ── Step 4: the dispatched task completed — events seen + both writes verified ────
    expect(report.task).toBe(TASK);
    expect(report.seenEvents.length).toBeGreaterThan(0);
    expect(report.followUpSubject.length).toBeGreaterThan(0);
    expect(report.createdReminder.title).toBe(`Follow up on ${report.followUpSubject}`);
    expect(report.reminderVerifiedInList).toBe(true);
    expect(report.createdNote.title).toBe(`Prep for ${report.followUpSubject}`);
    expect(report.createdNote.verifiedInSearch).toBe(true);

    // ── Step 5: the full audit chain is present + ordered ────────────────────────────
    const kinds = report.audit.map((e) => e.type);
    expect(kinds).toContain("handshake");
    expect(kinds.includes("grant.allow") || kinds.includes("grant.pending")).toBe(true);
    expect(kinds).toContain("token.issue");
    const invokedCaps = report.audit.filter((e) => e.type === "invoke").map((e) => e.capabilityId);
    expect(invokedCaps).toContain(EVENTS_LIST_ID);
    expect(invokedCaps).toContain(REMINDERS_CREATE_ID);
    expect(invokedCaps).toContain(NOTES_CREATE_ID);
    expect(invokedCaps).toContain(REMINDERS_LIST_ID);
    expect(invokedCaps).toContain(NOTES_SEARCH_ID);
    // handshake precedes the first invoke.
    const firstHandshake = report.audit.findIndex((e) => e.type === "handshake");
    const firstInvoke = report.audit.findIndex((e) => e.type === "invoke");
    expect(firstHandshake).toBeGreaterThanOrEqual(0);
    expect(firstHandshake).toBeLessThan(firstInvoke);

    // ── Step 6: revoke proof — old reminders-write token rejected; calendar read ok ──
    expect(report.revokeDenial.status).toBe(401);
    expect(report.revokeDenial.code).toBe("token_revoked");
    expect(report.readStillWorksAfterRevoke).toBe(true);
  }, 30_000);
});
