/**
 * Networking resilience — BOUNDED reconnect backoff + HEARTBEAT half-open detection at the raw
 * tunnel layer (networking-resilience design §1/§2). No primary runtime here — just `MeshClient`
 * against a controllable `MeshServer`, so we can drive the backoff + keepalive deterministically.
 *
 *   (a) BOUNDED BACKOFF — a client dialing a DEAD url backs off with capped exponential delay;
 *       EVERY scheduled delay is ≤ the cap and the (un-jittered) sequence climbs to the cap and
 *       plateaus — no reset-on-open storm.
 *   (b) JITTER stays ≤ cap — with jitter ON every scheduled delay is still ≤ the cap.
 *   (c) HEARTBEAT detects a HALF-OPEN socket — a server that silently black-holes pings (never
 *       replies, never closes) trips the client's heartbeat, forcing a reconnect (connected →
 *       reconnecting) even though the socket was never dropped.
 */

import { describe, it, expect, afterEach } from "bun:test";
import type { Frame } from "@plexus/protocol";

import { MeshServer, MeshClient, type MeshConnectionState } from "@plexus/runtime/mesh/tunnel.ts";
import { isFrame } from "@plexus/runtime/mesh/frames.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(5);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("networking resilience — bounded backoff", () => {
  it("(a) capped exponential backoff: every scheduled delay ≤ cap; sequence climbs then plateaus", async () => {
    const initial = 20;
    const cap = 160;
    const delays: number[] = [];
    // A dead url (nothing listening) → every dial fails → the client schedules reconnects.
    const client = new MeshClient({
      url: "ws://127.0.0.1:1", // port 1: connection refused
      autoReconnect: true,
      backoffInitialMs: initial,
      backoffMaxMs: cap,
      backoffJitter: false, // deterministic so we can assert the exact climb-to-cap
      heartbeatIntervalMs: 0, // irrelevant (never connects)
      onReconnectScheduled: ({ delayMs }) => delays.push(delayMs),
    });
    cleanups.push(() => client.close());

    await until(() => delays.length >= 6, 6_000);
    client.close();

    expect(delays.length).toBeGreaterThanOrEqual(6);
    // Bounded: NO scheduled delay ever exceeds the cap (no runaway).
    for (const d of delays) expect(d).toBeLessThanOrEqual(cap);
    // Climbs (non-decreasing) and reaches the cap, then plateaus there.
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays).toContain(cap);
    expect(delays.at(-1)).toBe(cap);
  });

  it("(b) with jitter ON, every scheduled delay is still ≤ cap", async () => {
    const cap = 120;
    const delays: number[] = [];
    const client = new MeshClient({
      url: "ws://127.0.0.1:1",
      autoReconnect: true,
      backoffInitialMs: 20,
      backoffMaxMs: cap,
      backoffJitter: true,
      heartbeatIntervalMs: 0,
      onReconnectScheduled: ({ delayMs }) => delays.push(delayMs),
    });
    cleanups.push(() => client.close());

    await until(() => delays.length >= 6, 6_000);
    client.close();

    expect(delays.length).toBeGreaterThanOrEqual(6);
    for (const d of delays) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(cap);
    }
  });
});

describe("networking resilience — heartbeat half-open detection", () => {
  it("(c) a server that black-holes pings trips the heartbeat → forces a reconnect", async () => {
    // The server ACCEPTS the socket and NEVER closes it, but THROWS on every ping (so the mux
    // sends no reply — a silently half-open tunnel). Non-ping frames are echoed.
    const server = new MeshServer({
      requestTimeoutMs: 2_000,
      onRequest: (f: Frame) => {
        if (isFrame(f, "ping")) throw new Error("black hole — no pong");
        return f;
      },
    });
    const { port } = server.start();
    cleanups.push(() => server.stop());

    const states: MeshConnectionState[] = [];
    const client = new MeshClient({
      url: `ws://127.0.0.1:${port}`,
      autoReconnect: true,
      backoffInitialMs: 20,
      backoffMaxMs: 80,
      heartbeatIntervalMs: 60, // beat fast
      heartbeatTimeoutMs: 120, // and time out fast on a black-holed pong
      onStateChange: (s) => states.push(s),
    });
    cleanups.push(() => client.close());

    // It connects first (raw transport ⇒ ready on open).
    await until(() => client.connectionState === "connected");
    expect(states).toContain("connected");

    // The heartbeat ping is black-holed → times out → forceReconnect → the client leaves
    // "connected" for "reconnecting" even though the SERVER never dropped the socket.
    await until(() => states.includes("reconnecting"), 3_000);
    expect(states).toContain("reconnecting");
    // Specifically a connected → reconnecting transition (heartbeat-driven, not an open failure).
    const connectedAt = states.indexOf("connected");
    const reconnectAfter = states.indexOf("reconnecting", connectedAt + 1);
    expect(reconnectAfter).toBeGreaterThan(connectedAt);

    client.close();
  });
});
