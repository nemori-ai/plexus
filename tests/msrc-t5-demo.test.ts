/**
 * msrc Task 5 — the no-flag / no-restart managed-sources HOT-RELOAD capstone.
 *
 * Drives the SAME harness the runnable demo prints (`tests/harnesses/msrc-demo/harness.ts`)
 * against ONE booted gateway (throwaway PLEXUS_HOME + a mock Obsidian Local REST
 * endpoint) and asserts the WHOLE live cycle — with NO `--obsidian-rest` flag and
 * WITHOUT restarting:
 *
 *   detect → ADD (capability count goes UP live + persists to sources.json) → an
 *   agent reads + writes through it → RECONFIGURE the baseUrl (the source's GRANTS
 *   are PURGED, so a prior token's durable authority no longer works) → REMOVE
 *   (capability disappears live + from sources.json).
 *
 * The grant-purge is REAL: the persisted write grant is gone after the reconfigure,
 * refreshing the PRE-reconfigure token fails (grant_required), and a fresh write
 * grant must PEND again. Never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll } from "bun:test";

import { runDemo, type DemoResult } from "./harnesses/msrc-demo/harness.ts";

let result: DemoResult;

describe("msrc-t5: managed sources — no flag, no restart (add → use → reconfigure-purge → remove)", () => {
  it("runs the full live cycle against one booted gateway", async () => {
    result = await runDemo({ echo: false });
    expect(result.transcript.length).toBeGreaterThan(0);
  });

  it("ADD hot-appears: the capability count goes UP live (no restart)", () => {
    expect(result.countAfterAdd).toBeGreaterThan(result.countBeforeAdd);
    // the obsidian-rest list/read/write capabilities are now discoverable.
    expect(result.restIdsAfterAdd).toContain("obsidian-rest.vault.read");
    expect(result.restIdsAfterAdd).toContain("obsidian-rest.vault.write");
  });

  it("ADD persists the source to sources.json", () => {
    expect(result.persistedAfterAdd).toBe(true);
  });

  it("an agent reads + writes through the managed source (real round-trip)", () => {
    expect(result.agentRead).toContain("managed REST source");
    expect(result.agentWroteAndReadBack).toBe(true);
  });

  it("RECONFIGURE the baseUrl PURGES the source's grants (security-surface change)", () => {
    expect(result.grantBeforeReconfigure).toBe(true);
    expect(result.grantPurgedByReconfigure).toBe(true);
  });

  it("a PRIOR token no longer works after the reconfigure (durable authority gone)", () => {
    // refreshing the pre-reconfigure token fails (grant_required) — the purge is REAL.
    expect(result.preReconfigureTokenRefreshFails).toBe(true);
    // and a fresh write grant must PEND again (no stale approval carried over).
    expect(result.freshWriteGrantPendsAfterReconfigure).toBe(true);
  });

  it("REMOVE hot-disappears: the capability count drops back live + leaves sources.json", () => {
    expect(result.countAfterRemove).toBe(result.countBeforeAdd);
    expect(result.persistedAfterRemove).toBe(false);
  });
});

afterAll(() => {
  delete process.env.PLEXUS_HOME;
});
