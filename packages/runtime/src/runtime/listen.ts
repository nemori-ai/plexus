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
    const server = Bun.serve({
      fetch,
      hostname,
      port,
      // SSE streams (GET /events, /v1/events) are long-lived. Bun's default 10s idleTimeout
      // closes a quiet stream (the "[Bun.serve] request timed out after 10 seconds" log) and
      // drops it every 10s. Raise to the max (255s) so a stream with infrequent events
      // survives; clients reconnect+resnapshot on the rare longer gap. (A further hardening is
      // periodic keep-alive comments inside the SSE handlers.)
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
