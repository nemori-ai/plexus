/**
 * t13 — Plexus v1 END-TO-END ACCEPTANCE test.
 *
 * Runs the REAL acceptance demo (`tests/harnesses/e2e-demo/demo.ts` `runDemo()`) against a
 * freshly-booted real gateway (in-process via `app.request`, which is fetch-shaped —
 * the same uniform pipeline, just no socket) and asserts the v1 acceptance
 * scenario PASSES through the published protocol. These are REAL assertions, not a
 * staged green:
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
import { runDemo, silentLogger } from "./harnesses/e2e-demo/demo.ts";

describe("t13 — v1 end-to-end acceptance (through the real gateway)", () => {
  it("the acceptance scenario PASSES end-to-end", async () => {
    const report = await runDemo({ logger: silentLogger(), inProcess: true });

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
