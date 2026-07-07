/**
 * Capability-Appliance MANIFEST parser/validator tests.
 *
 * The appliance's whole security claim is "expose a capability, not a system": the manifest
 * is the curated allowlist and EVERYTHING unlisted is default-denied. These tests pin that:
 *   - a manifest exposing only `workspace` yields EXACTLY the workspace caps exposed;
 *   - an unlisted source / unlisted cap under a curated source is DENIED;
 *   - a malformed manifest is REJECTED (fail-closed, with reasons).
 */

import { describe, it, expect } from "bun:test";
import {
  parseApplianceManifest,
  validateApplianceManifest,
  isCapabilityExposed,
  manifestToEnv,
  curatedSourceIds,
  matchCapabilityGlob,
  ApplianceManifestError,
  APPLIANCE_MANIFEST_VERSION,
} from "@plexus/runtime/appliance/manifest.ts";

// The advertised workspace capability ids (mirrors sources/workspace/entries.ts).
const WORKSPACE_CAPS = ["workspace.list", "workspace.read", "workspace.write", "workspace.how-to-use"];
// A representative non-curated first-party capability (sysinfo is the other Linux-portable source).
const SYSINFO_CAP = "sysinfo.processes.list";

function workspaceOnlyManifest() {
  return parseApplianceManifest(
    JSON.stringify({
      version: 1,
      instance: "appliance-demo",
      workload: "appliance-box",
      sources: [{ source: "workspace", path: "/data/exposed" }],
    }),
  );
}

describe("appliance manifest — exposing only `workspace`", () => {
  it("yields EXACTLY the workspace capabilities exposed, nothing else", () => {
    const m = workspaceOnlyManifest();

    // Every workspace cap is exposed.
    for (const id of WORKSPACE_CAPS) {
      expect(isCapabilityExposed(m, { source: "workspace", id })).toBe(true);
    }

    // A capability from an UNLISTED source is denied — even though sysinfo is the other
    // Linux-portable source, it was not curated, so it is invisible.
    expect(isCapabilityExposed(m, { source: "sysinfo", id: SYSINFO_CAP })).toBe(false);

    // The curated-source set is exactly {workspace}.
    expect([...curatedSourceIds(m)]).toEqual(["workspace"]);
  });

  it("translates to the stock env contract (PLEXUS_WORKSPACE_DIR + identity, no proxy)", () => {
    const env = manifestToEnv(workspaceOnlyManifest());
    expect(env.PLEXUS_WORKSPACE_DIR).toBe("/data/exposed");
    expect(env.PLEXUS_INSTANCE).toBe("appliance-demo");
    expect(env.PLEXUS_WORKLOAD).toBe("appliance-box");
    expect(env.PLEXUS_MODE).toBeUndefined(); // standalone primary (no upstream)
  });
});

describe("appliance manifest — per-capability allowlist (glob)", () => {
  it("exposes only globbed caps under a curated source; siblings denied", () => {
    const m = parseApplianceManifest(
      JSON.stringify({
        version: 1,
        sources: [{ source: "workspace", capabilities: ["workspace.read", "workspace.list"] }],
      }),
    );
    expect(isCapabilityExposed(m, { source: "workspace", id: "workspace.read" })).toBe(true);
    expect(isCapabilityExposed(m, { source: "workspace", id: "workspace.list" })).toBe(true);
    // WRITE is not listed → denied even though its source IS curated (read-only appliance).
    expect(isCapabilityExposed(m, { source: "workspace", id: "workspace.write" })).toBe(false);
  });

  it("supports `*` globs", () => {
    expect(matchCapabilityGlob("workspace.*", "workspace.read")).toBe(true);
    expect(matchCapabilityGlob("workspace.*", "sysinfo.log.read")).toBe(false);
    expect(matchCapabilityGlob("workspace.read", "workspace.read")).toBe(true);
    expect(matchCapabilityGlob("workspace.read", "workspace.write")).toBe(false);
  });
});

describe("appliance manifest — mesh proxy upstream", () => {
  it("translates upstream into proxy env (pinned pubkey mandatory)", () => {
    const m = parseApplianceManifest(
      JSON.stringify({
        version: 1,
        sources: [{ source: "workspace", path: "/data/exposed" }],
        upstream: { url: "wss://primary:8443", pubkey: "ed25519-abc" },
      }),
    );
    const env = manifestToEnv(m);
    expect(env.PLEXUS_MODE).toBe("proxy");
    expect(env.PLEXUS_UPSTREAM_URL).toBe("wss://primary:8443");
    expect(env.PLEXUS_UPSTREAM_PUBKEY).toBe("ed25519-abc");
  });

  it("rejects an upstream missing its pinned pubkey (no bare-TOFU)", () => {
    expect(() =>
      parseApplianceManifest(
        JSON.stringify({
          version: 1,
          sources: [{ source: "workspace" }],
          upstream: { url: "wss://primary:8443" },
        }),
      ),
    ).toThrow(ApplianceManifestError);
  });
});

