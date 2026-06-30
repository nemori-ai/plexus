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
 * `MeshServer` holds a SINGLE active connection for now (the primary↔one-proxy
 * case); fanning out to many proxies is a later concern.
 */

import type { Frame } from "@plexus/protocol";
import type { ServerWebSocket } from "bun";

import { decodeFrame, decodeText, encodeFrame, withCorr, type RawMessage } from "./frames.ts";
import type { HandshakeDriver } from "./handshake.ts";

/** Default per-request deadline before a missing reply rejects (ms). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Reconnect backoff: first retry delay and the cap it doubles toward (ms). */
const DEFAULT_BACKOFF_INITIAL_MS = 50;
const DEFAULT_BACKOFF_MAX_MS = 2_000;

/** A reply frame for a request — same `Frame` union, paired by `corr`. */
export type ResponseFrame = Frame;

/**
 * Handle an inbound request frame arriving on the tunnel and return the reply
 * frame to send back. The mux stamps the reply with the request's `corr`, so a
 * handler need not echo it. Throwing (or never returning) leaves the peer to time
 * out — there is no error frame at this raw layer.
 */
export type RequestHandler = (frame: Frame) => Frame | Promise<Frame>;

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
  /** Port to bind. `0` (default) selects an ephemeral free port. */
  port?: number;
  /** Interface to bind. Loopback by default (the mesh trust boundary is the tunnel). */
  hostname?: string;
  /** Per-`forward()` deadline (ms). */
  requestTimeoutMs?: number;
  /** Handler for requests the proxy sends UP the tunnel (e.g. enroll/catalog/audit). */
  onRequest?: RequestHandler;
  /**
   * OPTIONAL connection-auth gate (T12). When provided, every accepted socket must
   * complete the Ed25519 mutual-auth handshake (driven by a fresh driver per
   * connection) BEFORE it becomes the active frame-carrying socket. Absent ⇒ the raw,
   * unauthenticated transport (pure-mux unit tests only).
   */
  createHandshake?: () => HandshakeDriver;
  /**
   * RESOLUTION HEALTH HOOKS (T10). Fired as the active socket comes and goes so the
   * primary's `ResolutionTable` can mark a workload's mounted caps available/unavailable:
   *  - `onConnect(workload)`  — an authenticated socket was PROMOTED (the "connect" signal).
   *  - `onDisconnect(workload)` — the active socket DROPPED / closed / was torn down.
   * `workload` is the identity bound at handshake; `undefined` for the raw (no-gate) path.
   */
  onConnect?: (workload: string | undefined) => void;
  onDisconnect?: (workload: string | undefined) => void;
}

/**
 * The PRIMARY side of the tunnel. Accepts a single proxy WebSocket via
 * `Bun.serve({ websocket })`, holds it, and forwards already-authorized requests
 * down it. Mirrors the `runtime/listen.ts` `Bun.serve` pattern but stands alone for
 * now (the supervised HTTP runtime and the mesh acceptor are separate listeners at
 * this stage).
 */
export class MeshServer {
  private readonly mux: FrameMux;
  private readonly timeoutMs: number;
  private server?: ReturnType<typeof Bun.serve>;
  private active?: ServerWebSocket<unknown>;
  /** Per-connection auth handshakes in flight (T12) — keyed by the unauthenticated socket. */
  private readonly handshakes = new Map<ServerWebSocket<unknown>, HandshakeDriver>();
  /** The workload identity bound to the active socket once authenticated (T12). */
  private authedWorkload?: string;

