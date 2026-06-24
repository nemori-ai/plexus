/**
 * Plexus gateway entrypoint (`bun run src/index.ts` / `bun run serve`). Boots the
 * headless runtime through the single supervised seam (`runtime/serve.ts`), which
 * binds on the loopback socket (127.0.0.1, never 0.0.0.0 — §5 security model),
 * emits the machine-readable ready line, and writes `~/.plexus/runtime.json`.
 *
 * This is the standalone / supervised process entrypoint. The human launcher
 * `bin/plexus` boots through the SAME `startRuntime` seam (adding its banner +
 * --vault/--obsidian-rest flags on top).
 */

import { loadConfig, baseUrl } from "./config.ts";
import { startRuntime, installSignalHandlers } from "./runtime/serve.ts";

const config = loadConfig();
const runtime = await startRuntime(config);

// Human-readable lines (the machine-readable PLEXUS_READY line was already
// emitted by startRuntime for any supervisor parsing stdout).
const url = baseUrl({ ...config, port: runtime.info.port });
console.log(`[plexus] gateway listening on ${url} (loopback only)`);
console.log(`[plexus] discovery: ${url}/.well-known/plexus`);

// Graceful shutdown on SIGINT/SIGTERM (stops the listener + clears runtime.json).
installSignalHandlers(runtime);
