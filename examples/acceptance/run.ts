/**
 * Runnable acceptance玩法 — prints the whole story as a step-by-step transcript.
 *
 *   bun run examples/acceptance/run.ts
 *
 * Boots a REAL Plexus gateway in-process over a temp PLEXUS_HOME + temp Obsidian
 * vault, plays the codex agent through discover → handshake → author+register a
 * write extension (pend→approve) → grants → cc-master record-mode content creation
 * → write into Obsidian → audit review → revoke proof. Hermetic + repeatable; never
 * binds :7077, never needs a real `claude` or a real Obsidian app.
 */

import { runScenario, consoleLogger } from "./scenario.ts";

const report = await runScenario({ logger: consoleLogger() });

console.log("\n────────────────────────────────────────────────────────────────────────");
console.log("EVIDENCE SUMMARY (the genuine facts)");
console.log("────────────────────────────────────────────────────────────────────────");
console.log(`session id            : ${report.sessionId}`);
console.log(`temp PLEXUS_HOME      : ${report.plexusHome}`);
console.log(`temp Obsidian vault   : ${report.vaultPath}`);
console.log(`registered write caps : ${report.registeredWriteCaps.join(", ")}`);
console.log(`granted capabilities  : ${report.grantedCaps.join(", ")}`);
console.log(`written note          : ${report.written.path}`);
console.log("written content       :");
for (const ln of report.written.content.split("\n")) console.log(`    ${ln}`);
console.log(`read-back matches     : ${report.readBack === report.written.content}`);

console.log("\ncc-master dispatch (record-mode, NO real claude spawn):");
console.log(`    agentExecution : ${report.ccDispatch.agentExecution}`);
console.log(`    launched       : ${report.ccDispatch.launched}`);
console.log(`    boardId        : ${report.ccDispatch.boardId}`);
console.log(`    dispatchedNode : ${report.ccDispatch.dispatchedNode}`);
console.log(`    argv           : ${JSON.stringify(report.ccDispatch.argv)}`);

console.log("\nAUDIT CHAIN (oldest → newest):");
report.auditSummary.forEach((s, i) => console.log(`   ${String(i + 1).padStart(2, " ")}. ${s}`));

console.log("\nREVOKE PROOF:");
console.log(`    re-invoke after revoke → HTTP ${report.revokeDenial.status}, code "${report.revokeDenial.code}"`);

console.log("\nNEGATIVE-AUTHZ BEATS (deny-path probes through the live pipeline — misuse must FAIL):");
for (const b of report.negativeAuthz) {
  const mark = b.ok ? "✓" : "✗";
  console.log(`    ${mark} «${b.label}»`);
  console.log(`        attempt : ${b.attempt}`);
  console.log(`        outcome : HTTP ${b.status}, code "${b.code}" (expected "${b.expectedCode}") ⇒ ${b.ok ? "DENIED as expected" : "UNEXPECTED"}`);
}

console.log("\nAUTHORED EXTENSION MANIFEST (what the codex agent wrote):");
console.log(JSON.stringify(report.authoredManifest, null, 2));

console.log("\n────────────────────────────────────────────────────────────────────────");
const passed = report.checks.filter((c) => c.ok).length;
console.log(
  report.pass
    ? `OVERALL VERDICT: ✓ PASS — all ${report.checks.length} checks green. The 玩法 works end-to-end.`
    : `OVERALL VERDICT: ✗ FAIL — ${report.checks.length - passed}/${report.checks.length} checks failed.`,
);
console.log("────────────────────────────────────────────────────────────────────────");

process.exit(report.pass ? 0 : 1);
