/**
 * Tunnel transport — the framed-RPC multiplexer over a single persistent WebSocket
 * (federated-mesh §7 Q1/Q2, phase-1 plan seam (b) / T4).
 *
 * TRANSPORT PREMISE (mesh §7): a proxy gateway DIALS OUT one long-lived tunnel to
 * its primary (NAT-forced — no inbound hole on the proxy host). Every logical
 * message — enroll, catalog push, invoke forward, invoke result, audit bubble,
 * keepalive — MULTIPLEXES over that one socket. The primary FORWARDS down it; the
 * proxy answers up it. This module is the raw pipe that makes that one socket carry
 * many concurrent request/reply pairs without them crossing.
 *
 *   • `MeshServer` — the PRIMARY side. Listens (`Bun.serve({ websocket })`), holds
 *     the accepted proxy socket, and `forward(frame)`s a request DOWN the tunnel,
 *     resolving when the matching-`corr` reply comes back up.
 *   • `MeshClient` — the PROXY side. Dials a `ws://` URL (Bun's global `WebSocket`),
 *     auto-reconnects with capped backoff, and `request(frame)`s UP the tunnel.
 *
 * CORRELATION is the whole game: each request carries a unique `corr`; the reply
 * with the matching `corr` resolves that one pending promise and no other. Two
 * concurrent in-flight requests with different `corr` never cross. Every request
 * has a timeout so a lost reply fails cleanly instead of hanging forever.
 *
 * AUTH GATE (T12): the mux itself stays identity-agnostic, but a connection can be
 * fronted by an OPTIONAL Ed25519 connection-auth handshake (`createHandshake`). When
 * set, a freshly-opened socket is UNAUTHENTICATED: its raw messages are fed to the
 * `HandshakeDriver` (NOT the mux), and it is promoted to carry `Frame`s only once the
 * driver reports `done`. Until then `forward()`/`request()` will not run on it and no
 * `invoke`/`audit`/`catalog` frame is honored — fail-closed (federated-mesh §7 Q2). A
 * server/client constructed WITHOUT `createHandshake` is the original raw transport
 * (used by the pure-mux unit tests); the mesh runtime always wires the gate.
 * FAN-OUT (A3): `MeshServer` holds MANY concurrent proxy connections keyed by the
 * authenticated WORKLOAD — one socket + one `FrameMux` per workload (the mux's single
 * send slot cannot fan out across sockets, so each socket owns its own mux). A
 * `forward(workload, frame)` routes DOWN exactly that workload's tunnel; a frame can
 * never cross to another workload's socket (L-2). Per-connection workload identity is
 * threaded into the inbound request handler so the catalog/audit ascent knows WHICH
 * proxy a frame arrived on. The raw (no-gate) unit-test path registers its sole socket
 * under an `undefined` workload — it carries frames but is never a forward target.
 */

import type { Frame, HealthFramePayload, NegotiatedHealthReporting } from "@plexus/protocol";
import type { ServerWebSocket, TLSOptions } from "bun";

import { decodeFrame, decodeText, encodeFrame, newCorr, withCorr, type RawMessage } from "./frames.ts";
import type { HandshakeDriver } from "./handshake.ts";

/** The health-report body a proxy's `buildHealthReport` supplies; the client stamps seq/ts/reporter. */
export type HealthReportBody = Pick<HealthFramePayload, "overall" | "sources">;

/** Default per-request deadline before a missing reply rejects (ms). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Reconnect backoff: first retry delay and the cap it doubles toward (ms). */
const DEFAULT_BACKOFF_INITIAL_MS = 50;
const DEFAULT_BACKOFF_MAX_MS = 2_000;
/** Heartbeat (proxy → primary keepalive): interval between pings + per-ping deadline (ms). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
/**
 * Handshake-phase deadline (DoS guard): how long an accepted-but-UNAUTHENTICATED socket may
 * linger in `handshakes` before the sweep reaps it. A socket that opens and stalls mid-handshake
 * (or never sends a frame) is never promoted, so without this it would live forever and an
 * attacker could hold many half-open sockets to exhaust FDs / grow the map (networking-resilience §2).
 */
const DEFAULT_HANDSHAKE_DEADLINE_MS = 10_000;

/**
 * The PROXY tunnel's connection state (networking-resilience §3). Surfaced so the
 * runtime/admin can render a proxy as connected / reconnecting / down:
 *  - `connecting`      — dialing (initial or after a backoff wait).
 *  - `authenticating`  — socket open, Ed25519 handshake running (skipped on the raw path).
 *  - `connected`       — authenticated + ready; frames flow; heartbeat armed; backoff reset.
 *  - `reconnecting`    — dropped, waiting out the (jittered) backoff before the next dial.
 *  - `closed`          — permanently closed (`close()`); no further reconnect.
 */
export type MeshConnectionState =
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "closed";

/** A reply frame for a request — same `Frame` union, paired by `corr`. */
export type ResponseFrame = Frame;

/**
 * Handle an inbound request frame arriving on the tunnel and return the reply
 * frame to send back. The mux stamps the reply with the request's `corr`, so a
 * handler need not echo it. Throwing (or never returning) leaves the peer to time
 * out — there is no error frame at this raw layer.
 */
export type RequestHandler = (frame: Frame) => Frame | Promise<Frame>;

/**
 * The PRIMARY's inbound-request handler under fan-out (A3). Same as `RequestHandler`
 * but also told the authenticated WORKLOAD the frame arrived on — so the catalog/audit
 * ascent attributes a frame to the SOCKET it came in on (never a forged payload field).
 * `workload` is `undefined` only on the raw (no-gate) unit-test transport. A plain
 * `(frame) => Frame` is assignable here (the workload arg is simply ignored).
 */
export type ServerRequestHandler = (
  frame: Frame,
  workload: string | undefined,
) => Frame | Promise<Frame>;

/** Raised when a request's reply does not arrive within its deadline. */
export class MeshTimeoutError extends Error {
  constructor(
    readonly corr: string,
    readonly timeoutMs: number,
  ) {
    super(`mesh: request ${corr} timed out after ${timeoutMs}ms`);
    this.name = "MeshTimeoutError";
  }
}

/** Raised when a request cannot be sent / is abandoned because the tunnel is down. */
export class MeshDisconnectedError extends Error {
  constructor(message = "mesh: tunnel connection lost") {
    super(message);
    this.name = "MeshDisconnectedError";
  }
}

type SendFn = (data: string) => void;

