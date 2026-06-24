/**
 * ============================================================================
 * P2 DESKTOP — pure-helper unit tests (OS/GUI-independent)
 * ============================================================================
 *
 * The Electron desktop shell's GUI is hard to assert, so every decision that can
 * be a pure function IS one, and is tested here with fakes (no real Electron, no
 * sockets). Covers the four pure cores REDESIGN/P2 names:
 *   1. PORT PARSER       — `PLEXUS_READY {...}` line + runtime.json (port discovery)
 *   2. BADGE COUNTER     — pending_added/pending_resolved sequence → count
 *   3. NOTIFICATION MAP  — pending_added item → {title, body, actions}
 *   4. APPROVE-CALL      — the resolve URL/body/headers builder
 *   (+ the SSE frame parser that feeds the management event stream)
 */

import { describe, it, expect } from "bun:test";
import {
  parseReadyLine,
  scanForReadyLine,
  parseRuntimeFile,
  baseUrlFor,
  PendingTracker,
  badgeCountFromEvents,
  buildNotificationPayload,
  buildResolvePendingRequest,
  buildPendingSnapshotRequest,
  buildHealthRequest,
  buildEventsRequest,
  adminUrl,
  SseParser,
  parseFrame,
} from "@plexus/desktop";
import type {
  PendingAddedEvent,
  PendingResolvedEvent,
  PendingEventItem,
  PendingNarration,
} from "@plexus/protocol";

// ── helpers / fixtures ───────────────────────────────────────────────────────

function added(pendingId: string, item?: Partial<PendingEventItem>): PendingAddedEvent {
  return {
    type: "pending_added",
    item: {
      pendingId,
      kind: "grant",
      createdAt: "2026-06-24T00:00:00.000Z",
      ...item,
    },
  };
}
function resolved(pendingId: string): PendingResolvedEvent {
  return { type: "pending_resolved", pendingId, kind: "grant", decision: "approved" };
}
function narration(over?: Partial<PendingNarration>): PendingNarration {
  return {
    id: "obsidian.vault.write",
    verbs: ["write"],
    provenance: "extension",
    sensitivity: "elevated",
    defaultTrustWindow: { kind: "1d" },
    summary: "Approving lets claude-code WRITE your Obsidian vault for up to 1 day.",
    notificationLine:
      'claude-code wants to WRITE your Obsidian vault — "file today\'s notes"',
    ...over,
  };
}

// ── 1. PORT PARSER ─────────────────────────────────────────────────────────────

describe("port discovery — PLEXUS_READY line / runtime.json parser", () => {
  it("parses a well-formed ready line", () => {
    const d = parseReadyLine('PLEXUS_READY {"port":54321,"pid":1234,"lraVersion":"1.0"}');
    expect(d).toEqual({ port: 54321, pid: 1234, lraVersion: "1.0" });
  });

  it("tolerates surrounding whitespace + trailing newline", () => {
    const d = parseReadyLine('  PLEXUS_READY {"port":7077,"pid":9,"lraVersion":"1.0"}  \n');
    expect(d?.port).toBe(7077);
  });

  it("ignores non-ready lines (human log noise)", () => {
    expect(parseReadyLine("Plexus listening on http://127.0.0.1:7077")).toBeNull();
    expect(parseReadyLine("")).toBeNull();
    expect(parseReadyLine("PLEXUS_READY not-json")).toBeNull();
  });

  it("rejects a missing/invalid port (port is the load-bearing fact)", () => {
    expect(parseReadyLine('PLEXUS_READY {"pid":1,"lraVersion":"1.0"}')).toBeNull();
    expect(parseReadyLine('PLEXUS_READY {"port":0}')).toBeNull();
    expect(parseReadyLine('PLEXUS_READY {"port":70000}')).toBeNull();
    expect(parseReadyLine('PLEXUS_READY {"port":"7077"}')).toBeNull();
  });

  it("defaults pid/lraVersion when absent but port present", () => {
    const d = parseReadyLine('PLEXUS_READY {"port":7077}');
    expect(d).toEqual({ port: 7077, pid: 0, lraVersion: "unknown" });
  });

  it("scanForReadyLine finds the ready line in a multi-line stdout chunk", () => {
    const chunk =
      "Plexus boot…\nGenerated connection-key\n" +
      'PLEXUS_READY {"port":61000,"pid":42,"lraVersion":"1.0"}\nmanagement URL: …\n';
    expect(scanForReadyLine(chunk)?.port).toBe(61000);
    expect(scanForReadyLine("no ready here\nstill nothing")).toBeNull();
  });

  it("parses runtime.json fallback contents", () => {
    const d = parseRuntimeFile('{"port":52000,"pid":7,"lraVersion":"1.0"}\n');
    expect(d?.port).toBe(52000);
    expect(parseRuntimeFile("")).toBeNull();
    expect(parseRuntimeFile("not json")).toBeNull();
  });

  it("baseUrlFor always targets loopback", () => {
    expect(baseUrlFor(54321)).toBe("http://127.0.0.1:54321");
  });
});

