/**
 * T4 — Tunnel transport (WS multiplexer). Integration tests for the raw,
 * unauthenticated framed-RPC multiplexer over a single persistent WebSocket
 * (federated-mesh §7 Q1/Q2, phase-1 plan seam (b)).
 *
 * Server + client run in ONE process over loopback. We prove the four properties
 * the multiplexer exists to guarantee:
 *
 *   (a) CORRELATION — `client.request(frame)` resolves with the reply that carries
 *       the matching `corr` (and the server handler sees the request).
 *   (b) RECONNECT  — after a forced socket close the client redials, and a fresh
 *       request succeeds on the new connection.
 *   (c) NO CROSSING — two concurrent in-flight requests with different `corr`,
 *       whose replies arrive OUT OF ORDER, each resolve to their OWN reply.
 *   (d) TIMEOUT    — a request whose reply never comes rejects cleanly (no hang).
 *
 * Frames come from the protocol `Frame` union (landed by T1) — we never redefine them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import type { Frame, InvokeFrame, InvokeResultFrame } from "@plexus/protocol";

import { MeshServer, MeshClient, MeshTimeoutError } from "@plexus/runtime/mesh/tunnel.ts";
import { newCorr, isFrame } from "@plexus/runtime/mesh/frames.ts";

// ── Frame builders (use the real protocol union) ───────────────────────────────

function invoke(corr: string, id: string, input?: unknown): InvokeFrame {
  return { t: "invoke", corr, payload: { address: `tenant/wl/src.${id}`, id, input } };
}

function invokeResult(corr: string, id: string, output: unknown): InvokeResultFrame {
  return { t: "invoke-result", corr, payload: { id, ok: true, output, auditId: "" } };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Harness ────────────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Start a server with the given inbound-request handler; return it + its ws URL. */
function startServer(onRequest?: (f: Frame) => Frame | Promise<Frame>): {
  server: MeshServer;
  url: string;
} {
  const server = new MeshServer({ onRequest, requestTimeoutMs: 2_000 });
  const { port } = server.start();
  cleanups.push(() => server.stop());
  return { server, url: `ws://127.0.0.1:${port}` };
}

function startClient(url: string, opts: Partial<{ requestTimeoutMs: number }> = {}): MeshClient {
  const client = new MeshClient({ url, requestTimeoutMs: opts.requestTimeoutMs ?? 2_000 });
  cleanups.push(() => client.close());
  return client;
}

// ── (a) correlation ─────────────────────────────────────────────────────────────

describe("mesh tunnel multiplexer", () => {
  it("(a) resolves a request with the matching-corr reply", async () => {
    const seen: string[] = [];
    const { url } = startServer((f) => {
      seen.push(f.corr);
      // Reply with an invoke-result; the mux stamps it with the request's corr.
      const id = isFrame(f, "invoke") ? f.payload.id : "?";
      return invokeResult("ignored", id, { echo: id });
    });
    const client = startClient(url);

    const corr = newCorr();
    const reply = await client.request(invoke(corr, "alpha"));

    expect(reply.corr).toBe(corr);
    expect(reply.t).toBe("invoke-result");
    if (isFrame(reply, "invoke-result")) {
      expect(reply.payload.output).toEqual({ echo: "alpha" });
    }
    expect(seen).toContain(corr);
  });

  // ── (b) reconnect-after-close ──────────────────────────────────────────────────

  it("(b) reconnects after a forced socket close and serves a fresh request", async () => {
    const { server, url } = startServer((f) => {
      const id = isFrame(f, "invoke") ? f.payload.id : "?";
      return invokeResult("ignored", id, { echo: id });
    });
    const client = startClient(url);

    const first = await client.request(invoke(newCorr(), "before"));
    expect(isFrame(first, "invoke-result") && first.payload.output).toEqual({ echo: "before" });

    // Force the tunnel down from the primary side (a network blip / primary drop).
    server.dropActiveConnection();

    // The client redials with backoff; request() waits for the fresh socket.
    const corr = newCorr();
    const after = await client.request(invoke(corr, "after"));
    expect(after.corr).toBe(corr);
    expect(isFrame(after, "invoke-result") && after.payload.output).toEqual({ echo: "after" });
  });

  // ── (c) concurrent in-flight do not cross ───────────────────────────────────────

  it("(c) keeps two concurrent in-flight requests from crossing", async () => {
    // Slow request resolves AFTER the fast one — replies arrive out of submit order.
    const { url } = startServer(async (f) => {
      if (!isFrame(f, "invoke")) return f;
      const { id, input } = f.payload;
      await sleep((input as { delay: number }).delay);
      return invokeResult("ignored", id, { id });
    });
    const client = startClient(url);

    const corrSlow = newCorr();
    const corrFast = newCorr();
    expect(corrSlow).not.toBe(corrFast);

    const [slow, fast] = await Promise.all([
      client.request(invoke(corrSlow, "slow", { delay: 80 })),
      client.request(invoke(corrFast, "fast", { delay: 5 })),
    ]);

    // Each promise got ITS OWN reply, matched by corr — no crossing.
    expect(slow.corr).toBe(corrSlow);
    expect(fast.corr).toBe(corrFast);
    expect(isFrame(slow, "invoke-result") && slow.payload.output).toEqual({ id: "slow" });
    expect(isFrame(fast, "invoke-result") && fast.payload.output).toEqual({ id: "fast" });
  });

  // ── (d) clean timeout ───────────────────────────────────────────────────────────

  it("(d) rejects cleanly when no reply ever arrives", async () => {
    // Server with NO request handler: it receives the frame and never replies.
    const { url } = startServer(undefined);
    const client = startClient(url, { requestTimeoutMs: 150 });

    const corr = newCorr();
    const start = Date.now();
    let caught: unknown;
    try {
      await client.request(invoke(corr, "void"), 150);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MeshTimeoutError);
    expect((caught as MeshTimeoutError).corr).toBe(corr);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  });
});