interface PendingRequest {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A function that sends nothing — the send slot while no socket is attached. */
const NO_SEND: SendFn = () => {
  throw new MeshDisconnectedError("mesh: no active tunnel connection");
};

/**
 * The transport-agnostic correlation engine shared by both ends. It owns the
 * pending-request map keyed by `corr`, dispatches inbound frames (reply → resolve
 * the waiter; otherwise → the request handler), and enforces per-request timeouts.
 * It does NOT own the socket lifecycle — the server/client wrappers (re)bind its
 * `send` slot as connections come and go.
 */
export class FrameMux {
  private readonly pending = new Map<string, PendingRequest>();
  private send: SendFn;
  private onRequest?: RequestHandler;

  constructor(send: SendFn = NO_SEND, onRequest?: RequestHandler) {
    this.send = send;
    this.onRequest = onRequest;
  }

  /** (Re)bind the outbound send slot — called when a socket attaches/detaches. */
  setSend(send: SendFn): void {
    this.send = send;
  }

  /** Register the handler for inbound (un-correlated) request frames. */
  setRequestHandler(handler: RequestHandler | undefined): void {
    this.onRequest = handler;
  }

  /** Number of in-flight requests (diagnostics / tests). */
  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * Send `frame` as a request and resolve with the reply that carries the matching
   * `corr`. The frame's own `corr` is the correlation key — it must be unique among
   * in-flight requests (reusing a live `corr` rejects rather than silently crossing
   * wires). A `timeoutMs` deadline guarantees a clean failure if no reply arrives.
   */
  request(frame: Frame, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Frame> {
    const corr = frame.corr;
    if (this.pending.has(corr)) {
      return Promise.reject(new Error(`mesh: duplicate in-flight corr ${corr}`));
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(corr);
        reject(new MeshTimeoutError(corr, timeoutMs));
      }, timeoutMs);
      this.pending.set(corr, { resolve, reject, timer });
      try {
        this.send(encodeFrame(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(corr);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Route one inbound socket payload. A frame whose `corr` matches a pending
   * request RESOLVES that waiter (and only it). Any other frame is an inbound
   * REQUEST handed to the request handler; its return value is sent back stamped
   * with the request's `corr`. Malformed payloads are dropped, never thrown.
   */
  async dispatch(raw: RawMessage): Promise<void> {
    let frame: Frame;
    try {
      frame = decodeFrame(raw);
    } catch {
      return; // garbage on the wire can never wedge the mux
    }

    const waiter = this.pending.get(frame.corr);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(frame.corr);
      waiter.resolve(frame);
      return;
    }

    if (!this.onRequest) return; // no handler — peer will time out
    let reply: Frame;
    try {
      reply = await this.onRequest(frame);
    } catch {
      return; // handler failure — no reply frame at this raw layer
    }
    try {
      this.send(encodeFrame(withCorr(reply, frame.corr)));
    } catch {
      /* socket vanished mid-reply — peer times out */
    }
  }

  /** Reject every in-flight request with `err` and clear the map (on disconnect/close). */
  rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

// ── Primary side ──────────────────────────────────────────────────────────────

/** Options for the primary-side tunnel acceptor. */
export interface MeshServerOptions {
  /** Plain-`ws` port to bind. `0` (default) selects an ephemeral free port. */
  port?: number;
  /** Interface to bind. Loopback by default (the mesh trust boundary is the tunnel). */
  hostname?: string;
  /**
   * CROSS-HOST SPINE (B7 / P4-0): when `wssPort` + `tls` are BOTH set, the server binds a
   * SECOND listener — a `Bun.serve({ tls })` `wss` acceptor — ALONGSIDE the plain `ws` one.
   * BOTH listeners share ONE connection model (the same `connections`/`byWorkload`/`handshakes`
   * maps), so a proxy that dialed `wss://` and one that dialed `ws://` enroll/forward/audit
   * through the identical fan-out path (A3). Identity ⟂ encryption (mesh §7 Q2): the Ed25519
   * handshake authenticates either way; `wss` only adds confidentiality underneath.
   */
  wssPort?: number;
  /** TLS material for the optional `wss` listener (required iff `wssPort` is set). */
  tls?: TLSOptions;
  /** Per-`forward()` deadline (ms). */
  requestTimeoutMs?: number;
  /**
   * Handler for requests the proxy sends UP the tunnel (e.g. enroll/catalog/audit). Under
   * fan-out (A3) it is also handed the authenticated WORKLOAD the frame arrived on, so the
   * primary attributes a catalog/audit ascent to the originating socket (never a payload
   * field). A legacy `(frame) => Frame` handler stays assignable (the arg is ignored).
   */
  onRequest?: ServerRequestHandler;
  /**
   * OPTIONAL connection-auth gate (T12). When provided, every accepted socket must
   * complete the Ed25519 mutual-auth handshake (driven by a fresh driver per
   * connection) BEFORE it becomes the active frame-carrying socket. Absent ⇒ the raw,
   * unauthenticated transport (pure-mux unit tests only).
   *
   * The per-connection `encrypted` flag tells the driver WHICH listener accepted the socket
   * (true on the `wss` acceptor, false on the plain `ws` one) so the mandatory-encryption
   * policy (B7) can refuse a plain channel at the handshake. Identity ⟂ encryption (mesh §7 Q2).
   */
  createHandshake?: (ctx: { encrypted: boolean }) => HandshakeDriver;
  /**
   * PRIMARY-SIDE IDLE TEARDOWN (heartbeat, opt-in). When set, a periodic sweep tears down any
   * connection that has sent NO frame within `heartbeatTimeoutMs` (a half-open socket the proxy's
   * keepalive can no longer reach), firing `onDisconnect` so the ResolutionTable stamps the
   * workload unavailable promptly (Invariant E) even with no forward in flight. The proxy's
   * heartbeat pings keep a live tunnel's `lastSeen` fresh. Absent ⇒ no sweep (back-compat).
   */
  heartbeatTimeoutMs?: number;
  /**
   * HANDSHAKE-PHASE DEADLINE (DoS guard). Maximum time an accepted socket may sit
   * UNAUTHENTICATED in `handshakes` before the sweep closes it and drops the entry — bounding
   * half-open, never-promoted sockets so a peer cannot stall mid-handshake (or never speak) to
   * exhaust FDs / grow the map. Only meaningful when `createHandshake` is set (the raw no-gate
   * path never populates `handshakes`). Default `DEFAULT_HANDSHAKE_DEADLINE_MS` (~10s); `0`
   * disables the reaper. Already-promoted `connections` are untouched (governed by the heartbeat).
   */
  handshakeDeadlineMs?: number;
  /**
   * RESOLUTION HEALTH HOOKS (T10). Fired as the active socket comes and goes so the
   * primary's `ResolutionTable` can mark a workload's mounted caps available/unavailable:
   *  - `onConnect(workload, negotiatedHealth?)`  — an authenticated socket was PROMOTED (the
   *    "connect" signal). `negotiatedHealth` carries the mutually-agreed health-reporting params
   *    (mesh-health-reporting.md §2) when BOTH peers advertised, else `undefined` (bare heartbeat).
   *  - `onDisconnect(workload)` — the active socket DROPPED / closed / was torn down.
   * `workload` is the identity bound at handshake; `undefined` for the raw (no-gate) path.
   */
  onConnect?: (workload: string | undefined, negotiatedHealth?: NegotiatedHealthReporting) => void;
  onDisconnect?: (workload: string | undefined) => void;
}

/**
 * The PRIMARY side of the tunnel. Accepts a single proxy WebSocket via
 * `Bun.serve({ websocket })`, holds it, and forwards already-authorized requests
 * down it. Mirrors the `runtime/listen.ts` `Bun.serve` pattern but stands alone for
 * now (the supervised HTTP runtime and the mesh acceptor are separate listeners at
 * this stage).
 */
/**
 * One promoted (frame-carrying) proxy connection: its socket, the per-socket mux that
 * owns that socket's send slot + pending-request map, and the authenticated workload it
 * is bound to (`undefined` only on the raw no-gate transport). One per workload — a
 * second workload gets its OWN entry, so their frames can never share a mux (L-2).
 */
interface MeshConnection {
  ws: ServerWebSocket<unknown>;
  mux: FrameMux;
  workload: string | undefined;
  /** Epoch-ms of the last inbound frame (heartbeat idle-teardown clock). */
  lastSeen: number;
  /** The negotiated health-reporting params for this connection (mesh-health-reporting.md §2). */
  healthReporting?: NegotiatedHealthReporting;
}

/**
 * An accepted-but-UNAUTHENTICATED socket still running its connection-auth handshake (T12).
 * `openedAt` is the handshake-phase deadline clock: a driver that never reports `done` within
 * `handshakeDeadlineMs` is reaped by the sweep (DoS guard — no half-open socket lives forever).
 */
interface PendingHandshake {
  driver: HandshakeDriver;
  /** Epoch-ms the socket entered the handshake phase (the reaper deadline clock). */
  openedAt: number;
}

export class MeshServer {
  private readonly timeoutMs: number;
  /** The plain-`ws` listener (always bound). Back-compat: `port`/`stop()` key off this one. */
  private server?: ReturnType<typeof Bun.serve>;
  /** The optional `wss` (TLS) listener bound alongside `server` when configured (B7). */
  private tlsServer?: ReturnType<typeof Bun.serve>;
  /** Promoted connections keyed by socket (the authoritative set — covers the raw path too). */
  private readonly connections = new Map<ServerWebSocket<unknown>, MeshConnection>();
  /** Reverse index: authenticated workload → its socket (the forward-routing table, L-2). */
  private readonly byWorkload = new Map<string, ServerWebSocket<unknown>>();
  /** Per-connection auth handshakes in flight (T12) — keyed by the unauthenticated socket. */
  private readonly handshakes = new Map<ServerWebSocket<unknown>, PendingHandshake>();
  /** The current inbound-request handler applied to every (new) per-socket mux. */
  private serverHandler?: ServerRequestHandler;
  /**
   * The sweep timer. Runs when EITHER the heartbeat idle-teardown (`heartbeatTimeoutMs`) OR the
   * handshake-phase reaper (`createHandshake` + `handshakeDeadlineMs`) is active; one interval
   * reaps both stale promoted connections and stalled mid-handshake sockets.
   */
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** Live TLS material for the `wss` listener (mutated by `reloadTls()` so a rebind picks it up). */
  private currentTls?: TLSOptions;
  /** Handshake-phase deadline (DoS guard) — a stalled unauthenticated socket is reaped after this. */
  private readonly handshakeDeadlineMs: number;

  constructor(private readonly opts: MeshServerOptions = {}) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.serverHandler = opts.onRequest;
    this.currentTls = opts.tls;
    this.handshakeDeadlineMs = opts.handshakeDeadlineMs ?? DEFAULT_HANDSHAKE_DEADLINE_MS;
  }

  /** Number of accepted-but-unauthenticated sockets still in the handshake phase (diagnostics/tests). */
  get pendingHandshakeCount(): number {
    return this.handshakes.size;
  }

  /** Build a per-socket mux whose request handler is bound to that socket's `workload`. */
  private makeMux(ws: ServerWebSocket<unknown>, workload: string | undefined): FrameMux {
    const handler: RequestHandler | undefined = this.serverHandler
      ? (frame) => this.serverHandler!(frame, workload)
      : undefined;
    return new FrameMux((data) => ws.send(data), handler);
  }

  /** Register a promoted socket as a frame-carrying connection (auth path or raw path). */
  private register(
    ws: ServerWebSocket<unknown>,
    workload: string | undefined,
    healthReporting?: NegotiatedHealthReporting,
  ): void {
    // Evict any prior connection for the SAME workload (a reconnect that raced the old
    // socket's close): the freshest socket wins; the stale one's in-flight forwards reject.
    if (workload !== undefined) {
      const prior = this.byWorkload.get(workload);
      if (prior && prior !== ws) this.teardown(prior, /*fireDown*/ false);
    }
    const mux = this.makeMux(ws, workload);
    this.connections.set(ws, { ws, mux, workload, lastSeen: Date.now(), ...(healthReporting ? { healthReporting } : {}) });
    if (workload !== undefined) this.byWorkload.set(workload, ws);
  }

  /** Tear a connection down: reject its in-flight forwards, drop it from both indexes. */
  private teardown(ws: ServerWebSocket<unknown>, fireDown: boolean): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    this.connections.delete(ws);
    if (conn.workload !== undefined && this.byWorkload.get(conn.workload) === ws) {
      this.byWorkload.delete(conn.workload);
    }
    conn.mux.rejectAll(new MeshDisconnectedError());
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    if (fireDown) this.opts.onDisconnect?.(conn.workload);
  }

  /**
   * Start listening; returns the actually-bound port(s). Idempotent-ish (call once).
   *
   * Always binds the plain-`ws` listener (back-compat: a no-tls config is byte-for-byte
   * today's single ephemeral loopback acceptor). When `wssPort` + `tls` are configured (B7),
   * ALSO binds a `wss` listener — both share the SAME `fetch`/`websocket` handler closures, so
   * they register into ONE connection model (A3 fan-out): a frame can arrive on either listener
   * and route identically. `wssPort` is the actually-bound TLS port (after start), if any.
   */
  start(): { port: number; wssPort?: number } {
    const hostname = this.opts.hostname ?? "127.0.0.1";
    // The plain-`ws` listener is the UNENCRYPTED channel (encrypted:false threaded into its
    // handshakes); the `wss` listener is the ENCRYPTED one (encrypted:true). Both share the same
    // connection model — only the per-connection `encrypted` flag differs (B7 / mesh §7 Q2).
    this.server = Bun.serve({ port: this.opts.port ?? 0, hostname, ...this.buildHandlers(false) });
    if (this.currentTls && this.opts.wssPort !== undefined) {
      this.tlsServer = Bun.serve({
        port: this.opts.wssPort,
        hostname,
        tls: this.currentTls,
        ...this.buildHandlers(true),
      });
    }
    this.startSweep();
    return {
      port: this.server.port ?? 0,
      ...(this.tlsServer ? { wssPort: this.tlsServer.port ?? 0 } : {}),
    };
  }

  /**
   * CERT RELOAD (encryption-policy §2.1) — rebind ONLY the `wss` listener with fresh TLS material,
   * WITHOUT bouncing the plain-`ws` listener, the connection model, or the HTTP plane. Bun takes
   * its TLS at `Bun.serve` construction (no live in-place cert swap), so this is a
   * stop-the-wss-listener + re-serve it on the SAME port with the new cert. Open `wss` tunnels
   * drop and auto-reconnect (networking-resilience) onto the fresh cert; the Ed25519 identity is
   * untouched so they re-authenticate with no re-enrollment. A no-op when no `wss` listener was
   * configured. Returns the (unchanged) bound `wss` port, or `undefined`.
   */
  reloadTls(tls: TLSOptions): number | undefined {
    if (this.opts.wssPort === undefined) {
      // No wss channel to reload — remember the material for a future start, but nothing rebinds.
      this.currentTls = tls;
      return undefined;
    }
    const hostname = this.opts.hostname ?? "127.0.0.1";
    const port = this.tlsServer?.port ?? this.opts.wssPort;
    const previousTls = this.currentTls; // the known-good material to roll back to on failure.
    // Same-port means we CANNOT hold two listeners at once: stop the old wss listener, then
    // re-serve on the SAME port with the new cert. `stop(true)` closes its in-flight sockets —
    // they auto-reconnect (re-handshake, no re-enroll) onto the fresh cert. The plain-`ws`
    // listener + the shared connection model are untouched.
    try {
      this.tlsServer?.stop(true);
    } catch {
      /* best-effort */
    }
    try {
      this.tlsServer = Bun.serve({ port, hostname, tls, ...this.buildHandlers(true) });
      this.currentTls = tls; // commit the new material ONLY on a successful rebind.
      return this.tlsServer.port ?? port;
    } catch (err) {
      // The new material failed to bind (bad cert/key, port not yet reusable) and the old
      // listener is already stopped. Roll back: re-serve with the previous known-good material so
      // the wss plane comes back UP rather than being left DOWN with a dangling stopped reference.
      try {
        if (previousTls === undefined) throw err; // nothing good to roll back to.
        this.tlsServer = Bun.serve({ port, hostname, tls: previousTls, ...this.buildHandlers(true) });
        this.currentTls = previousTls; // stay on the old (still-good) cert; the reload did NOT apply.
      } catch {
        // Rollback also failed — leave a consistent DOWN state (no dangling stopped ref).
        this.tlsServer = undefined;
      }
      // Either way the requested reload did NOT take effect — rethrow loudly so the admin sees it.
      throw err;
    }
  }

  /**
   * Arm the sweep when configured; clears any prior timer. ONE interval reaps two things:
   *  - HEARTBEAT idle-teardown — a promoted `connections` socket silent past `heartbeatTimeoutMs`
   *    (half-open) is torn down (fires `onDisconnect`).
   *  - HANDSHAKE reaper (DoS guard) — an UNAUTHENTICATED `handshakes` socket that has not been
   *    promoted within `handshakeDeadlineMs` is closed + dropped, so a stalled/never-speaking peer
   *    cannot accumulate half-open sockets. Only the gated path (`createHandshake`) populates
   *    `handshakes`, so the reaper is armed only then.
   */
  private startSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const idleTimeout = this.opts.heartbeatTimeoutMs;
    const reapIdle = idleTimeout !== undefined && idleTimeout > 0;
    // The handshake reaper only matters when the auth gate is wired (raw path never half-opens).
    const reapHandshakes = this.opts.createHandshake !== undefined && this.handshakeDeadlineMs > 0;
    if (!reapIdle && !reapHandshakes) return;
    // Sweep at ~half the SHORTER active deadline so either kind of stale socket is caught
    // within ~1.5× its deadline (floored at 1s so the timer never spins hot).
    const clocks: number[] = [];
    if (reapIdle) clocks.push(idleTimeout!);
    if (reapHandshakes) clocks.push(this.handshakeDeadlineMs);
    const period = Math.max(1_000, Math.floor(Math.min(...clocks) / 2));
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      if (reapIdle) {
        for (const conn of [...this.connections.values()]) {
          if (now - conn.lastSeen > idleTimeout!) this.teardown(conn.ws, /*fireDown*/ true);
        }
      }
      if (reapHandshakes) {
        for (const [ws, hs] of [...this.handshakes.entries()]) {
          if (now - hs.openedAt > this.handshakeDeadlineMs) {
            // Never promoted — just close + drop it. No `connections` entry, no `onDisconnect`.
            this.handshakes.delete(ws);
            try {
              ws.close();
            } catch {
              /* already gone */
            }
          }
        }
      }
    }, period);
    // Don't let the sweep timer keep the process alive (Bun/Node `unref`).
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  /**
   * The shared `Bun.serve` handler closures (`fetch` + `websocket`) bound to THIS server's
   * connection model. Built once and spread into BOTH the `ws` and `wss` `Bun.serve` calls so a
   * socket accepted on either listener drives the identical handshake/enroll/forward/audit path.
   */
  private buildHandlers(encrypted: boolean) {
    const self = this;
    return {
      fetch(req: Request, server: import("bun").Server<unknown>): Response | undefined {
        // The only thing this listener does is upgrade to the tunnel socket.
        if (server.upgrade(req, { data: undefined })) return undefined;
        return new Response("expected websocket upgrade", { status: 426 });
      },
      websocket: {
        open(ws: ServerWebSocket<unknown>) {
          if (self.opts.createHandshake) {
            // T12 — UNAUTHENTICATED until the handshake completes. Do NOT make this a
            // frame-carrying connection yet; route its raw messages to the driver. The
            // per-listener `encrypted` flag is threaded so the policy gate (B7) can refuse a
            // plain channel at the handshake.
            const driver = self.opts.createHandshake({ encrypted });
            // Stamp the handshake-phase deadline clock (DoS guard): if this socket is not
            // PROMOTED within `handshakeDeadlineMs`, the sweep reaps it from `handshakes`.
            self.handshakes.set(ws, { driver, openedAt: Date.now() });
            const first = driver.open();
            if (first !== undefined) {
              try {
                ws.send(first);
              } catch {
                /* socket vanished before the opening frame — it will simply never auth */
              }
            }
            return;
          }
          // Raw (no-gate) transport: the socket carries frames immediately, under no
          // workload (it is never a forward target — only the proxy→primary request path).
          self.register(ws, undefined);
        },
        message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
          // ── T12 auth phase: feed handshake messages to the driver, never the mux ──
          const pending = self.handshakes.get(ws);
          if (pending) {
            const step = pending.driver.next(decodeText(message as RawMessage));
            if (step.send !== undefined) {
              try {
                ws.send(step.send);
              } catch {
                /* best-effort — a vanished socket simply fails to authenticate */
              }
            }
            if (step.fail !== undefined) {
              // Fail-closed: an unauthenticated socket is dropped. It never carries a frame.
              self.handshakes.delete(ws);
              try {
                ws.close();
              } catch {
                /* already gone */
              }
              return;
            }
            if (step.done) {
              // PROMOTE: this socket is now an authenticated, frame-carrying connection for
              // `step.workload`. This promotion IS the per-workload "connect" signal the
              // ResolutionTable keys on (T10): that workload's mounted caps become reachable
              // the instant its socket is live — independently of every other workload.
              self.handshakes.delete(ws);
              self.register(ws, step.workload, step.healthReporting);
              self.opts.onConnect?.(step.workload, step.healthReporting);
            }
            return;
          }
          // ── Authenticated path. ONLY a promoted (registered) socket may drive its mux;
          //    a frame on a non-promoted socket under the gate is refused (fail-closed). ──
          const conn = self.connections.get(ws);
          if (conn) {
            conn.lastSeen = Date.now(); // heartbeat clock — a live frame keeps the socket fresh.
            void conn.mux.dispatch(message as RawMessage);
            return;
          }
          if (self.opts.createHandshake) {
            try {
              ws.close();
            } catch {
              /* already gone */
            }
          }
        },
        close(ws: ServerWebSocket<unknown>) {
          self.handshakes.delete(ws);
          // The socket dropped — the per-workload "down" signal for the ResolutionTable
          // (T10): THIS workload's home is unreachable until it re-enrolls; every OTHER
          // workload's connection is untouched.
          self.teardown(ws, /*fireDown*/ true);
        },
      },
    };
  }

