/**
 * Plexus v1 END-TO-END ACCEPTANCE DEMO — runnable entrypoint (t13).
 *
 * Boots a REAL gateway on a concrete free loopback port, registers the real
 * cc-master first-party source + a real Obsidian vault read-only source, and drives
 * a real `PlexusClient` through BOTH acceptance scenarios over real HTTP `fetch`,
 * printing the full transcript and a PASS/FAIL verdict.
 *
 *   bun run examples/e2e-demo/run.ts
 *
 * Exits 0 iff both scenarios PASS. NEVER mutates the real ~/.claude (cc-master
 * installs into a throwaway temp dir).
 */

import { runDemo, consoleLogger } from "./demo.ts";

const report = await runDemo({ logger: consoleLogger() });
process.exit(report.overall ? 0 : 1);
