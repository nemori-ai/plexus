/**
 * t9 GAP B — `CapabilityRegistry.registerExtension` materializes an
 * `ExtensionManifest` into DISCOVERABLE registry entries (scan / getEntry /
 * summaries / revision), emits a change to subscribers, and surfaces the extension
 * as a runtime `SourceModule` through the shared `SourceRegistry` so the invoke
 * pipeline can route to it.
 */

import { describe, it, expect } from "bun:test";
import type {
  ExtensionManifest,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "../src/protocol/index.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import { getPlatformServices } from "../src/platform/index.ts";

/** A minimal real SourceRegistry over an empty compile-time module set. */
function emptyRegistry(): SourceRegistry {
  const byId = new Map<string, SourceModule>();
  const platform = getPlatformServices();
  void platform;
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const CLI_EXT: ExtensionManifest = {
  manifest: "plexus-extension/0.1",
  source: "my-tool",
  label: "My CLI tool",
  transport: "cli",
  capabilities: [
    {
      name: "files.list",
      kind: "capability",
      label: "List files",
      describe: "List files in a directory. Use to enumerate paths.",
      io: { input: { type: "object", properties: { dir: { type: "string" } } } },
      grants: ["read"],
      transport: "cli",
      route: { bin: "ls", args: ["{dir}"] },
    },
    {
      name: "files.howto",
      kind: "skill",
      label: "How to list files",
      describe: "Usage guidance for my-tool.files.list.",
      grants: [],
      transport: "skill",
      body: { format: "markdown", markdown: "# Files\nPass { dir }." },
    },
  ],
};

describe("registerExtension materializes a manifest into discoverable entries", () => {
  it("registers entries, derives ids, bumps revision, emits a change", async () => {
    const sources = emptyRegistry();
    const registry = createCapabilityRegistry(sources);

    const changes: number[] = [];
    registry.subscribe((c) => changes.push(c.revision));

    const before = registry.revision();
    const res = await registry.registerExtension(CLI_EXT);

    expect(res.ok).toBe(true);
    expect(res.source).toBe("my-tool");
    // ID-DERIVATION RULE: <sourceSlug>.<name>
    expect(res.registered).toContain("my-tool.files.list");
    expect(res.registered).toContain("my-tool.files.howto");
    expect(res.revision).toBeGreaterThan(before);

    // Discoverable via getEntry / all / summaries.
    const entry = registry.getEntry("my-tool.files.list");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("capability");
    expect(entry?.grants).toEqual(["read"]);
    expect(entry?.transport).toBe("cli");
    expect(registry.all().map((e) => e.id)).toContain("my-tool.files.list");
    expect(registry.summaries().map((s) => s.id)).toContain("my-tool.files.list");

    // The skill is discoverable AND back-linked is optional here (no attachSkills).
    const skill = registry.getEntry("my-tool.files.howto");
    expect(skill?.kind).toBe("skill");
    expect(skill?.body?.markdown).toContain("Pass { dir }");

    // A change event fired.
    expect(changes.length).toBeGreaterThan(0);
  });

  it("surfaces the extension as a runtime SourceModule via the shared registry", async () => {
    const sources = emptyRegistry();
    const registry = createCapabilityRegistry(sources);

    expect(sources.get("my-tool")).toBeUndefined(); // not present before
    await registry.registerExtension(CLI_EXT);

    // The invoke pipeline resolves a bridge via sources.get(sourceId); the runtime
    // extension module must now be resolvable through the SAME registry object.
    const mod = sources.get("my-tool");
    expect(mod).toBeDefined();
    expect(mod?.id).toBe("my-tool");
    expect(sources.all().map((m) => m.id)).toContain("my-tool");
  });

  it("rejects a malformed manifest without contributing entries", async () => {
    const sources = emptyRegistry();
    const registry = createCapabilityRegistry(sources);
    const res = await registry.registerExtension({ source: "bad" } as unknown as ExtensionManifest);
    expect(res.ok).toBe(false);
    expect(res.registered).toEqual([]);
    expect(res.reason).toBeDefined();
  });
});