  /** The bound plain-`ws` port (after `start()`), or `0` if not listening. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /** The bound `wss` (TLS) port (after `start()`), or `undefined` when no TLS listener is configured. */
  get wssPort(): number | undefined {
    return this.tlsServer?.port;
  }

  /**
   * Whether ANY authenticated proxy tunnel is currently attached (back-compat: the
   * single-proxy callers ask "is a proxy connected at all"). Per-workload reachability is
   * `isConnected(workload)`.
   */
  get connected(): boolean {
    return this.connections.size > 0;
  }

  /** Whether `workload`'s authenticated socket is currently promoted (per-workload health). */
  isConnected(workload: string): boolean {
    return this.byWorkload.has(workload);
  }

  /** The authenticated workload bound to a specific socket, if it is a promoted connection. */
  authenticatedWorkloadFor(ws: ServerWebSocket<unknown>): string | undefined {
    return this.connections.get(ws)?.workload;
  }

  /**
   * Back-compat: the sole authenticated workload when EXACTLY ONE proxy is attached, else
   * `undefined` (ambiguous under fan-out). Prefer the per-connection workload threaded into
   * `onRequest`; this getter survives only for single-proxy callers/tests.
   */
  get authenticatedWorkload(): string | undefined {
    if (this.byWorkload.size !== 1) return undefined;
    return this.byWorkload.keys().next().value;
  }

