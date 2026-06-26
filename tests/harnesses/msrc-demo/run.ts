/**
 * msrc-t5 — runnable managed-sources HOT-RELOAD demo.
 *
 *   bun run tests/harnesses/msrc-demo/run.ts
 *
 * Boots ONE real Plexus gateway (throwaway PLEXUS_HOME) + a mock Obsidian Local
 * REST endpoint, then — with NO `--obsidian-rest` flag and WITHOUT restarting —
 * detects → ADDs (hot-appears + persists) → an agent reads/writes through it →
 * RECONFIGURES the baseUrl (grants purged) → REMOVEs it (disappears live + from
 * sources.json). Prints the whole transcript. See `harness.ts` for the cycle.
 */

import { runDemo } from "./harness.ts";

const result = await runDemo({ echo: true });

// A terse machine-checkable summary at the end (the test asserts these same fields).
console.log("\n── summary (asserted by tests/msrc-t5-demo.test.ts) ─────────────");
console.log(`  capability count: ${result.countBeforeAdd} → ${result.countAfterAdd} (add) → ${result.countAfterRemove} (remove)`);
console.log(`  persisted after add:    ${result.persistedAfterAdd}`);
console.log(`  persisted after remove: ${result.persistedAfterRemove}`);
console.log(`  grant purged by reconfigure:        ${result.grantPurgedByReconfigure}`);
console.log(`  pre-reconfigure token refresh fails: ${result.preReconfigureTokenRefreshFails}`);
console.log(`  fresh write grant pends again:       ${result.freshWriteGrantPendsAfterReconfigure}`);

const allGreen =
  result.countAfterAdd > result.countBeforeAdd &&
  result.persistedAfterAdd &&
  result.agentWroteAndReadBack &&
  result.grantBeforeReconfigure &&
  result.grantPurgedByReconfigure &&
  result.preReconfigureTokenRefreshFails &&
  result.freshWriteGrantPendsAfterReconfigure &&
  result.countAfterRemove === result.countBeforeAdd &&
  !result.persistedAfterRemove;

if (!allGreen) {
  console.error("\n✗ demo did NOT meet every honest-green assertion");
  process.exit(1);
}
console.log("\n✓ all honest-green: no flag, no restart.");
