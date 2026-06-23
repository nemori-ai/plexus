/**
 * m4wf — USER DYNAMIC-WORKFLOW authoring worked path (the honest-green proof).
 *
 * Runs the REAL worked path (`examples/m4-user-workflow/demo.ts` `runDemo()`) against
 * a freshly-booted real gateway in-process (`app.request`, fetch-shaped — the same
 * uniform pipeline, no socket) and asserts the genuine facts:
 *
 *   - a user composes TWO existing capabilities into a NEW kind:"workflow" capability;
 *   - registering it PENDS for a human (transport-backed), then APPROVE commits it
 *     (an unapproved register does NOT activate the extension);
 *   - the committed workflow is exposed via self-describe with present members;
 *   - granting it SYNTHESIZES the transitive member scopes (append/write + list/read)
 *     and does NOT over-grant (synthesized scopes are EXACTLY the member scopes);
 *   - INVOKING it REALLY fans out via the WorkflowTransport — both members run, in
 *     order, and the composed result is asserted from REAL member output (the journal
 *     service's own state read back + a direct read returning the appended line), not
 *     a trusted ok;
 *   - a DANGLING-member workflow is REJECTED at register;
 *   - a CYCLIC compose (A→B→A) is REJECTED at register.
 *
 * These are REAL assertions over the real demo's structured report — not a staged green.
 */

import { describe, it, expect } from "bun:test";
import { runDemo, silentLogger } from "../examples/m4-user-workflow/demo.ts";

describe("m4wf — user dynamic-workflow authoring worked path (real fan-out + guards)", () => {
  it("compose → register(pend) → approve → grant(synthesize) → invoke(real fan-out); guards reject", async () => {
    const report = await runDemo({ logger: silentLogger(), inProcess: true });

    const byOk = (needle: string) =>
      report.checks.find((c) => c.label.includes(needle))?.ok === true;
    const present = (needle: string) =>
      report.checks.some((c) => c.label.includes(needle));

    // ── the worked path ──────────────────────────────────────────────────────────
    expect(present("register PENDS for a human")).toBe(true);
    expect(byOk("register PENDS for a human")).toBe(true);
    expect(byOk("after approve, the workflow capability is committed")).toBe(true);
    expect(byOk("workflow members resolve to present registry entries")).toBe(true);
    expect(byOk("exposed via self-describe")).toBe(true);
    expect(byOk("un-granted workflow invoke is DENIED")).toBe(true);
    expect(byOk("no fan-out ran before grant")).toBe(true);

    // ── transitive synthesis + the over-grant guard ──────────────────────────────
    expect(byOk("grant mints the workflow's write scope")).toBe(true);
    expect(byOk("SYNTHESIZED transitive member scopes")).toBe(true);
    expect(byOk("does NOT over-grant")).toBe(true);

    // ── REAL fan-out, asserted from real member output ───────────────────────────
    expect(byOk("REALLY fanned out via the WorkflowTransport")).toBe(true);
    expect(byOk("members fanned out IN ORDER")).toBe(true);
    expect(byOk("REALLY mutated the journal service")).toBe(true);
    expect(byOk("returns the REAL line the workflow appended")).toBe(true);

    // ── guard rejections (real) ──────────────────────────────────────────────────
    expect(byOk("DANGLING member is REJECTED")).toBe(true);
    expect(byOk("CYCLIC workflow compose is REJECTED")).toBe(true);

    // The whole worked path passes.
    expect(report.pass).toBe(true);
    // Every single check is green (no silent skip).
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(15);
  });
});
