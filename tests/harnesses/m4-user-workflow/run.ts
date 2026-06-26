/**
 * m4-user-workflow — runnable entrypoint.
 *
 *   bun run tests/harnesses/m4-user-workflow/run.ts
 *
 * Boots a REAL gateway (loopback socket) + a loopback journal service, then drives the
 * USER dynamic-workflow authoring worked path end-to-end over real HTTP, printing the
 * full transcript and a PASS/FAIL verdict. Exits 0 iff the worked path PASSES.
 */

import { runDemo, consoleLogger } from "./demo.ts";

const report = await runDemo({ logger: consoleLogger() });
process.exit(report.pass ? 0 : 1);
