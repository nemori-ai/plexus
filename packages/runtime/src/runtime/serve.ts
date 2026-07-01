/**
 * ============================================================================
 * Supervised runtime entrypoint (REDESIGN-ARCHITECTURE §3.3, PLAN P0)
 * ============================================================================
 *
 * The single seam that boots the headless gateway as a SUPERVISABLE process:
 * build app+state, run the first-run boot scan, bind via the listen-adapter seam
 * (`./listen.ts`), then announce readiness two ways (§3.3 "parse-then-confirm"):
 *   - a machine-readable READY LINE on stdout, and
 *   - the `~/.plexus/runtime.json` port file.
 *
 * Both the human launcher (`bin/plexus`) and the plain `bun run src/index.ts`
 * boot through `startRuntime` so there is exactly ONE place that owns the
 * listen + ready-line + port-file contract. `bin/plexus` adds its banner/flags
 * ON TOP; this module owns the lifecycle.
 */

import type { Hono } from "hono";
import type { GatewayConfig } from "../config.ts";
import { createAppWithState } from "../core/server.ts";
import type { GatewayState } from "../core/state.ts";
import { bootScanCapabilities, setBoundPort, setBoundAddresses } from "../core/state.ts";
import { listen, type ListenHandle } from "./listen.ts";
import {
  LRA_VERSION,
  readyLine,
  writeRuntimeFile,
  clearRuntimeFile,
  type RuntimeInfo,
} from "./runtime-file.ts";

/** A running supervised runtime: the bound listener + the constructed app/state. */
export interface RunningRuntime {
  /** The bound listener handle (actual port + stop()). */
  readonly listener: ListenHandle;
  /** The Hono app that is being served. */
  readonly app: Hono;
  /** The wired gateway state (registries, stores, event bus). */
  readonly state: GatewayState;
  /** The runtime descriptor announced on the ready line + written to runtime.json. */
  readonly info: RuntimeInfo;
  /** Stop the listener and clear the port file (idempotent, best-effort). */
  stop(): void;
}

/** Options for `startRuntime` (all optional; sensible supervised defaults). */
export interface StartRuntimeOptions {
  /**
   * Emit the machine-readable `PLEXUS_READY {...}` line on stdout once bound.
   * Default true (a supervisor parses it). `bin/plexus` keeps it on too.
   */
  readonly emitReadyLine?: boolean;
  /**
   * Write `~/.plexus/runtime.json` once bound. Default true so the CLI/agents can
   * discover a non-default (ephemeral) port without env vars.
   */
  readonly writePortFile?: boolean;
  /**
   * Run the first-run capability boot scan before listening. Default true
   * (matches today's `src/index.ts` + `bin/plexus`). Bounded internally.
   */
  readonly bootScan?: boolean;
  /**
   * Hook invoked AFTER the boot scan but BEFORE the socket binds, with the wired
   * state. Used by `bin/plexus` to register `--vault` / `--obsidian-rest` managed
   * sources so they are live before the gateway starts serving. Errors propagate
   * (the launcher decides how to surface them).
   */
  readonly beforeListen?: (state: GatewayState) => void | Promise<void>;
}

/**
 * Boot the gateway and bind it to a loopback socket. Returns once the listener is
 * up, the ready line is emitted, and the port file is written. The caller owns
 * shutdown (call `.stop()`), or use `serveForever` for the standalone process.
 */