// ── 2. BADGE COUNTER ──────────────────────────────────────────────────────────

describe("badge counter — open pending tracker", () => {
  it("counts added − resolved over a sequence", () => {
    const t = new PendingTracker();
    expect(t.count).toBe(0);
    t.add(added("p1"));
    t.add(added("p2"));
    expect(t.count).toBe(2);
    t.resolve(resolved("p1"));
    expect(t.count).toBe(1);
    t.resolve(resolved("p2"));
    expect(t.count).toBe(0);
  });

  it("is idempotent on duplicate pending_added (redelivery can't double-count)", () => {
    const t = new PendingTracker();
    t.add(added("p1"));
    t.add(added("p1"));
    expect(t.count).toBe(1);
  });

  it("never goes negative on an unknown pending_resolved", () => {
    const t = new PendingTracker();
    t.resolve(resolved("ghost"));
    expect(t.count).toBe(0);
  });

  it("reset() re-seeds from an authoritative snapshot (SSE has no replay)", () => {
    const t = new PendingTracker();
    t.add(added("stale"));
    t.reset(["a", "b", "c"]);
    expect(t.count).toBe(3);
    expect(t.openIds().sort()).toEqual(["a", "b", "c"]);
  });

  it("badgeCountFromEvents folds a mixed sequence to the final count", () => {
    const count = badgeCountFromEvents([
      added("p1"),
      added("p2"),
      resolved("p1"),
      added("p3"),
      resolved("nope"),
    ]);
    expect(count).toBe(2); // p2 + p3 open
  });

  it("badgeCountFromEvents honors a seed set of already-open ids", () => {
    const count = badgeCountFromEvents([resolved("seed1"), added("new1")], ["seed1", "seed2"]);
    expect(count).toBe(2); // seed2 + new1
  });
});

// ── 3. NOTIFICATION PAYLOAD MAPPING ────────────────────────────────────────────

