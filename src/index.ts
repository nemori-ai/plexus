/**
 * Plexus gateway entrypoint. Builds the Hono app and serves it on the loopback
 * bind (127.0.0.1, never 0.0.0.0 — §5 security model). `bun run dev` / `bun start`.
 */

import { loadConfig, baseUrl } from "./config.ts";
import { createAppWithState } from "./core/index.ts";
import { bootScanCapabilities } from "./core/state.ts";

const config = loadConfig();
const { app, state } = createAppWithState(config);

// FIRST-RUN BOOT SCAN (m5fix): start + scan the capability registry so available
// first-party sources (cc-master when `claude` is on PATH) populate `.well-known`
// + the `/admin` manifest immediately on a plain boot — no `--vault` needed.
// Discoverable only; grants are still required to invoke. Bounded so a slow
// login-shell PATH probe can't hang startup.
await bootScanCapabilities(state);

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host, // loopback only
  port: config.port,
});

// eslint-disable-next-line no-console
console.log(`[plexus] gateway listening on ${baseUrl(config)} (loopback only)`);
console.log(`[plexus] discovery: ${baseUrl(config)}/.well-known/plexus`);

// Graceful shutdown on SIGINT/SIGTERM.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[plexus] received ${sig}, shutting down`);
    server.stop();
    process.exit(0);
  });
}
