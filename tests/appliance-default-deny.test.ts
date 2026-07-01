/**
 * Capability-Appliance STANDING DEFAULT-DENY regression test.
 *
 * THE BUG THIS PINS: the appliance boot wrapper used to enforce curation with a ONE-SHOT
 * loop — walk `capabilities.all()` once after boot and `setEnabled(id,false)` on each
 * non-curated cap. Because the exposure store DEFAULTS TO ENABLED for local sources, any
 * capability that enters the registry AFTER that snapshot (a boot scan finishing after the
 * bounded window, an agent `POST /extensions`, an MCP `list_changed` re-aggregate) was
 * NEVER disabled → exposed + invokable, bypassing the manifest allowlist.
 *
 * THE FIX (mirrored here exactly as `boot.ts` installs it): a STANDING per-id default-exposure
 * RESOLVER on the public `ExposureStore.setDefaultResolver` seam. Every id whose `{source,id}`
 * the manifest does not name defaults HIDDEN — now AND for any cap that appears later. This
 * test proves the standing property: a cap registered AFTER the resolver is installed (never
 * enumerated, never `setEnabled`'d) is STILL denied. The old one-shot loop could not catch it.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEntry, CapabilityId, SourceId } from "@plexus/protocol";
import {
  parseApplianceManifest,
  isCapabilityExposed,
  type ApplianceManifest,
} from "@plexus/runtime/appliance/manifest.ts";

// Point the (file-backed) exposure store at a throwaway dir so the test never touches ~/.plexus.
beforeAll(() => {
  process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), "plexus-appliance-deny-"));
});

/** A minimal stand-in for the live capability registry: `get(id)` returns the entry IF present.
 *  Entries can be added AFTER the resolver is installed — that is the post-boot leak vector. */
function fakeRegistry() {
  const entries = new Map<CapabilityId, CapabilityEntry>();
  return {
    add(source: SourceId, id: CapabilityId) {
      entries.set(id, { id, source } as CapabilityEntry);
    },
    get(id: CapabilityId): CapabilityEntry | undefined {
      return entries.get(id);
    },
  };
}

/** The EXACT resolver `boot.ts` installs: non-curated `{source,id}` (or an unknown id) → hidden. */
function applianceResolver(manifest: ApplianceManifest, registry: ReturnType<typeof fakeRegistry>) {
  return (id: CapabilityId): "hidden" | undefined => {
    const entry = registry.get(id);
    if (!entry) return "hidden";
    return isCapabilityExposed(manifest, { source: entry.source, id: entry.id }) ? undefined : "hidden";
  };
}

const workspaceOnly = () =>
  parseApplianceManifest(
    JSON.stringify({ version: 1, sources: [{ source: "workspace", path: "/data/exposed" }] }),
  );

describe("appliance default-deny — STANDING resolver, not a one-shot snapshot", () => {
  it("denies a capability that is registered AFTER the resolver is installed", async () => {
    const { createExposureStore } = await import("@plexus/runtime/core/exposure.ts");
    const manifest = workspaceOnly();
    const registry = fakeRegistry();

    // At "boot": only the curated workspace cap is present.
    registry.add("workspace", "workspace.read");

    const exposure = createExposureStore();
    exposure.setDefaultResolver(applianceResolver(manifest, registry));

    // Curated cap is exposed.
    expect(exposure.isDisabled("workspace.read")).toBe(false);

    // ── POST-BOOT LEAK VECTOR ──────────────────────────────────────────────────────
    // A non-curated cap lands in the registry AFTER the resolver was installed (scan race /
    // POST /extensions / list_changed). It was NEVER enumerated or `setEnabled`'d — the old
    // one-shot loop could not have touched it. The STANDING resolver still hides it.
    registry.add("cc-master", "cc-master.orchestrate");
    expect(exposure.isDisabled("cc-master.orchestrate")).toBe(true);

    // An id not in the registry at all is fail-closed HIDDEN too.
    expect(exposure.isDisabled("ghost.cap")).toBe(true);
  });

  it("hides a sibling cap denied by a per-capability glob filter, even if added later", async () => {
    const { createExposureStore } = await import("@plexus/runtime/core/exposure.ts");
    const manifest = parseApplianceManifest(
      JSON.stringify({ version: 1, sources: [{ source: "workspace", capabilities: ["workspace.read"] }] }),
    );
    const registry = fakeRegistry();
    const exposure = createExposureStore();
    exposure.setDefaultResolver(applianceResolver(manifest, registry));

    registry.add("workspace", "workspace.read");
    registry.add("workspace", "workspace.write"); // curated SOURCE, but write not in the glob

    expect(exposure.isDisabled("workspace.read")).toBe(false); // allowed
    expect(exposure.isDisabled("workspace.write")).toBe(true); // denied (read-only appliance)
  });

  it("resolver returns `undefined` for curated and `\"hidden\"` for non-curated (decision shape)", () => {
    const manifest = workspaceOnly();
    const registry = fakeRegistry();
    registry.add("workspace", "workspace.read");
    registry.add("cc-master", "cc-master.orchestrate");
    const resolver = applianceResolver(manifest, registry);

    expect(resolver("workspace.read")).toBeUndefined(); // curated → keep built-in default (enabled)
    expect(resolver("cc-master.orchestrate")).toBe("hidden"); // non-curated → standing deny
    expect(resolver("never-seen")).toBe("hidden"); // fail-closed
  });
});
