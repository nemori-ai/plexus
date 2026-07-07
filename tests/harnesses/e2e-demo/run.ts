/**
 * Plexus v1 END-TO-END ACCEPTANCE DEMO — runnable entrypoint (t13).
 *
 * Boots a REAL gateway on a concrete free loopback port, registers a real Obsidian
 * vault read-only source, and drives a real `PlexusClient` through the acceptance
 * scenario over real HTTP `fetch`, printing the full transcript and a PASS/FAIL
 * verdict.
 *
 *   bun run tests/harnesses/e2e-demo/run.ts
 *
 * Exits 0 iff the scenario PASSES. NEVER mutates the real ~/.claude.
 */

import { runDemo, consoleLogger } from "./demo.ts";

const report = await runDemo({ logger: consoleLogger() });
process.exit(report.overall ? 0 : 1);