  /** (Re)set the inbound-request handler; applied to every current + future per-socket mux. */
  setRequestHandler(handler: ServerRequestHandler | undefined): void {
    this.serverHandler = handler;
    for (const conn of this.connections.values()) {
      const wl = conn.workload;
      conn.mux.setRequestHandler(handler ? (frame) => handler(frame, wl) : undefined);
    }
  }

  /**
   * Forward a request DOWN `workload`'s tunnel and resolve with the matching-`corr` reply.
   * Routes to EXACTLY that workload's socket (L-2 — a frame can never cross to another
   * workload's tunnel). Rejects immediately if that workload has no promoted connection.
   */
  forward(workload: string, frame: Frame, timeoutMs: number = this.timeoutMs): Promise<ResponseFrame> {
    const ws = this.byWorkload.get(workload);
    const conn = ws ? this.connections.get(ws) : undefined;
    if (!conn) {
      return Promise.reject(new MeshDisconnectedError(`mesh: no proxy attached for workload '${workload}'`));
    }
    return conn.mux.request(frame, timeoutMs);
  }

  /**
   * REVOCATION (B6): force-drop EXACTLY `workload`'s authenticated socket (A3's per-workload
   * `byWorkload` map), rejecting its in-flight forwards. The server stays listening and every
   * OTHER workload's tunnel is untouched (per-workload, not all-connections). A no-op when that
   * workload has no promoted connection. `onDisconnect` is NOT fired here — the revoke
   * orchestrator stamps the ResolutionTable itself (a revoked home is unavailable, terminally).
   */
  dropConnection(workload: string): void {
    const ws = this.byWorkload.get(workload);
    if (ws) this.teardown(ws, /*fireDown*/ false);
  }

