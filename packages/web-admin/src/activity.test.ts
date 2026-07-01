/**
 * Focused unit test for the Activity tab's initial agent-filter seam — the pure helper
 * that decides whether a "Recent activity →" jump pre-selects an agent or the tab lands
 * unfiltered. No DOM: we test the pure function, not the React render.
 */
import { describe, it, expect } from "bun:test";
import { initialAgentFilter } from "./nav.ts";

describe("initialAgentFilter — Activity tab initial agent filter", () => {
  it("pre-selects a threaded agent id (the 'Recent activity →' jump)", () => {
    expect(initialAgentFilter("research-bot")).toBe("research-bot");
  });

  it("falls back to the 'all' sentinel when nothing is pending (plain top-nav visit)", () => {
    expect(initialAgentFilter(null)).toBe("all");
    expect(initialAgentFilter(undefined)).toBe("all");
  });

  it("treats a blank / whitespace-only pending id as unfiltered", () => {
    expect(initialAgentFilter("")).toBe("all");
    expect(initialAgentFilter("   ")).toBe("all");
  });
});
