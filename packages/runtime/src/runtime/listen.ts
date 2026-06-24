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

/** Options for binding the runtime to a loopback socket. */
export interface ListenOptions {
  /** The request handler (the Hono `app.fetch`). */
  readonly fetch: FetchHandler;
  /** Loopback host — never 0.0.0.0 (§5 security model). */
  readonly hostname: string;
  /**
   * Desired port. `0` selects an ephemeral free port; the ACTUAL bound port is
   * reported back on the handle (critical for the supervisor's ready line).
   */
  readonly port: number;
}

/** A normalized, adapter-agnostic handle over a bound listener. */
export interface ListenHandle {
  /** The port the listener actually bound to (resolves `port: 0` to the real one). */
  readonly port: number;
  /** Stop the listener (graceful). */
  stop(): void;
}

/**
 * Bind `fetch` to a loopback socket and return a normalized handle.
 *
 * The sole adapter today is Bun. To add a Node adapter, branch on a runtime
 * capability check here and serve the same `fetch` via `@hono/node-server` —
 * no caller changes required.
 */
export function listen(opts: ListenOptions): ListenHandle {
  // ── Bun adapter (the only target today) ──────────────────────────────────
  const server = Bun.serve({
    fetch: opts.fetch as (req: Request) => Response | Promise<Response>,
    hostname: opts.hostname, // loopback only
    port: opts.port,
    // SSE streams (GET /events, /v1/events) are long-lived. Bun's default 10s idleTimeout
    // closes a quiet stream (the "[Bun.serve] request timed out after 10 seconds" log) and
    // drops it every 10s. Raise to the max (255s) so a stream with infrequent events
    // survives; clients reconnect+resnapshot on the rare longer gap. (A further hardening is
    // periodic keep-alive comments inside the SSE handlers.)
    idleTimeout: 255,
  });
  return {
    // Bun's `server.port` is typed `number | undefined`; a successful TCP bind
    // always yields a concrete port, fall back to the requested one defensively.
    port: server.port ?? opts.port,
    stop: () => server.stop(),
  };
}
