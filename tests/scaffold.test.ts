/**
 * Scaffold sanity: the seams are wired and typed against the frozen contract.
 * Verifies the registry/transport/authorizer SHAPES are real (not the t6/t7 logic).
 */

import { describe, it, expect } from "bun:test";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";
import type { CapabilityEntry } from "@plexus/protocol";

describe("scaffold seams", () => {
  it("selects a PlatformServices impl for the current OS", () => {
    const platform = getPlatformServices();
    expect(["darwin", "win32", "linux"]).toContain(platform.platform);
  });

  it("builds a SourceRegistry with the registered first-party modules and a total transport map", () => {
    const registry = createSourceRegistry(getPlatformServices());
    // M0 shipped an empty MODULES set; first-party adapters are now registered, so
    // the registry exposes them. The SHAPE is what this test guards: every module is
    // well-formed and the transport map is total.
    const ids = registry.all().map((m) => m.id);
    expect(ids).toContain("claudecode");
    for (const m of registry.all()) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.createSource).toBe("function");
      expect(typeof m.createBridge).toBe("function");
    }
    for (const kind of ["local-rest", "stdio", "ipc", "mcp", "cli", "skill", "workflow"] as const) {
      expect(registry.getTransport(kind).kind).toBe(kind);
    }
  });

  it("AutoApproveAuthorizer (v1 stub) allows the requested verbs", async () => {
    const authz = new AutoApproveAuthorizer();
    expect(authz.policy).toBe("auto-approve");
    const entry: CapabilityEntry = {
      id: "demo.thing.read",
      source: "demo",
      kind: "capability",
      label: "Demo",
      describe: "A demo capability.",
      grants: ["read"],
      transport: "cli",
    };
    const decision = await authz.authorize({
      sessionId: "s1",
      entry,
      requestedVerbs: ["read"],
      hasPriorApproval: false,
    });
    expect(decision.outcome).toBe("allow");
    expect(decision.verbs).toEqual(["read"]);
  });
});