  /** Force-close every attached proxy socket (the server stays listening). Test/blip hook. */
  dropActiveConnection(): void {
    for (const ws of [...this.connections.keys()]) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** Stop listening and reject every in-flight forward across all connections. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    // Every attached socket is a "down" signal too (T10) — mark each workload unavailable so
    // a lingering ResolutionTable read after stop() never reports a stale "ok".
    for (const ws of [...this.connections.keys()]) {
      this.teardown(ws, /*fireDown*/ true);
    }
    this.handshakes.clear();
    try {
      this.server?.stop(true);
    } catch {
      /* best-effort */
    }
    try {
      this.tlsServer?.stop(true);
    } catch {
      /* best-effort */
    }
    this.server = undefined;
    this.tlsServer = undefined;
  }
}

// ── Proxy side ────────────────────────────────────────────────────────────────

/** Options for the proxy-side tunnel dialer. */
export interface MeshClientOptions {
  /** The `ws://`/`wss://` URL of the primary's tunnel listener. */
  url: string;
  /**
   * TLS trust for a `wss://` upstream (B7). Forwarded to Bun's `WebSocket` as its per-connection
   * `tls` option — e.g. `{ ca: <pem> }` to trust a self-signed primary cert, or
   * `{ rejectUnauthorized: false }` for a dev relaxation. PER-CONNECTION, never global (no
   * `NODE_TLS_REJECT_UNAUTHORIZED`). Ignored for a plain `ws://` upstream. Absent ⇒ Bun's default
   * verification (a self-signed primary cert then fails the TLS handshake — fail-closed).
   */
  tls?: TLSOptions;
  /** Per-`request()` deadline (ms). */
  requestTimeoutMs?: number;
  /** First reconnect delay (ms); doubles each failed attempt up to the cap. */
  backoffInitialMs?: number;
  /** Reconnect backoff cap (ms). */
  backoffMaxMs?: number;
  /**
   * Apply equal-jitter to the scheduled reconnect delay (`actual = delay/2 + rand(0, delay/2)`),
   * de-correlating a fleet that all lost the primary at once (networking-resilience §1). The
   * doubling sequence stays deterministic so the cap still bounds it. Default `true`; set `false`
   * for deterministic tests.
   */
  backoffJitter?: boolean;
  /** Auto-reconnect after an unexpected drop. Default `true`. */
  autoReconnect?: boolean;
  /**
   * HEARTBEAT (networking-resilience §2): proxy → primary `ping` every `heartbeatIntervalMs`
   * (default 15s) with a `heartbeatTimeoutMs` (default 5s) per-ping deadline. A missed pong
   * (half-open socket) forces a reconnect. Set `heartbeatIntervalMs:0` to disable.
   */
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** Observe connection-state transitions (networking-resilience §3). */
  onStateChange?: (state: MeshConnectionState) => void;
  /**
   * TEST/DIAGNOSTIC seam: fired each time a backoff reconnect is scheduled, with the 1-based
   * attempt count + the (jittered) delay — lets a test assert the backoff stays bounded by the cap.
   */
  onReconnectScheduled?: (info: { attempt: number; delayMs: number }) => void;
  /** Handler for requests the primary forwards DOWN the tunnel (e.g. invoke). */
  onRequest?: RequestHandler;
  /**
   * OPTIONAL connection-auth gate (T12). When provided, the client runs the Ed25519
   * mutual-auth handshake on every (re)connect BEFORE the socket is marked ready — so a
   * `request()` waits for an AUTHENTICATED tunnel, and an unauthenticated socket never
   * sends a frame. A fresh driver is built per connection (so a reconnect re-auths).
   */
  createHandshake?: () => HandshakeDriver;
  /**
   * AUTH-COMPLETE hook (A2 — live catalog ascent). Fired every time the connection-auth
   * handshake reports `done`, i.e. on EVERY (re)connect — including a challenge-only
   * reconnect where no enroll leg runs. The proxy's catalog (re)push hangs off this: a
   * catalog must be re-advertised on every freshly-authenticated socket so the primary's
   * directory is rebuilt after any reconnect. DISTINCT from the handshake's `onEnrolled`
   * (which fires only on the one-time enroll leg, never on a plain reconnect).
   */
  onAuthenticated?: () => void;
  /**
   * HEALTH REPORTING (mesh-health-reporting.md §4). When health reporting is NEGOTIATED on the
   * connection (surfaced by the handshake `done` step), the liveness loop sends a `health` frame
   * built by this callback INSTEAD of a bare `ping` — the frame doubles as the liveness signal
   * (no second timer). Absent, or negotiation off ⇒ the bare `ping` heartbeat is used. The client
   * stamps `reporter`/`seq`/`ts`; the callback supplies only `{ overall, sources }`. Returning
   * `undefined` falls back to a `ping` for that tick.
   */
  buildHealthReport?: () => Promise<HealthReportBody | undefined> | HealthReportBody | undefined;
  /** The advisory `reporter` label stamped on outbound health frames (the proxy's workload). */
  healthReporter?: string;
  /** Observe the negotiated health-reporting params on each authenticated (re)connect. */
  onHealthNegotiated?: (negotiated: NegotiatedHealthReporting | undefined) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const d: Partial<Deferred<T>> = { settled: false };
  d.promise = new Promise<T>((res, rej) => {
    resolve = (v) => {
      d.settled = true;
      res(v);
    };
    reject = (e) => {
      d.settled = true;
      rej(e);
    };
  });
  d.resolve = resolve;
  d.reject = reject;
  return d as Deferred<T>;
}

