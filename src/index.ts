/**
 * Plexus gateway entrypoint. Builds the Hono app and serves it on the loopback
 * bind (127.0.0.1, never 0.0.0.0 — §5 security model). `bun run dev` / `bun start`.
 */

import { loadConfig, baseUrl } from "./config.ts";
import { createApp } from "./core/index.ts";

const config = loadConfig();
const app = createApp(config);

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
