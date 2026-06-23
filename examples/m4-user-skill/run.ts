/**
 * ============================================================================
 * M4 USER CUSTOM-SKILL — runnable worked path (end-to-end).
 * ============================================================================
 *
 *   bun run examples/m4-user-skill/run.ts
 *
 * THE PROOF: a user attaches their OWN usage skills (`kind:"skill"`) to
 * capabilities so an AGENT discovers them as context — through the REAL gateway,
 * driven by the published wire (`.well-known` → handshake → manifest) with the
 * t12 `PlexusClient`. Boots a real `Bun.serve` socket on a free loopback port.
 *
 * Shows, honestly, BOTH attach shapes (USER-AUTHORING-DESIGN §A.3):
 *
 *   (a) SAME-SOURCE — a skill attached to the author's OWN capability
 *       (`ezskills.snippets.read` ↔ `ezskills.snippets.how-to-search`), applied
 *       FREELY. Discoverable: the back-link + the skill body both reach the agent.
 *
 *   (b) CROSS-SOURCE — a skill attaching onto an EXISTING first-party capability
 *       (`obsidian.vault.read`). DEFAULT-OFF:
 *         · the agent's pure-wire `POST /extensions` register is REJECTED (no
 *           opt-in, no human) — the denial is REAL, asserted below;
 *         · the management user opts in (`allowCrossSource:true`) + approves —
 *           modeling the human's deliberate consent — and only THEN does the skill
 *           attach, PROVENANCE-STAMPED (`extras.attachedSkillProvenance`) so it is
 *           distinguishable from a first-party describe.
 *
 * Nothing is staged. Exits 0 iff every check passes.
 */

import { runUserSkillDemo } from "./demo.ts";

const report = await runUserSkillDemo({ verbose: true });

console.log("");
console.log(report.overall ? "── PASS ── user custom-skill worked path is green." : "── FAIL ──");
for (const c of report.checks) {
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
}

process.exit(report.overall ? 0 : 1);