describe("appliance manifest — malformed inputs are rejected (fail-closed)", () => {
  it("rejects non-JSON", () => {
    expect(() => parseApplianceManifest("{not json")).toThrow(ApplianceManifestError);
  });

  it("rejects a wrong/absent version", () => {
    expect(() => validateApplianceManifest({ sources: [{ source: "workspace" }] })).toThrow(
      ApplianceManifestError,
    );
    expect(() => validateApplianceManifest({ version: 2, sources: [{ source: "workspace" }] })).toThrow(
      ApplianceManifestError,
    );
  });

  it("rejects an empty / missing sources list (an appliance must expose something)", () => {
    expect(() => validateApplianceManifest({ version: 1, sources: [] })).toThrow(ApplianceManifestError);
    expect(() => validateApplianceManifest({ version: 1 })).toThrow(ApplianceManifestError);
  });

  it("rejects a source with no id and a non-string capabilities list", () => {
    expect(() => validateApplianceManifest({ version: 1, sources: [{ path: "/data" }] })).toThrow(
      ApplianceManifestError,
    );
    expect(() =>
      validateApplianceManifest({ version: 1, sources: [{ source: "workspace", capabilities: [1, 2] }] }),
    ).toThrow(ApplianceManifestError);
  });

  it("collects ALL reasons on the thrown error", () => {
    try {
      validateApplianceManifest({ version: 9, sources: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApplianceManifestError);
      const err = e as ApplianceManifestError;
      expect(err.errors.length).toBeGreaterThanOrEqual(2); // bad version + empty sources
    }
  });

  it("exposes the schema version constant for callers", () => {
    expect(APPLIANCE_MANIFEST_VERSION).toBe(1);
  });
});

describe("appliance manifest — strict unknown-field rejection (typo ⇒ no silent allowlist bypass)", () => {
  it("rejects an unknown TOP-LEVEL field", () => {
    expect(() =>
      validateApplianceManifest({ version: 1, sources: [{ source: "workspace" }], sourcse: [] }),
    ).toThrow(ApplianceManifestError);
  });

  it("rejects a typo'd `capabilites` (would otherwise expose the WHOLE source)", () => {
    // The dangerous case: `capabilities` stays undefined ⇒ match-all. Strict rejection
    // turns the typo into a loud error instead of a silent expose-everything.
    let err: ApplianceManifestError | undefined;
    try {
      validateApplianceManifest({
        version: 1,
        sources: [{ source: "workspace", capabilites: ["workspace.read"] }],
      });
    } catch (e) {
      err = e as ApplianceManifestError;
    }
    expect(err).toBeInstanceOf(ApplianceManifestError);
    expect(err!.errors.some((m) => m.includes("capabilites"))).toBe(true);
  });

  it("still accepts a correctly-spelled manifest", () => {
    expect(() =>
      validateApplianceManifest({
        version: 1,
        sources: [{ source: "workspace", capabilities: ["workspace.read"], path: "/data/exposed" }],
        upstream: { url: "wss://primary:8443", pubkey: "ed25519-abc" },
      }),
    ).not.toThrow();
  });
});

describe("appliance manifest — a source `path` may not point at gateway-private state", () => {
  for (const bad of ["/state", "/state/exposure.json", "/app", "/app/packages", "/etc/plexus"]) {
    it(`rejects path ${JSON.stringify(bad)} (would expose connection-key / signing secret / mesh identity)`, () => {
      let err: ApplianceManifestError | undefined;
      try {
        validateApplianceManifest({ version: 1, sources: [{ source: "workspace", path: bad }] });
      } catch (e) {
        err = e as ApplianceManifestError;
      }
      expect(err).toBeInstanceOf(ApplianceManifestError);
      expect(err!.errors.some((m) => m.includes("sensitive container dir"))).toBe(true);
    });
  }

  it("accepts a separate data dir", () => {
    expect(() =>
      validateApplianceManifest({ version: 1, sources: [{ source: "workspace", path: "/data/exposed" }] }),
    ).not.toThrow();
  });
});
