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
import { bootScanCapabilities } from "../core/state.ts";
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

  const { app, state } = createAppWithState(config);

  // FIRST-RUN BOOT SCAN (m5fix): make available first-party sources discoverable
  // on a plain boot (cc-master when `claude` is on PATH). Bounded so a slow
  // login-shell PATH probe can't hang startup. Discoverable only; grants still
  // required to invoke. (Same behavior as src/index.ts / bin/plexus historically.)
  if (bootScan) await bootScanCapabilities(state);

  // Launcher hook: register managed sources (e.g. --vault) before serving.
  if (opts.beforeListen) await opts.beforeListen(state);

  // Bind through the listen-adapter seam (the only Bun.serve site).
  const listener = listen({
    fetch: app.fetch,
    hostname: config.host, // loopback only — never 0.0.0.0 (§5 security model)
    port: config.port,
  });

  const info: RuntimeInfo = {
    port: listener.port, // the ACTUAL bound port (resolves ephemeral binds)
    pid: process.pid,
    lraVersion: LRA_VERSION,
  };

  if (writePortFile) writeRuntimeFile(info);
  if (emitReadyLine) {
    // eslint-disable-next-line no-console
    console.log(readyLine(info));
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
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