describe("notification mapping — pending_added item → {title, body, actions}", () => {
  it("maps a single-capability grant to a glanceable Mode-1 card", () => {
    const item: PendingEventItem = {
      pendingId: "pg1",
      kind: "grant",
      createdAt: "2026-06-24T00:00:00.000Z",
      agentId: "claude-code",
      capabilities: ["obsidian.vault.write"],
      pendingNarration: [narration()],
    };
    const p = buildNotificationPayload(item);
    expect(p.title).toBe("claude-code wants to WRITE obsidian.vault.write");
    // body is the gateway-authored, spoof-proof notificationLine, verbatim.
    expect(p.body).toBe(
      'claude-code wants to WRITE your Obsidian vault — "file today\'s notes"',
    );
    expect(p.oneTapAllowed).toBe(true);
    // Approve once + Approve {recommended=1 day} + Deny.
    expect(p.actions.map((a) => a.text)).toEqual(["Approve once", "Approve 1 day", "Deny"]);
    const onceAction = p.actions[0]!;
    expect(onceAction.intent).toBe("approve");
    expect(onceAction.trustWindow).toEqual({ kind: "once" });
    expect(p.actions[1]!.trustWindow).toEqual({ kind: "1d" });
    expect(p.actions[2]!.intent).toBe("deny");
  });

  it("falls back to summary when notificationLine is absent", () => {
    const item: PendingEventItem = {
      pendingId: "pg2",
      kind: "grant",
      createdAt: "2026-06-24T00:00:00.000Z",
      agentId: "codex",
      pendingNarration: [narration({ notificationLine: undefined })],
    };
    const p = buildNotificationPayload(item);
    expect(p.body).toBe(
      "Approving lets claude-code WRITE your Obsidian vault for up to 1 day.",
    );
  });

  it("renders the union of verbs, ordered read→write→execute", () => {
    const item: PendingEventItem = {
      pendingId: "pg3",
      kind: "grant",
      createdAt: "2026-06-24T00:00:00.000Z",
      agentId: "claude-code",
      capabilities: ["nas.fs.all"],
      pendingNarration: [narration({ id: "nas.fs.all", verbs: ["write", "read"] })],
    };
    const p = buildNotificationPayload(item);
    expect(p.title).toBe("claude-code wants to READ + WRITE nas.fs.all");
  });

  it("multi-capability grant → never 1-tap, only a Review action (bundle-shaped)", () => {
    const item: PendingEventItem = {
      pendingId: "pg4",
      kind: "grant",
      createdAt: "2026-06-24T00:00:00.000Z",
      agentId: "claude-code",
      capabilities: ["nas.fs.read", "nas.fs.move"],
      pendingNarration: [
        narration({ id: "nas.fs.read", verbs: ["read"] }),
        narration({ id: "nas.fs.move", verbs: ["write"] }),
      ],
    };
    const p = buildNotificationPayload(item);
    expect(p.oneTapAllowed).toBe(false);
    expect(p.actions.map((a) => a.intent)).toEqual(["review"]);
    expect(p.title).toContain("+1 more");
  });

  it("register (extension install) pending → never 1-tap, opens admin", () => {
    const item: PendingEventItem = {
      pendingId: "pr1",
      kind: "register",
      createdAt: "2026-06-24T00:00:00.000Z",
      source: "my-mcp-server",
    };
    const p = buildNotificationPayload(item);
    expect(p.oneTapAllowed).toBe(false);
    expect(p.title).toBe("An agent wants to register my-mcp-server");
    expect(p.actions.map((a) => a.intent)).toEqual(["review"]);
  });

  it("only offers `once` when the recommended window is also `once`", () => {
    const item: PendingEventItem = {
      pendingId: "pg5",
      kind: "grant",
      createdAt: "2026-06-24T00:00:00.000Z",
      agentId: "claude-code",
      capabilities: ["x.y"],
      pendingNarration: [narration({ id: "x.y", defaultTrustWindow: { kind: "once" } })],
    };
    const p = buildNotificationPayload(item);
    expect(p.actions.map((a) => a.text)).toEqual(["Approve once", "Deny"]);
  });
});

// ── 4. APPROVE-CALL URL/BODY BUILDER ────────────────────────────────────────────