export async function startRuntime(
  config: GatewayConfig,
  opts: StartRuntimeOptions = {},
): Promise<RunningRuntime> {
  const emitReadyLine = opts.emitReadyLine ?? true;
  const writePortFile = opts.writePortFile ?? true;
  const bootScan = opts.bootScan ?? true;

  // PROXY ENROLLMENT FROM ENV (A6) — a STOCK `PLEXUS_MODE=proxy` boot reads its one-time
  // join token from `PLEXUS_JOIN_TOKEN` and threads it into the mesh runtime so the proxy
  // dials → Ed25519-authenticates → ENROLLS from env ALONE (no custom launcher; the A4 demo
  // needed one only because this seam did not yet read the token). The join token is a
  // TRANSIENT secret presented once at first enroll, NOT persisted config — so it is threaded
  // through this boot seam (parallel to the `createAppWithState({ mesh })` test/launcher seam)
  // rather than entering `GatewayConfig`. The proxy's Ed25519 IDENTITY is NOT injected here:
  // it auto-loads/persists under this process's `PLEXUS_HOME` (`loadOrCreateMeshIdentity`).
  // A `primary` boot IGNORES the token (a primary dials/enrolls no one). ADDITIVE: unset (or
  // primary) ⇒ `createAppWithState(config)` exactly as before.
  const joinToken =
    config.mode === "proxy" ? process.env.PLEXUS_JOIN_TOKEN?.trim() || undefined : undefined;
  const { app, state } = createAppWithState(
    config,
    joinToken ? { mesh: { joinToken } } : undefined,
  );

  // THE BOOT-FIXED AUTHORITY MODE (mesh §0, Invariant A) — read once here, never
  // mutated. A `primary` ACCEPTS a proxy tunnel (the second routable listener) and
  // forwards authorized invokes down it; a `proxy` DIALS its `upstream`. The mesh
  // runtime is wired onto `state` at construction; we bind its socket below (T7).
  const mode = state.mode;
  void mode;

  // FIRST-RUN BOOT SCAN (m5fix): make available first-party sources discoverable
  // on a plain boot (cc-master when `claude` is on PATH). Bounded so a slow
  // login-shell PATH probe can't hang startup. Discoverable only; grants still
  // required to invoke. (Same behavior as src/index.ts / bin/plexus historically.)
  if (bootScan) await bootScanCapabilities(state);

  // Launcher hook: register managed sources (e.g. --vault) before serving.
  if (opts.beforeListen) await opts.beforeListen(state);

  // Bind through the listen-adapter seam (the only Bun.serve site). DEFAULT is the
  // loopback-only `["127.0.0.1"]` — identical to the historical single-loopback bind;
  // the user may persist additional interface IPs (or `0.0.0.0`) via network.json,
  // which opens the gateway to the LAN and makes the connection-key the trust boundary.
  const bindAddresses =
    config.bindAddresses && config.bindAddresses.length > 0
      ? [...config.bindAddresses]
      : [config.host];
  const listener = listen({
    fetch: app.fetch,
    hostnames: bindAddresses,
    port: config.port,
  });

  // Thread the ACTUAL bound port into state so `.well-known`/`GET /v1/status`
  // advertise the REAL port for an ephemeral `port:0` bind (REDESIGN §3.4).
  setBoundPort(state, listener.port);
  // Thread the ACTUAL bound interface addresses into state so the Host guard accepts
  // them + `GET /admin/api/network` reports them (FEAT configurable-binding).
  setBoundAddresses(state, listener.addresses);

  const info: RuntimeInfo = {
    port: listener.port, // the ACTUAL bound port (resolves ephemeral binds)
    pid: process.pid,
    lraVersion: LRA_VERSION,
  };

  // BIND THE MESH TUNNEL (T7): a `primary` opens the second routable listener; a
  // `proxy` dials its upstream (auto-reconnecting). Best-effort — a tunnel that fails
  // to bind/dial must never abort the agent-facing HTTP boot (the gateway still serves
  // its local capabilities; mesh forwards simply return capability_unavailable).
  try {
    await state.mesh.start();
  } catch {
    /* mesh is additive — never block the supervised HTTP boot on tunnel setup */
  }

  if (writePortFile) writeRuntimeFile(info);
  if (emitReadyLine) {
    // eslint-disable-next-line no-console
    console.log(readyLine(info));
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    state.mesh.stop();
    listener.stop();
    if (writePortFile) clearRuntimeFile();
  };

  return { listener, app, state, info, stop };
}

/**
 * Install SIGINT/SIGTERM handlers that gracefully stop the given runtime and
 * exit. Shared by the standalone entrypoint + `bin/plexus` so shutdown semantics
 * (and port-file cleanup) live in one place.
 */
export function installSignalHandlers(runtime: RunningRuntime): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[plexus] received ${sig}, shutting down`);
      runtime.stop();
      process.exit(0);
    });
  }
}
