/**
 * m4wf — the workflow REGISTER-TIME GUARDS, asserted directly against the registry's
 * validate-vs-commit seam (`validateRegistration`) over the user-authored manifests.
 *
 * This is the tight, no-network complement to the e2e worked path: it proves the
 * guards are REAL register-time rejections (not demo bookkeeping), and that the VALID
 * composition validates cleanly. `validateRegistration` is PURE (no commit), exactly
 * what the human-confirm seam calls to build the reject reasons before committing.
 */

import { describe, it, expect } from "bun:test";
import type { SourceModule, SourceRegistry, Transport, TransportKind } from "@plexus/protocol";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import {
  journalWorkflowManifest,
  danglingMemberManifest,
  cyclicWorkflowManifest,
  WORKFLOW_ID,
  APPEND_ID,
  LIST_ID,
} from "../examples/m4-user-workflow/manifest.ts";

/** A minimal real SourceRegistry over an empty compile-time module set. */
function emptyRegistry(): SourceRegistry {
  const byId = new Map<string, SourceModule>();
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

// A loopback base the local-rest members point at — never dialed in a validate-only pass.
const BASE = "http://127.0.0.1:9";

describe("m4wf — register-time workflow guards (validateRegistration, pure)", () => {
  it("a VALID composition validates cleanly (members co-declared, present, acyclic)", () => {
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(journalWorkflowManifest(BASE));
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    // The workflow + its two members are all in the same source — no cross-source provenance.
    expect(Object.keys(verdict.crossSourceProvenance)).toEqual([]);
  });

  it("a DANGLING member is REJECTED — the phantom id has no transitive-grant target", () => {
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(danglingMemberManifest(BASE));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("journal.entry.delete"))).toBe(true);
    expect(verdict.reasons.some((r) => r.toLowerCase().includes("dangling"))).toBe(true);
  });

  it("a CYCLE (A→B→A) is REJECTED — the fan-out would recurse unbounded", () => {
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(cyclicWorkflowManifest(BASE));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("a dangling-member register actually COMMITS NOTHING (default-deny at the commit boundary)", async () => {
    const registry = createCapabilityRegistry(emptyRegistry());
    const res = await registry.registerExtension(danglingMemberManifest(BASE));
    expect(res.ok).toBe(false);
    expect(res.registered).toEqual([]);
    // Neither the workflow nor its present member leaked into the registry.
    expect(registry.getEntry(WORKFLOW_ID)).toBeUndefined();
    expect(registry.getEntry(APPEND_ID)).toBeUndefined();
    expect(registry.getEntry(LIST_ID)).toBeUndefined();
  });
});