  constructor(private readonly opts: MeshServerOptions = {}) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.mux = new FrameMux(NO_SEND, opts.onRequest);
  }

  /** Start listening; returns the actually-bound port. Idempotent-ish (call once). */
  start(): { port: number } {
    const self = this;
    this.server = Bun.serve({
      port: this.opts.port ?? 0,
      hostname: this.opts.hostname ?? "127.0.0.1",
      fetch(req, server): Response | undefined {
        // The only thing this listener does is upgrade to the tunnel socket.
        if (server.upgrade(req, { data: undefined })) return undefined;
        return new Response("expected websocket upgrade", { status: 426 });
      },
      websocket: {
        open(ws) {
          if (self.opts.createHandshake) {
            // T12 — UNAUTHENTICATED until the handshake completes. Do NOT make this the
            // active frame-carrying socket yet; route its raw messages to the driver.
            const driver = self.opts.createHandshake();
            self.handshakes.set(ws, driver);
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
          self.active = ws;
          self.mux.setSend((data) => ws.send(data));
        },
        message(ws, message) {
          // ── T12 auth phase: feed handshake messages to the driver, never the mux ──
          const driver = self.handshakes.get(ws);
          if (driver) {
            const step = driver.next(decodeText(message as RawMessage));
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
              // PROMOTE: this socket is now the authenticated, frame-carrying connection.
              // This promotion IS the "connect" signal the ResolutionTable keys on (T10):
              // the workload's mounted caps become reachable the instant the socket is live.
              self.handshakes.delete(ws);
              self.active = ws;
              self.authedWorkload = step.workload;
              self.mux.setSend((data) => ws.send(data));
              self.opts.onConnect?.(step.workload);
            }
            return;
          }
          // ── Authenticated path. With the gate on, ONLY the promoted socket may drive
          //    the mux; any frame on a non-promoted socket is refused (fail-closed). ──
          if (self.opts.createHandshake && self.active !== ws) {
            try {
              ws.close();
            } catch {
              /* already gone */
            }
            return;
          }
          void self.mux.dispatch(message as RawMessage);
        },
        close(ws) {
          self.handshakes.delete(ws);
          if (self.active === ws) {
            // The active socket dropped — the "down" signal for the ResolutionTable (T10):
            // this workload's home is unreachable until it re-enrolls + re-authenticates.
            const workload = self.authedWorkload;
            self.active = undefined;
            self.authedWorkload = undefined;
            self.mux.setSend(NO_SEND);
            self.opts.onDisconnect?.(workload);
          }
        },
      },
    });
    return { port: this.server.port ?? 0 };
  }

  /** The bound port (after `start()`), or `0` if not listening. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Whether an AUTHENTICATED proxy tunnel is currently attached. With the T12 auth gate
   * on, a socket becomes `active` only after the Ed25519 handshake completes, so this is
   * `true` only for a mutually-authenticated connection.
   */
  get connected(): boolean {
    return this.active !== undefined;
  }

  /** The workload identity bound to the authenticated active socket (T12), if any. */
  get authenticatedWorkload(): string | undefined {
    return this.authedWorkload;
  }

  /** (Re)set the inbound-request handler after construction. */
  setRequestHandler(handler: RequestHandler | undefined): void {
    this.mux.setRequestHandler(handler);
  }

  /**
   * Forward a request DOWN the tunnel to the attached proxy and resolve with the
   * matching-`corr` reply. Rejects immediately if no proxy is attached.
   */
  forward(frame: Frame, timeoutMs: number = this.timeoutMs): Promise<ResponseFrame> {
    if (!this.active) {
      return Promise.reject(new MeshDisconnectedError("mesh: no proxy attached"));
    }
    return this.mux.request(frame, timeoutMs);
  }

  /** Force-close the active proxy socket (the server stays listening). Test/blip hook. */
  dropActiveConnection(): void {
    this.active?.close();
  }

  /** Stop listening and reject any in-flight forwards. */
  stop(): void {
    this.mux.rejectAll(new MeshDisconnectedError("mesh: server stopped"));
    this.handshakes.clear();
    // A teardown with an active socket is a "down" signal too (T10) — mark its workload
    // unavailable so a lingering ResolutionTable read after stop() never reports stale "ok".
    const hadActive = this.active !== undefined;
    const workload = this.authedWorkload;
    this.active = undefined;
    this.authedWorkload = undefined;
    this.mux.setSend(NO_SEND);
    if (hadActive) this.opts.onDisconnect?.(workload);
    try {
      this.server?.stop(true);
    } catch {
      /* best-effort */
    }
    this.server = undefined;
  }
}

// ── Proxy side ────────────────────────────────────────────────────────────────

/** Options for the proxy-side tunnel dialer. */
export interface MeshClientOptions {
  /** The `ws://`/`wss://` URL of the primary's tunnel listener. */
  url: string;
  /** Per-`request()` deadline (ms). */
  requestTimeoutMs?: number;
  /** First reconnect delay (ms); doubles each failed attempt up to the cap. */
  backoffInitialMs?: number;
  /** Reconnect backoff cap (ms). */
  backoffMaxMs?: number;
  /** Auto-reconnect after an unexpected drop. Default `true`. */
  autoReconnect?: boolean;
  /** Handler for requests the primary forwards DOWN the tunnel (e.g. invoke). */
  onRequest?: RequestHandler;
  /**
   * OPTIONAL connection-auth gate (T12). When provided, the client runs the Ed25519
   * mutual-auth handshake on every (re)connect BEFORE the socket is marked ready — so a
   * `request()` waits for an AUTHENTICATED tunnel, and an unauthenticated socket never
   * sends a frame. A fresh driver is built per connection (so a reconnect re-auths).
   */
  createHandshake?: () => HandshakeDriver;
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
  private readonly autoReconnect: boolean;
  private readonly createHandshake?: () => HandshakeDriver;

  private ws?: WebSocket;
  private backoffMs: number;
  private ready: Deferred<void>;
  private closed = false;
  private downHandled = false;
  /** The in-flight connection-auth handshake (T12); cleared once authenticated/torn down. */
  private handshakeDriver?: HandshakeDriver;

  constructor(opts: MeshClientOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.backoffInitialMs = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.createHandshake = opts.createHandshake;
    this.backoffMs = this.backoffInitialMs;
    this.mux = new FrameMux(NO_SEND, opts.onRequest);
    this.ready = deferred<void>();
    this.connect();
  }

  /** (Re)dial the primary and wire socket events into the mux + readiness gate. */
  private connect(): void {
    if (this.closed) return;
    this.downHandled = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (ws !== this.ws) return; // a superseded socket opened late — ignore
      this.backoffMs = this.backoffInitialMs; // reset backoff on a good connect
      if (this.createHandshake) {
        // T12 — do NOT mark ready yet: run the Ed25519 handshake first. `request()`
        // blocks on `ready`, so no frame is sent until the tunnel is authenticated.
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
      if (this.ready.settled) this.ready = deferred<void>();
      this.ready.resolve();
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
          // Authenticated — bind the mux send slot and open the readiness gate.
          this.handshakeDriver = undefined;
          this.mux.setSend((data) => ws.send(data));
          if (this.ready.settled) this.ready = deferred<void>();
          this.ready.resolve();
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

    // Abandon any in-flight handshake; the next connect builds a fresh driver (T12).
    this.handshakeDriver = undefined;
    this.mux.setSend(NO_SEND);
    this.mux.rejectAll(new MeshDisconnectedError());
    // Future requests must wait for the NEXT open — replace a settled gate.
    if (this.ready.settled) this.ready = deferred<void>();

    if (this.closed || !this.autoReconnect) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
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
    this.mux.rejectAll(new MeshDisconnectedError("mesh: client closed"));
    try {
      this.ws?.close();
    } catch {
      /* best-effort */
    }
  }
}
