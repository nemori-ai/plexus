/**
 * ============================================================================
 * Listen-adapter seam (REDESIGN-ARCHITECTURE §3.2, DECISION 1)
 * ============================================================================
 *
 * The ONE module that owns the actual socket bind. The runtime core is just
 * `app.fetch` (a standard `Request -> Response` handler); everything about HOW
 * it is served lives behind this seam.
 *
 * Today the only implementation calls `Bun.serve`. The point of isolating it is
 * cheap insurance: IF a future client must run the runtime in-process under a
 * pure-Node environment (e.g. an Electron-main or a Node TUI without the Bun
 * binary), the SAME `app.fetch` can be served by `@hono/node-server` by adding a
 * branch here — with ZERO changes to the core, the entrypoints, or any caller.
 *
 * Callers depend only on the `ListenHandle` shape (a bound port + `stop()`),
 * never on `Bun.serve` directly. This is the single `Bun.serve` call site for
 * the supervised runtime path.
 */

/**
 * A fetch handler: the Hono app's `app.fetch`. Typed permissively (extra Hono
 * env/exec-ctx args are optional) so `app.fetch` assigns without a cast.
 */
export type FetchHandler = (request: Request, ...rest: never[]) => Response | Promise<Response>;

/** Options for binding the runtime to one or more interface sockets. */
export interface ListenOptions {
  /** The request handler (the Hono `app.fetch`). */
  readonly fetch: FetchHandler;
  /**
   * A single host to bind. Loopback by default (§5 security model). Retained for
   * the historical single-address call path; `hostnames` (when set) takes priority.
   */
  readonly hostname?: string;
  /**
   * The set of interface addresses to bind on the SAME port (FEAT configurable-
   * binding). `["127.0.0.1"]` (the default) is the historical single-loopback path.
   * `["0.0.0.0"]` binds all IPv4 interfaces. Multiple specific IPs each get their
   * own `Bun.serve` on the shared port. When set, supersedes `hostname`.
   */
  readonly hostnames?: readonly string[];
  /**
   * Desired port. `0` selects an ephemeral free port; the ACTUAL bound port is
   * reported back on the handle (critical for the supervisor's ready line). When
   * binding MULTIPLE addresses on an ephemeral port, the FIRST address binds the
   * OS-assigned port and the rest reuse that concrete port (so they share one port).
   */
  readonly port: number;
  /**
   * OPTIONAL WebSocket support.
   *
   * `upgrade(request, server)` is called before `fetch` on every request; returning true means
   * the adapter already took the socket. Kept as a callback rather than a route table so the
   * only thing that knows about `Bun.serve` remains this file — a caller says "this request is
   * a socket of mine", not "here is how Bun upgrades".
   */
  readonly websocket?: {
    upgrade(request: Request, upgrade: (data: unknown) => boolean): boolean;
    open?(ws: BunSocket): void;
    message?(ws: BunSocket, data: string | Buffer): void;
    close?(ws: BunSocket): void;
  };
}

/** The socket shape callers use — the subset of Bun's `ServerWebSocket` we rely on. */
export interface BunSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly data: unknown;
}

/** A normalized, adapter-agnostic handle over one-or-more bound listeners. */
export interface ListenHandle {
  /** The port the listener actually bound to (resolves `port: 0` to the real one). */
  readonly port: number;
  /** Every interface address actually bound (parallel to the input addresses). */
  readonly addresses: readonly string[];
  /** Stop ALL listeners (graceful). */
  stop(): void;
}

/**
 * Bind `fetch` to one or more interface sockets on a SHARED port, returning a
 * normalized handle whose `stop()` stops them all.
 *
 * The default path (a single loopback address) behaves EXACTLY as before: one
 * `Bun.serve` on `127.0.0.1`. When multiple addresses are configured, one
 * `Bun.serve` is created per address; the first binds the (possibly ephemeral)
 * port and the rest reuse that concrete port so the whole set shares one port.
 *
 * The sole adapter today is Bun. To add a Node adapter, branch on a runtime
 * capability check here and serve the same `fetch` via `@hono/node-server` —
 * no caller changes required.
 */
export function listen(opts: ListenOptions): ListenHandle {
  const fetch = opts.fetch as (req: Request) => Response | Promise<Response>;
  // Resolve the address set: explicit `hostnames` wins, else the single `hostname`,
  // else loopback. De-dupe defensively (binding the same address twice would EADDRINUSE).
  const requested =
    opts.hostnames && opts.hostnames.length > 0
      ? opts.hostnames
      : [opts.hostname ?? "127.0.0.1"];
  const addresses = [...new Set(requested)];

  const servers: { stop(): void }[] = [];
  let boundPort = opts.port;
  const boundAddresses: string[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const hostname = addresses[i] as string;
    // First server binds the requested (maybe ephemeral) port; the rest reuse the
    // concrete bound port so the whole set shares ONE port.
    const port = i === 0 ? opts.port : boundPort;
    // Two shapes, not one spread: Bun's own types require `websocket` to be present-or-absent
    // as a whole, so a conditional spread does not typecheck.
    const ws = opts.websocket;
    const server = ws
      ? Bun.serve({
          fetch: (request: Request, srv: { upgrade(req: Request, o?: { data?: unknown }): boolean }) => {
            // Ask the caller first; a socket it claims never reaches the HTTP handler.
            if (ws.upgrade(request, (data) => srv.upgrade(request, { data }))) {
              return undefined as unknown as Response;
            }
            return fetch(request);
          },
          websocket: {
            open: (socket) => ws.open?.(socket as unknown as BunSocket),
            message: (socket, data) => ws.message?.(socket as unknown as BunSocket, data),
            close: (socket) => ws.close?.(socket as unknown as BunSocket),
          },
          hostname,
          port,
          idleTimeout: 255,
        })
      : Bun.serve({
          fetch,
          hostname,
          port,
          // SSE streams (GET /events, /v1/events) are long-lived. Bun's default 10s idleTimeout
          // closes a quiet stream and drops it every 10s. Raise to the max (255s) so a stream
          // with infrequent events survives; clients reconnect+resnapshot on the rare gap.
          idleTimeout: 255,
        });
    // Bun's `server.port` is typed `number | undefined`; a successful TCP bind
    // always yields a concrete port — capture it from the FIRST bind so the rest share it.
    if (i === 0) boundPort = server.port ?? opts.port;
    servers.push(server);
    boundAddresses.push(hostname);
  }

  return {
    port: boundPort,
    addresses: boundAddresses,
    stop: () => {
      for (const s of servers) {
        try {
          s.stop();
        } catch {
          /* best-effort stop-all */
        }
      }
    },
  };
}