/**
 * The PROXY side of the tunnel. Dials the primary, auto-reconnects with capped
 * exponential backoff after a drop, and multiplexes correlated requests up the
 * socket. A `request()` waits for the socket to be ready (so a call mid-reconnect
 * lands on the fresh connection) and then awaits its matching-`corr` reply.
 */
export class MeshClient {
  private readonly mux: FrameMux;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly backoffJitter: boolean;
  private readonly autoReconnect: boolean;
  private readonly createHandshake?: () => HandshakeDriver;
  private readonly onAuthenticated?: () => void;
  private readonly onStateChange?: (state: MeshConnectionState) => void;
  private readonly onReconnectScheduled?: (info: { attempt: number; delayMs: number }) => void;
  private readonly tls?: TLSOptions;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly buildHealthReport?: () => Promise<HealthReportBody | undefined> | HealthReportBody | undefined;
  private readonly healthReporter?: string;
  private readonly onHealthNegotiated?: (negotiated: NegotiatedHealthReporting | undefined) => void;
  /** The negotiated health-reporting params for the CURRENT connection (set on handshake `done`). */
  private negotiatedHealth?: NegotiatedHealthReporting;
  /** Monotonic sequence for outbound health frames (mesh-health-reporting.md §3). */
  private healthSeq = 0;

