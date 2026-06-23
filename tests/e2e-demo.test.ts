/**
 * t13 — Plexus v1 END-TO-END ACCEPTANCE test.
 *
 * Runs the REAL acceptance demo (`examples/e2e-demo/demo.ts` `runDemo()`) against a
 * freshly-booted real gateway (in-process via `app.request`, which is fetch-shaped —
 * the same uniform pipeline, just no socket) and asserts BOTH v1 acceptance
 * scenarios PASS through the published protocol. These are REAL assertions, not a
 * staged green:
 *
 *   Scenario A (cc-master, first-party):
 *     - the cc-master CC plugin is auto-installed/enabled in a TEMP .claude dir
 *       (NEVER the real ~/.claude) and the second install is idempotent (no-op),
 *     - `cc-master.orchestration.run` is DISCOVERED (.well-known + handshake),
 *     - a grant(execute) mints the workflow scope + the SYNTHESIZED transitive
 *       member scopes (board.create/write, agent.dispatch/execute, board.status/read),
 *     - the granted invoke REALLY routes through the WorkflowTransport and fans out
 *       into member `cc-master.board.create` (the genuine end-to-end fan-out),
 *     - an un-granted invoke is DENIED with grant_required.
 *
 *   Scenario B (Obsidian, user-custom):
 *     - `obsidian.vault.read` is DISCOVERED + self-described + read-only-grantable,
 *     - a granted read returns REAL note content + a real directory listing,
 *     - an un-granted read is DENIED, a path-traversal read is CONFINED, and a WRITE
 *       grant on the read-only capability is NOT minted.
 *
 * The demo cleans up its own temp fixtures + restores env in a `finally`.
 */

import { describe, it, expect } from "bun:test";
import { runDemo, silentLogger } from "../examples/e2e-demo/demo.ts";

describe("t13 — v1 end-to-end acceptance (both scenarios through the real gateway)", () => {
  it("both acceptance scenarios PASS end-to-end", async () => {
    const report = await runDemo({ logger: silentLogger(), inProcess: true });

    // ── Scenario A — cc-master first-party orchestration ──────────────────────
    const a = report.scenarioA;
    const aByOk = (needle: string) =>
      a.checks.find((c) => c.label.includes(needle))?.ok === true;

    expect(aByOk("auto-install enables cc-master")).toBe(true);
    expect(aByOk("second install is idempotent")).toBe(true);
    expect(aByOk("cc-master.orchestration.run discovered")).toBe(true);
    expect(aByOk("full workflow entry with describe + members")).toBe(true);
    expect(aByOk("workflow members resolve to present registry entries")).toBe(true);
    expect(aByOk("un-granted invoke is DENIED with grant_required")).toBe(true);
    expect(aByOk("SYNTHESIZED transitive member scopes")).toBe(true);
    expect(aByOk("REALLY fanned out via the WorkflowTransport")).toBe(true);
    // The whole scenario passes.
    expect(a.pass).toBe(true);

    // ── Scenario B — Obsidian vault read-only ─────────────────────────────────
    const b = report.scenarioB;
    const bByOk = (needle: string) =>
      b.checks.find((c) => c.label.includes(needle))?.ok === true;

    expect(bByOk("obsidian.vault.read discovered")).toBe(true);
    expect(bByOk("self-selects obsidian.vault.read")).toBe(true);
    expect(bByOk("un-granted read is DENIED")).toBe(true);
    expect(bByOk("granted read returns REAL note content")).toBe(true);
    expect(bByOk("lists the vault")).toBe(true);
    expect(bByOk("path-traversal read is CONFINED")).toBe(true);
    expect(bByOk("WRITE grant on the read-only capability is NOT minted")).toBe(true);
    expect(b.pass).toBe(true);

    // ── Overall verdict ───────────────────────────────────────────────────────
    expect(report.overall).toBe(true);
  });
});