describe("LRA request builders — approve/deny + snapshot + health + events", () => {
  it("builds the approve POST with trustWindow + management headers", () => {
    const req = buildResolvePendingRequest({
      port: 7077,
      connectionKey: "secret-key",
      pendingId: "pg1",
      decision: { action: "approve", trustWindow: { kind: "1d" } },
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://127.0.0.1:7077/v1/admin/api/pending/pg1");
    expect(req.headers["X-Plexus-Connection-Key"]).toBe("secret-key");
    expect(req.headers["Host"]).toBe("127.0.0.1:7077");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body!)).toEqual({ action: "approve", trustWindow: { kind: "1d" } });
  });

  it("builds a deny POST (no trustWindow; optional reason)", () => {
    const req = buildResolvePendingRequest({
      port: 52000,
      connectionKey: "k",
      pendingId: "pg2",
      decision: { action: "deny", reason: "not now" },
    });
    expect(JSON.parse(req.body!)).toEqual({ action: "deny", reason: "not now" });
  });

  it("threads an agentId re-target onto the approve body", () => {
    const req = buildResolvePendingRequest({
      port: 7077,
      connectionKey: "k",
      pendingId: "pg3",
      decision: { action: "approve", trustWindow: { kind: "once" }, agentId: "codex" },
    });
    expect(JSON.parse(req.body!)).toEqual({
      action: "approve",
      trustWindow: { kind: "once" },
      agentId: "codex",
    });
  });

  it("url-encodes a pendingId with unsafe characters", () => {
    const req = buildResolvePendingRequest({
      port: 7077,
      connectionKey: "k",
      pendingId: "a/b id",
      decision: { action: "deny" },
    });
    expect(req.url).toBe("http://127.0.0.1:7077/v1/admin/api/pending/a%2Fb%20id");
  });

  it("builds the pending snapshot GET (re-seed the badge)", () => {
    const req = buildPendingSnapshotRequest({ port: 7077, connectionKey: "k" });
    expect(req).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:7077/v1/admin/api/pending",
    });
    expect(req.headers["X-Plexus-Connection-Key"]).toBe("k");
    expect(req.body).toBeUndefined();
  });

  it("builds the health probe GET (no key; loopback Host)", () => {
    const req = buildHealthRequest({ port: 7077 });
    expect(req.url).toBe("http://127.0.0.1:7077/v1/health");
    expect(req.headers["Host"]).toBe("127.0.0.1:7077");
    expect(req.headers["X-Plexus-Connection-Key"]).toBeUndefined();
  });

  it("builds the SSE events GET (key-gated, event-stream accept)", () => {
    const req = buildEventsRequest({ port: 7077, connectionKey: "k" });
    expect(req.url).toBe("http://127.0.0.1:7077/v1/events");
    expect(req.headers["Accept"]).toBe("text/event-stream");
    expect(req.headers["X-Plexus-Connection-Key"]).toBe("k");
  });

  it("adminUrl points the renderer at the served /admin SPA", () => {
    expect(adminUrl(54321)).toBe("http://127.0.0.1:54321/admin");
  });
});

// ── 5. SSE FRAME PARSER (feeds the management event stream) ──────────────────────

describe("SSE parser — decode /v1/events frames", () => {
  it("parses a single complete frame into a typed PlexusEvent", () => {
    const frame = 'event: pending_added\ndata: {"type":"pending_added","item":{"pendingId":"p1","kind":"grant","createdAt":"2026-06-24T00:00:00.000Z"}}';
    const ev = parseFrame(frame);
    expect(ev?.type).toBe("pending_added");
    expect((ev as PendingAddedEvent).item.pendingId).toBe("p1");
  });

  it("skips comment/keep-alive lines", () => {
    expect(parseFrame(": plexus management event stream")).toBeNull();
  });

  it("streams multiple frames across chunk boundaries, retaining the partial tail", () => {
    const parser = new SseParser();
    const out1 = parser.push(": open\n\nevent: pending_resolved\ndata: {\"type\":\"pending_resolved\",\"pendingId\":\"p1\",\"kind\":\"grant\",\"decision\":\"approved\"}\n\nevent: pending_added\ndata: {\"type\":\"pending_added\",\"item\":{\"pendingId\"");
    // First full frame (pending_resolved) emitted; the second is still partial.
    expect(out1.map((e) => e.type)).toEqual(["pending_resolved"]);
    const out2 = parser.push(':"p2","kind":"grant","createdAt":"2026-06-24T00:00:00.000Z"}}\n\n');
    expect(out2.map((e) => e.type)).toEqual(["pending_added"]);
    expect((out2[0] as PendingAddedEvent).item.pendingId).toBe("p2");
  });

  it("drops a malformed JSON frame without throwing (one bad frame can't kill the stream)", () => {
    const parser = new SseParser();
    const out = parser.push("event: x\ndata: {not json}\n\nevent: pending_resolved\ndata: {\"type\":\"pending_resolved\",\"pendingId\":\"p3\",\"kind\":\"grant\",\"decision\":\"denied\"}\n\n");
    expect(out.map((e) => e.type)).toEqual(["pending_resolved"]);
  });
});