  private ws?: WebSocket;
  private backoffMs: number;
  /** 1-based count of reconnect attempts since the last `connected` (reset on ready). */
  private reconnectAttempt = 0;
  private ready: Deferred<void>;
  private closed = false;
  private downHandled = false;
  private state: MeshConnectionState = "connecting";
  /** The in-flight connection-auth handshake (T12); cleared once authenticated/torn down. */
  private handshakeDriver?: HandshakeDriver;
  /** The heartbeat ping timer (armed on `connected`, cleared on down/close). */
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(opts: MeshClientOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.backoffInitialMs = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.backoffJitter = opts.backoffJitter ?? true;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.createHandshake = opts.createHandshake;
    this.onAuthenticated = opts.onAuthenticated;
    this.onStateChange = opts.onStateChange;
    this.onReconnectScheduled = opts.onReconnectScheduled;
    this.tls = opts.tls;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.buildHealthReport = opts.buildHealthReport;
    this.healthReporter = opts.healthReporter;
    this.onHealthNegotiated = opts.onHealthNegotiated;
    this.backoffMs = this.backoffInitialMs;
    this.mux = new FrameMux(NO_SEND, opts.onRequest);
    this.ready = deferred<void>();
    this.connect();
  }

  /** Transition the connection state and notify any observer (idempotent on no-change). */
  private setState(next: MeshConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    try {
      this.onStateChange?.(next);
    } catch {
      /* an observer must never wedge the tunnel */
    }
  }

  /** The current connection state (networking-resilience §3). */
  get connectionState(): MeshConnectionState {
    return this.state;
  }

