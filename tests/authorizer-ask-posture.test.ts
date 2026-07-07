/**
 * UserConfirmAuthorizer × per-instance `approval:"ask"` (the askSources provider).
 *
 * Unit-pins the policy seam the workspace-dir e2e exercises end-to-end:
 *   - a READ on an ask-posture managed source PENDS (would auto-allow otherwise);
 *   - a WRITE on it still pends (the pre-existing rule — ask adds nothing there);
 *   - a prior human-approved STANDING grant still short-circuits (ask ≠ re-prompt);
 *   - "ask" NEVER relaxes: confirm-all still pends everything, extension provenance
 *     still pends, a non-ask managed sibling keeps its read auto-allow;
 *   - the LIVE provider is consulted per decision (flipping posture flips behavior
 *     without rebuilding the authorizer — the reconfigure path).
 */

import { describe, it, expect } from "bun:test";

import type { CapabilityEntry, SourceId } from "@plexus/protocol";
import { UserConfirmAuthorizer } from "@plexus/runtime/auth/authorizer.ts";

function readCap(source: string): CapabilityEntry {
  return {
    id: `${source}.read`,
    source,
    kind: "capability",
    label: "read",
    describe: "read a file from the managed directory source (test double)",
    grants: ["read"],
    transport: "ipc",
  };
}

function writeCap(source: string): CapabilityEntry {
  return { ...readCap(source), id: `${source}.write`, grants: ["write"] };
}

const MANAGED = new Set<SourceId>(["docs-auto", "docs-ask"]);

function makeAuthorizer(ask: Set<SourceId>, mode?: "confirm-all") {
  return new UserConfirmAuthorizer({
    ...(mode ? { mode } : {}),
    managedSources: () => MANAGED,
    askSources: () => ask,
  });
}

const BASE = {
  sessionId: "s1",
  agentId: "agent-1",
  requestedVerbs: ["read"] as ["read"],
  hasPriorApproval: false,
};

describe("askSources: read pends on the ask instance, auto-allows on the sibling", () => {
  it("read on approval:'ask' source → pending (with the protected reason)", async () => {
    const az = makeAuthorizer(new Set(["docs-ask"]));
    const d = await az.authorize({ ...BASE, entry: readCap("docs-ask") });
    expect(d.outcome).toBe("pending");
    expect(d.reason).toContain("protected");
    expect(d.reason).toContain("docs-ask");
  });

  it("read on the non-ask managed sibling → auto-allow (posture is per-instance)", async () => {
    const az = makeAuthorizer(new Set(["docs-ask"]));
    const d = await az.authorize({ ...BASE, entry: readCap("docs-auto") });
    expect(d.outcome).toBe("allow");
  });

  it("write on the ask source pends via the PRE-EXISTING write rule (ask adds nothing looser)", async () => {
    const az = makeAuthorizer(new Set(["docs-ask"]));
    const d = await az.authorize({
      ...BASE,
      requestedVerbs: ["write"],
      entry: writeCap("docs-ask"),
    });
    expect(d.outcome).toBe("pending");
    // The mutating-grant rule fires FIRST — ask never softens/replaces a stricter reason.
    expect(d.reason).toContain("mutating");
  });
});

describe("askSources only TIGHTENS — every stricter check is untouched", () => {
  it("a prior human-approved STANDING grant still short-circuits (no re-prompt)", async () => {
    const az = makeAuthorizer(new Set(["docs-ask"]));
    const d = await az.authorize({
      ...BASE,
      entry: readCap("docs-ask"),
      hasPriorApproval: true,
    });
    expect(d.outcome).toBe("allow");
  });

  it("confirm-all mode still pends everything (ask cannot create an allow path)", async () => {
    const az = makeAuthorizer(new Set<SourceId>(), "confirm-all");
    const d = await az.authorize({ ...BASE, entry: readCap("docs-auto") });
    expect(d.outcome).toBe("pending");
  });

  it("an extension-sourced read still pends regardless of the ask set", async () => {
    const az = makeAuthorizer(new Set<SourceId>());
    const d = await az.authorize({ ...BASE, entry: readCap("some-extension") });
    expect(d.outcome).toBe("pending");
    expect(d.reason).toContain("extension-sourced");
  });

  it("a revocation tombstone still pends even on a non-ask source", async () => {
    const az = makeAuthorizer(new Set<SourceId>());
    const d = await az.authorize({
      ...BASE,
      entry: readCap("docs-auto"),
      revokedTombstone: true,
    });
    expect(d.outcome).toBe("pending");
    expect(d.reason).toContain("tombstone");
  });
});

describe("askSources is a LIVE provider (reconfigure flips behavior in place)", () => {
  it("flipping the set flips the decision without rebuilding the authorizer", async () => {
    const live = new Set<SourceId>();
    const az = makeAuthorizer(live);

    expect((await az.authorize({ ...BASE, entry: readCap("docs-auto") })).outcome).toBe("allow");
    live.add("docs-auto"); // owner reconfigures approval:"ask"
    expect((await az.authorize({ ...BASE, entry: readCap("docs-auto") })).outcome).toBe("pending");
    live.delete("docs-auto"); // …and back to auto
    expect((await az.authorize({ ...BASE, entry: readCap("docs-auto") })).outcome).toBe("allow");
  });
});
