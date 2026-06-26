/**
 * ============================================================================
 * M4 CAPSTONE — the unified acceptance transcript (one consolidated verdict).
 * ============================================================================
 *
 *   bun run tests/harnesses/m4-demo/run.ts
 *
 * Runs the M4 CAPSTONE headline loop (meta-skill scaffold → register → agent USES
 * it, returning REAL backend data), THEN drives the two existing M4 example engines
 * (user custom-skill attach; user dynamic-workflow compose→invoke), and prints ONE
 * consolidated M4 PASS/FAIL verdict covering all three M4 feature tracks plus a
 * security spot-check. Exits 0 iff every track passes.
 *
 * The three M4 deliverables proven here:
 *   • meta-skill scaffold→use     — tests/harnesses/m4-demo (the headline loop, this dir)
 *   • user custom-skill attach     — tests/harnesses/m4-user-skill (same + cross-source-gated)
 *   • user dynamic-workflow         — tests/harnesses/m4-user-workflow (compose → invoke)
 *
 * Plus a SECURITY SPOT-CHECK: the meta-skill generator REFUSES to scaffold an
 * over-privileged cli bin and a non-loopback rest host (they would need explicit
 * human approval / are rejected by construction), and an un-approved register stays
 * inert (proven inside the headline loop).
 */

import { runHeadline } from "./headline.ts";
import { runSecuritySpotCheck } from "./security.ts";
import { consoleLogger, type CheckResult } from "./report.ts";

import { runUserSkillDemo } from "../m4-user-skill/demo.ts";
import { runDemo as runUserWorkflowDemo, silentLogger } from "../m4-user-workflow/demo.ts";

interface TrackResult {
  name: string;
  deliverable: string;
  pass: boolean;
  checks: CheckResult[];
}

const log = consoleLogger();

log.line("════════════════════════════════════════════════════════════════════════");
log.line(" M4 CAPSTONE — end-to-end acceptance (scaffold → register → agent uses it)");
log.line("════════════════════════════════════════════════════════════════════════");

// ── Track 1: THE HEADLINE LOOP — meta-skill scaffold → register → agent uses it ──
const headline = await runHeadline({ logger: log });

// ── Track 2: user custom-skill attach (same-source + cross-source-gated) ─────────
log.step("UC-SKILL", "M4 user custom-skill attach (tests/harnesses/m4-user-skill)");
const skill = await runUserSkillDemo({ verbose: false });
log.line(`    user custom-skill worked path: ${skill.overall ? "PASS" : "FAIL"} (${skill.checks.length} checks)`);
for (const c of skill.checks) (c.ok ? log.pass : log.fail).call(log, c.label);

// ── Track 3: user dynamic-workflow compose → invoke ──────────────────────────────
log.step("UC-WORKFLOW", "M4 user dynamic-workflow compose→invoke (tests/harnesses/m4-user-workflow)");
const workflow = await runUserWorkflowDemo({ logger: silentLogger() });
log.line(`    user dynamic-workflow worked path: ${workflow.pass ? "PASS" : "FAIL"} (${workflow.checks.length} checks)`);
for (const c of workflow.checks) (c.ok ? log.pass : log.fail).call(log, c.label);

// ── Security spot-check: generator refuses over-privileged cli / non-loopback host ─
log.step("SECURITY", "spot-check — generator refuses cli/non-loopback; un-approved register inert");
const security = await runSecuritySpotCheck();
for (const c of security.checks) (c.ok ? log.pass : log.fail).call(log, c.label);

// ── consolidated verdict ─────────────────────────────────────────────────────────
const tracks: TrackResult[] = [
  { name: "meta-skill scaffold → use (HEADLINE)", deliverable: "meta-skill (plugins/plexus-ext)", pass: headline.pass, checks: headline.checks },
  { name: "user custom-skill attach (same + cross-source-gated)", deliverable: "user skill (tests/harnesses/m4-user-skill)", pass: skill.overall, checks: skill.checks },
  { name: "user dynamic-workflow compose → invoke", deliverable: "user workflow (tests/harnesses/m4-user-workflow)", pass: workflow.pass, checks: workflow.checks },
  { name: "security spot-check (confined + human-approved)", deliverable: "EXTENSION-SPEC secure defaults", pass: security.pass, checks: security.checks },
];

const overall = tracks.every((t) => t.pass);

log.step("==", "CONSOLIDATED M4 VERDICT");
for (const t of tracks) {
  const n = t.checks.filter((c) => c.ok).length;
  log.line(`${t.pass ? "✓ PASS" : "✗ FAIL"}  ${t.name}  [${n}/${t.checks.length}]  — ${t.deliverable}`);
}
log.line("");
log.line(`HEADLINE real data: agent received "${headline.agentValue}"`);
log.line(`                    backend's own    "${headline.backendValue}"`);
log.line(`                    match: ${headline.agentValue === headline.backendValue ? "YES (honest-green)" : "NO"}`);
log.line("");
log.line(
  overall
    ? "OVERALL M4 VERDICT: ✓ PASS — meta-skill scaffold→use, user custom-skill attach, user dynamic-workflow compose→invoke, all human-approved + confined."
    : "OVERALL M4 VERDICT: ✗ FAIL — see the failing track(s) above.",
);

process.exit(overall ? 0 : 1);