  /** (Re)dial the primary and wire socket events into the mux + readiness gate. */
  private connect(): void {
    if (this.closed) return;
    this.downHandled = false;
    this.setState("connecting");
    // Bun's `WebSocket` honors a per-connection `tls` option (B7) — a `wss://` upstream with a
    // self-signed primary cert is trusted via `tls.ca`, scoped to THIS socket (never global). The
    // DOM lib's constructor type only knows the `protocols` overload, so the Bun-specific option
    // bag is cast through `unknown` (the runtime honors it — proven by the dual-listener test).
    const ws = this.tls
      ? new WebSocket(this.url, { tls: this.tls } as unknown as string[])
      : new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (ws !== this.ws) return; // a superseded socket opened late — ignore
      // NOTE: backoff is reset on READY (authenticated), NOT here — a socket that opens but
      // fails the handshake (e.g. encryption_required, revoked) must keep backing off, so a
      // rejected proxy cannot hammer the primary (networking-resilience §1, bounded reconnect).
      if (this.createHandshake) {
        // T12 — do NOT mark ready yet: run the Ed25519 handshake first. `request()`
        // blocks on `ready`, so no frame is sent until the tunnel is authenticated.
        this.setState("authenticating");
        const driver = this.createHandshake();
        this.handshakeDriver = driver;
        const first = driver.open();
        if (first !== undefined) {
          try {
            ws.send(first);
          } catch {
            /* socket dropped mid-open — handleDown will reconnect */
          }
        }
        return;
      }
      this.mux.setSend((data) => ws.send(data));
      this.markReady();
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (ws !== this.ws) return;
      // ── T12 auth phase: messages feed the handshake driver until authenticated ──
      if (this.handshakeDriver) {
        const step = this.handshakeDriver.next(decodeText(ev.data as RawMessage));
        if (step.send !== undefined) {
          try {
            ws.send(step.send);
          } catch {
            /* dropped mid-handshake — handleDown reconnects + re-auths */
          }
        }
        if (step.fail !== undefined) {
          // Fail-closed: tear the socket down. A reconnect (if enabled) re-runs the
          // handshake from scratch; the tunnel never carries a frame unauthenticated.
          this.handshakeDriver = undefined;
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          return;
        }
        if (step.done) {
          // Authenticated — bind the mux send slot and open the readiness gate. Capture the
          // negotiated health-reporting params (mesh-health-reporting.md §2) BEFORE markReady so
          // the liveness loop it arms picks the health-frame path when active.
          this.handshakeDriver = undefined;
          this.negotiatedHealth = step.healthReporting;
          try {
            this.onHealthNegotiated?.(step.healthReporting);
          } catch {
            /* an observer must never wedge the auth path */
          }
          this.mux.setSend((data) => ws.send(data));
          this.markReady();
          // A2 — every (re)authenticated socket re-advertises the catalog. Fired AFTER the
          // mux is wired + the gate is open, so the hook's own `request()` lands on this
          // live socket. Best-effort: a throwing hook must never wedge the auth path.
          try {
            this.onAuthenticated?.();
          } catch {
            /* a catalog (re)push failure never breaks the authenticated tunnel */
          }
        }
        return;
      }
      void this.mux.dispatch(ev.data as RawMessage);
    });
    // `close` and `error` can BOTH fire, and a stale socket may emit a late event
    // after we have already redialed — key the teardown to THIS socket.
    ws.addEventListener("close", () => this.handleDown(ws));
    ws.addEventListener("error", () => this.handleDown(ws));
  }

  /**
   * Mark the tunnel READY (authenticated + frame-carrying): reset the backoff (a good
   * connection earns a fresh budget), open the readiness gate, surface `connected`, and arm
   * the heartbeat. Called from both the raw-open and the handshake-`done` paths.
   */
  private markReady(): void {
    this.backoffMs = this.backoffInitialMs;
    this.reconnectAttempt = 0;
    if (this.ready.settled) this.ready = deferred<void>();
    this.ready.resolve();
    this.setState("connected");
    this.startHeartbeat();
  }

  /**
   * Arm the liveness loop: every interval, send a beat to the primary through the mux with a
   * short deadline. A missed reply (timeout on a half-open socket, or a disconnect) FORCES a
   * reconnect — converting a silently-dead socket into an observable drop (networking-resilience
   * §2). When health reporting is NEGOTIATED (mesh-health-reporting.md §4) the beat is a `health`
   * frame (built by `buildHealthReport`) at the negotiated interval — it SUBSUMES the bare ping
   * (no second timer); otherwise it is a bare `ping` at `heartbeatIntervalMs`. Cleared on down/close.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const period = this.negotiatedHealth ? this.negotiatedHealth.intervalMs : this.heartbeatIntervalMs;
    // Fail-closed: a non-finite/≤0 period must never arm a 0-delay loop (NaN coerces to 0 → a
    // frame flood / CPU spin). Negotiation already validates the advert, but guard here too.
    if (!Number.isFinite(period) || period <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      // Only beat on a live, ready tunnel; a beat that fails forces the socket down.
      if (this.closed || !this.ready.settled) return;
      void this.buildBeatFrame().then((frame) => {
        if (this.closed || !this.ready.settled) return;
        this.mux.request(frame, this.heartbeatTimeoutMs).then(
          () => {
            /* reply received — the tunnel is live */
          },
          () => {
            // No reply within the deadline (half-open) — force the socket down to trigger reconnect.
            this.forceReconnect();
          },
        );
      });
    }, period);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Build the periodic beat frame: a `health` frame when reporting is negotiated + a builder is
   * wired (stamping `reporter`/`seq`/`ts` onto the supplied `{overall,sources}`), else a bare
   * `ping`. A throwing/empty builder degrades gracefully to a `ping` for that tick.
   */
  private async buildBeatFrame(): Promise<Frame> {
    if (this.negotiatedHealth && this.buildHealthReport) {
      try {
        const body = await this.buildHealthReport();
        if (body) {
          this.healthSeq += 1;
          return {
            t: "health",
            corr: newCorr(),
            payload: {
              reporter: this.healthReporter ?? "proxy",
              overall: body.overall,
              sources: body.sources,
              seq: this.healthSeq,
              ts: new Date().toISOString(),
            },
          };
        }
      } catch {
        /* fall through to a ping — a failed report must never break liveness */
      }
    }
    return { t: "ping", corr: newCorr(), payload: { at: new Date().toISOString() } };
  }

  /**
   * ON-CHANGE health push (mesh-health-reporting.md §4): send an immediate health report OUTSIDE
   * the periodic cadence (e.g. a local source flipped). Best-effort — a failure here never forces
   * a reconnect (that is the periodic beat's job). No-op when reporting isn't negotiated/wired.
   */
  reportHealthNow(): void {
    if (this.closed || !this.ready.settled || !this.negotiatedHealth || !this.buildHealthReport) return;
    void this.buildBeatFrame().then((frame) => {
      if (frame.t !== "health" || this.closed || !this.ready.settled) return;
      this.mux.request(frame, this.heartbeatTimeoutMs).catch(() => {
        /* on-change push is best-effort — the periodic beat still governs liveness */
      });
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Force the current socket down (heartbeat detected a half-open tunnel). Closing it fires the
   * `close` event → `handleDown` → backoff reconnect. Guarded by the `closed` flag.
   */
  private forceReconnect(): void {
    if (this.closed) return;
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      /* already gone — handleDown will still run via the close/error listener */
    }
  }

  /**
   * One-shot teardown for a dropped connection: detach the send slot, reject
   * in-flight requests cleanly, refresh the readiness gate, and schedule a
   * backoff reconnect (unless intentionally closed or auto-reconnect is off).
   * `error` and `close` can both fire — guarded to run once per connection cycle.
   */
  private handleDown(ws: WebSocket): void {
    // Ignore a late event from a socket we have already moved on from.
    if (ws !== this.ws) return;
    if (this.downHandled) return;
    this.downHandled = true;

    this.stopHeartbeat();
    // Abandon any in-flight handshake; the next connect builds a fresh driver (T12). The
    // negotiated health params are re-derived on the next handshake `done` (mesh-health-reporting §2).
    this.handshakeDriver = undefined;
    this.negotiatedHealth = undefined;
    this.mux.setSend(NO_SEND);
    this.mux.rejectAll(new MeshDisconnectedError());
    // Future requests must wait for the NEXT open — replace a settled gate.
    if (this.ready.settled) this.ready = deferred<void>();

    if (this.closed || !this.autoReconnect) {
      this.setState(this.closed ? "closed" : "reconnecting");
      return;
    }
    this.setState("reconnecting");
    // Raw (un-jittered) backoff doubles toward the cap — deterministic so the cap bounds it.
    const raw = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    // Equal-jitter the SCHEDULED delay (still ≤ raw ≤ cap) to de-correlate a reconnecting fleet.
    const delay = this.backoffJitter ? raw / 2 + Math.random() * (raw / 2) : raw;
    this.reconnectAttempt += 1;
    try {
      this.onReconnectScheduled?.({ attempt: this.reconnectAttempt, delayMs: delay });
    } catch {
      /* a test seam must never wedge the reconnect */
    }
    setTimeout(() => this.connect(), delay);
  }

  /** Resolve once the socket is open, or reject if it stays down past `timeoutMs`. */
  private whenReady(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new MeshDisconnectedError("mesh: client closed"));
    if (this.ready.settled) return Promise.resolve();
    const gate = this.ready;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new MeshTimeoutError("connect", timeoutMs));
      }, timeoutMs);
      gate.promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          /* superseded gate — the timeout (or a later call) governs */
        },
      );
    });
  }

  /**
   * Send `frame` UP the tunnel and resolve with the matching-`corr` reply.
   *
   * Waits for the socket to be ready first, then sends. If the tunnel drops while
   * the request is in flight (or it raced a drop the client had not yet observed),
   * the request was never answered — so we wait for the auto-reconnect and RESEND
   * the same `corr`, bounded by the overall `timeoutMs` deadline. A missing reply
   * (peer alive but silent) still fails as a clean `MeshTimeoutError`; an
   * application-level reply still resolves normally.
   */
  async request(frame: Frame, timeoutMs: number = this.timeoutMs): Promise<ResponseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed) throw new MeshDisconnectedError("mesh: client closed");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MeshTimeoutError(frame.corr, timeoutMs);
      // `whenReady` blocks until the (re)connect opens, so a retry never busy-spins.
      await this.whenReady(remaining);
      try {
        return await this.mux.request(frame, Math.max(0, deadline - Date.now()));
      } catch (err) {
        const retryable =
          err instanceof MeshDisconnectedError && this.autoReconnect && !this.closed && Date.now() < deadline;
        if (!retryable) throw err;
        // Loop: wait for the fresh socket, resend the unanswered request.
      }
    }
  }

  /** (Re)set the handler for requests forwarded down the tunnel. */
  setRequestHandler(handler: RequestHandler | undefined): void {
    this.mux.setRequestHandler(handler);
  }

  /** Whether the socket is currently open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Permanently close the tunnel: stop reconnecting and reject in-flight requests. */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.setState("closed");
    this.mux.rejectAll(new MeshDisconnectedError("mesh: client closed"));
    try {
      this.ws?.close();
    } catch {
      /* best-effort */
    }
  }
}
