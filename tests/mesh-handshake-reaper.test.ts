/**
 * Networking + encryption HARDENING — two DoS sharp edges at the raw tunnel layer
 * (networking-resilience §2 handshake reaper; encryption-policy §2.1 reloadTls rollback). No
 * primary runtime here — just `MeshServer` driven directly so the half-open / rebind paths are
 * observable.
 *
 *   (a) HANDSHAKE-PHASE REAPER — a socket that connects under the auth gate and NEVER completes
 *       the handshake (the driver stalls forever) is closed and dropped from the server's
 *       `handshakes` set once `handshakeDeadlineMs` elapses — bounding half-open unauthenticated
 *       sockets so a stalling peer cannot exhaust FDs / grow the map.
 *   (b) reloadTls ROLLBACK — a rebind with BAD cert material throws (same-port: the old listener
 *       is already stopped) but rolls back to the previous known-good material, so the `wss` plane
 *       stays UP (a TLS handshake still succeeds) instead of being left DOWN with a dangling ref.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MeshServer } from "@plexus/runtime/mesh/tunnel.ts";
import type { HandshakeDriver } from "@plexus/runtime/mesh/handshake.ts";

const BIND_HOST = "127.0.0.1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: BIND_HOST, fetch: () => new Response("x") });
  const p = s.port ?? 0;
  s.stop(true);
  return p;
}

function makeCert(dir: string): { cert: string; key: string } {
  const keyPath = join(dir, "k.pem");
  const certPath = join(dir, "c.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", `/CN=${BIND_HOST}`, "-addext", `subjectAltName=IP:${BIND_HOST}`,
    ],
    { stdio: "ignore" },
  );
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

/** A handshake driver that NEVER completes: it waits for the peer to speak and never reports done/fail. */
function stallingDriver(): HandshakeDriver {
  return {
    open: () => undefined, // primary-style: wait for the peer (nothing sent)
    next: () => ({}), // never `done`, never `fail` — the socket stalls in the handshake phase
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("hardening — handshake-phase reaper (DoS guard)", () => {
  it("(a) a socket that never completes the handshake is closed + removed after the deadline", async () => {
    const deadline = 300;
    const server = new MeshServer({
      // The gate is wired but the driver stalls — every accepted socket sits unauthenticated.
      createHandshake: () => stallingDriver(),
      handshakeDeadlineMs: deadline,
    });
    const { port } = server.start();
    cleanups.push(() => server.stop());

    // A raw client that opens the socket and NEVER speaks — the worst-case half-open.
    let clientClosed = false;
    const ws = new WebSocket(`ws://${BIND_HOST}:${port}`);
    ws.addEventListener("close", () => (clientClosed = true));
    cleanups.push(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

    // Once open, it has entered the unauthenticated handshake set (never promoted to a connection).
    await until(() => server.pendingHandshakeCount === 1);
    expect(server.pendingHandshakeCount).toBe(1);
    expect(server.connected).toBe(false); // it is NOT a promoted, frame-carrying connection

    // The reaper closes it and drops the handshake entry once the deadline (+ one sweep tick) passes.
    await until(() => server.pendingHandshakeCount === 0, 3_000);
    expect(server.pendingHandshakeCount).toBe(0);
    await until(() => clientClosed, 1_000);
    expect(clientClosed).toBe(true); // the stalled socket was actively closed by the primary
    expect(server.connected).toBe(false); // still no promoted connection — the reaper never promotes
  });

  it("(a') the reaper is disabled with handshakeDeadlineMs:0 — a stalled socket lingers", async () => {
    const server = new MeshServer({
      createHandshake: () => stallingDriver(),
      heartbeatTimeoutMs: 200, // idle sweep armed, but it only touches PROMOTED connections
      handshakeDeadlineMs: 0, // reaper OFF
    });
    const { port } = server.start();
    cleanups.push(() => server.stop());

    const ws = new WebSocket(`ws://${BIND_HOST}:${port}`);
    cleanups.push(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

    await until(() => server.pendingHandshakeCount === 1);
    // Well past the idle-sweep period — the unauthenticated socket is NOT reaped (reaper off).
    await sleep(700);
    expect(server.pendingHandshakeCount).toBe(1);
  });
});

describe("hardening — reloadTls rollback on a failed rebind", () => {
  let certDir: string;
  afterEach(() => {
    if (certDir) {
      try {
        rmSync(certDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("(b) a rebind with BAD material throws but rolls back to the previous cert (wss stays UP)", async () => {
    certDir = mkdtempSync(join(tmpdir(), "plexus-reload-rollback-"));
    const good = makeCert(certDir);
    const wssPort = freePort();

    const server = new MeshServer({
      hostname: BIND_HOST,
      port: freePort(),
      wssPort,
      tls: good,
    });
    const started = server.start();
    cleanups.push(() => server.stop());
    expect(started.wssPort).toBe(wssPort);

    // A bad rebind: malformed cert/key makes `Bun.serve` throw synchronously. reloadTls must
    // rethrow loudly (the admin caller sees the failed rotation) AND roll back to the good cert.
    expect(() => server.reloadTls({ cert: "not-a-cert", key: "not-a-key" })).toThrow();

    // ROLLBACK: the wss listener is back on the SAME port (not undefined, no dangling ref) and a
    // real TLS handshake still succeeds with the previous good cert (the channel is genuinely UP).
    expect(server.wssPort).toBe(wssPort);
    const res = await fetch(`https://${BIND_HOST}:${wssPort}`, {
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    expect(res.status).toBe(426); // the listener's non-upgrade response — proves it is serving
    await res.text();

    // SUCCESS PATH unchanged: a rebind with fresh VALID material rebinds on the same port + stays up.
    const fresh = makeCert(certDir);
    const reloaded = server.reloadTls(fresh);
    expect(reloaded).toBe(wssPort);
    expect(server.wssPort).toBe(wssPort);
    const res2 = await fetch(`https://${BIND_HOST}:${wssPort}`, {
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    expect(res2.status).toBe(426);
    await res2.text();
  });
});
