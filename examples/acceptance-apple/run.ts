/**
 * Runnable acceptance玩法 — prints the whole story as a step-by-step transcript.
 *
 *   bun run examples/acceptance-apple/run.ts
 *
 * Boots a REAL Plexus gateway in-process over a temp PLEXUS_HOME with the FAKE Apple
 * providers (`PLEXUS_FAKE_APPLE=1`), plays the codex agent through discover → handshake
 * → grants (read auto-approves, writes pend→user approves) → the dispatched daily-review
 * task (list today's events → create a follow-up reminder + a Things to-do → verify both
 * writes landed) → audit review → revoke proof. Hermetic + repeatable; never binds :7077,
 * never touches real macOS / TCC / network.
 */

import { runScenario, consoleLogger } from "./scenario.ts";

const report = await runScenario({ logger: consoleLogger() });

console.log("\n────────────────────────────────────────────────────────────────────────");
console.log("EVIDENCE SUMMARY (the genuine facts)");
console.log("────────────────────────────────────────────────────────────────────────");
console.log(`registered agent      : ${report.agent.name} (${report.agent.agentId}), session ${report.sessionId}`);
console.log(`temp PLEXUS_HOME      : ${report.plexusHome}`);

console.log("\nDISCOVERED Apple capabilities (.well-known — first-party + health):");
for (const d of report.discovered) {
  console.log(`    • ${d.id.padEnd(34)} provenance=${d.provenance}  health=${d.health}  grants=[${d.grants.join(",")}]`);
}

console.log("\nGRANT FLOW (read auto-approves; first-party-elevated writes PEND → user approves):");
for (const g of report.grantFlow) {
  console.log(`    • ${g.id.padEnd(34)} → ${g.pended ? "PENDED → user approved" : "auto-approved (first-party read)"}`);
}

console.log(`\nTASK DISPATCHED:\n    "${report.task}"`);

console.log("\nTODAY'S CALENDAR (apple-calendar.events.list):");
for (const e of report.seenEvents) {
  console.log(`    • ${e.title}  [${e.calendar}]  ${e.start} → ${e.end}`);
}
console.log(`\ncodex composed follow-up subject: "${report.followUpSubject}"`);
console.log("\nCOMPLETION (the writes codex performed + verified):");
console.log(`    reminder created : "${report.createdReminder.title}"  (list ${report.createdReminder.list}, id ${report.createdReminder.id})`);
console.log(`      verified in reminders.list : ${report.reminderVerifiedInList}`);
console.log(`    to-do added      : "${report.createdTodo.title}"`);
console.log(`      url            : ${report.createdTodo.url}`);
console.log(`      verified in todos.list     : ${report.createdTodo.verifiedInList}`);

console.log("\nAUDIT CHAIN (oldest → newest):");
report.auditSummary.forEach((s, i) => console.log(`   ${String(i + 1).padStart(2, " ")}. ${s}`));

console.log("\nREVOKE PROOF:");
console.log(`    revoke reminders-write grant → re-invoke with OLD token → HTTP ${report.revokeDenial.status}, code "${report.revokeDenial.code}"`);
console.log(`    calendar read still works after revoke : ${report.readStillWorksAfterRevoke}`);

console.log("\n────────────────────────────────────────────────────────────────────────");
const passed = report.checks.filter((c) => c.ok).length;
console.log(
  report.pass
    ? `OVERALL VERDICT: ✓ PASS — all ${report.checks.length} checks green. The Apple-sources 玩法 works end-to-end.`
    : `OVERALL VERDICT: ✗ FAIL — ${report.checks.length - passed}/${report.checks.length} checks failed.`,
);
console.log("────────────────────────────────────────────────────────────────────────");

process.exit(report.pass ? 0 : 1);
