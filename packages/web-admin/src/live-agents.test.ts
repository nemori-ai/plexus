/**
 * Roster narrowing for agent choosers — the fix for "a deleted agent still haunts every
 * filter".
 *
 * The invariant under test is as much about what is NOT done: nothing is deleted, and the
 * narrowing must fail OPEN (show more) rather than closed (hide agents) whenever the roster
 * is unknown, because a chooser that empties itself on a failed fetch reads as "no agents".
 */
import { describe, it, expect } from "bun:test";
import { liveAgentIds, rosterOnly } from "./live-agents.ts";

describe("liveAgentIds — who is still on the roster", () => {
  it("unions the three roster sources the Agents tab composes from", () => {
    const ids = liveAgentIds(
      [{ agentId: "tanka" }],
      [{ agentId: "raven" }],
      [{ agentId: "openclaw" }],
    );
    expect([...ids].sort()).toEqual(["openclaw", "raven", "tanka"]);
  });

  it("dedupes an agent that appears in several sources", () => {
    const ids = liveAgentIds([{ agentId: "tanka" }], [{ agentId: "tanka" }], [{ agentId: "tanka" }]);
    expect(ids.size).toBe(1);
  });

  it("tolerates missing sources and id-less rows", () => {
    expect(liveAgentIds(undefined, undefined, undefined).size).toBe(0);
    expect(liveAgentIds([], [{}, { agentId: "" }], [{}]).size).toBe(0);
  });

  it("keeps a merely-REVOKED agent (its enrollment row is a tombstone, still on the roster)", () => {
    // Only "Revoke & delete" removes the row — a tombstoned agent can be re-issued, so it
    // must stay choosable.
    const ids = liveAgentIds([], [], [{ agentId: "tombstoned" }]);
    expect(ids.has("tombstoned")).toBe(true);
  });
});

describe("rosterOnly — narrowing a chooser without losing data", () => {
  const live = new Set(["tanka", "raven"]);

  it("drops agents that left the roster", () => {
    expect(rosterOnly(["tanka", "probe-cx", "raven"], live)).toEqual(["tanka", "raven"]);
  });

  it("FAILS OPEN while the roster is unknown — never blanks the chooser mid-fetch", () => {
    expect(rosterOnly(["tanka", "probe-cx"], undefined)).toEqual(["tanka", "probe-cx"]);
  });

  it("fails open on an EMPTY roster only when that is genuinely the answer", () => {
    // An empty (but loaded) roster is a real answer: nobody is on it, so nothing is offered.
    expect(rosterOnly(["probe-cx"], new Set())).toEqual([]);
  });

  it("keeps a currently-SELECTED off-roster agent so an existing filter still resolves", () => {
    // A deep link or a selection made before the delete must not snap to another agent's rows.
    expect(rosterOnly(["tanka", "probe-cx"], live, "probe-cx")).toEqual(["tanka", "probe-cx"]);
  });

  it("does not invent an option for a `keep` that never acted", () => {
    expect(rosterOnly(["tanka"], live, "never-existed")).toEqual(["tanka"]);
  });

  it("preserves input order (the chooser's own ordering is not this function's business)", () => {
    expect(rosterOnly(["raven", "tanka"], live)).toEqual(["raven", "tanka"]);
  });
});
