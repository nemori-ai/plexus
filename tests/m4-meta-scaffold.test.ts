/**
 * m4meta (T-A) — the scaffold-writing side of the meta-skill (lib/cli.ts helpers).
 *
 * Asserts: the generated `register.sh` embeds NO live token / connection-key; the
 * scaffold files are written under `plexus-extensions/<source>/`; the manifest
 * written to disk passes the gateway `validateRegistration` when read back.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerScript, readmeFor, secretsReadme } from "../plugins/plexus-ext/lib/cli.ts";
import { generateManifest, type CapabilitySpec } from "../plugins/plexus-ext/lib/generate.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import type {
  ExtensionManifest,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

function emptyRegistry(): SourceRegistry {
  const byId = new Map<string, SourceModule>();
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

describe("m4meta — register.sh embeds no secret material", () => {
  const script = registerScript("manifest.json");

  it("reads the sessionId from the environment, never hard-codes a token/key", () => {
    expect(script).toContain("$PLEXUS_SESSION");
    // No connection-key or bearer token literal embedded.
    expect(script).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
    expect(script).not.toMatch(/connectionKey"\s*:\s*"[^"]+"/);
  });

  it("targets POST /extensions and notes it PENDS for human approval", () => {
    expect(script).toContain("/extensions");
    expect(script.toLowerCase()).toContain("approve");
  });
});

describe("m4meta — generated README + secrets README", () => {
  const spec: CapabilitySpec = {
    sourceName: "Acme Notes",
    label: "Acme Notes (Local REST API)",
    transport: "local-rest",
    secrets: [{ name: "acme-notes-api-key", attach: "bearer" }],
    actions: [
      {
        name: "notes.search",
        label: "Search Acme notes",
        describe: "Search local Acme notes. Read-only.",
        grants: ["read"],
        inputProperties: { query: { type: "string" } },
        rest: { method: "GET", pathTemplate: "/search?q={query}", secret: "acme-notes-api-key" },
      },
    ],
  };
  const manifest = generateManifest(spec);

  it("README lists the grant cost per capability and the pend-for-approval flow", () => {
    const md = readmeFor(manifest);
    expect(md).toContain("acme-notes.notes.search");
    expect(md.toLowerCase()).toContain("grant cost");
    expect(md.toLowerCase()).toContain("approve");
  });

  it("secrets README carries the reference + provisioning, never a value", () => {
    const md = secretsReadme(manifest);
    expect(md).toContain("acme-notes-api-key");
    expect(md).toContain("~/.plexus/secrets/");
    expect(md).not.toMatch(/value\s*[:=]\s*\S+/i);
  });
});

describe("m4meta — the CLI writes a scaffold whose manifest the gateway accepts", () => {
  it("generate writes manifest.json + register.sh; read-back passes validateRegistration", () => {
    const out = mkdtempSync(join(tmpdir(), "m4meta-"));
    const specPath = join(out, "spec.json");
    const spec: CapabilitySpec = {
      sourceName: "Acme Notes",
      label: "Acme Notes (Local REST API)",
      transport: "local-rest",
      secrets: [{ name: "acme-notes-api-key", attach: "bearer" }],
      actions: [
        {
          name: "notes.search",
          label: "Search Acme notes",
          describe: "Search local Acme notes by query. Use to cite notes. Read-only.",
          grants: ["read"],
          inputProperties: { query: { type: "string" } },
          requiredInputs: ["query"],
          rest: { method: "GET", pathTemplate: "/search?q={query}", secret: "acme-notes-api-key" },
        },
      ],
    };
    Bun.write(specPath, JSON.stringify(spec));

    const proc = Bun.spawnSync([
      "bun",
      join(import.meta.dir, "..", "plugins", "plexus-ext", "lib", "cli.ts"),
      "generate",
      specPath,
      out,
    ]);
    expect(proc.exitCode).toBe(0);

    const extDir = join(out, "plexus-extensions", "acme-notes");
    expect(existsSync(join(extDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(extDir, "register.sh"))).toBe(true);
    expect(existsSync(join(extDir, "skills", "notes.search.how-to-use.md"))).toBe(true);
    expect(existsSync(join(extDir, "secrets.README.md"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8")) as ExtensionManifest;
    const registry = createCapabilityRegistry(emptyRegistry());
    const verdict = registry.validateRegistration(manifest);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("generate REFUSES (non-zero exit) a spec naming a shell cli bin", () => {
    const out = mkdtempSync(join(tmpdir(), "m4meta-bad-"));
    const specPath = join(out, "spec.json");
    Bun.write(
      specPath,
      JSON.stringify({
        sourceName: "danger",
        label: "Danger",
        transport: "cli",
        actions: [
          {
            name: "shell.run",
            label: "Run",
            describe: "Run. Side-effecting.",
            grants: ["execute"],
            cli: { bin: "/bin/sh", args: ["-c", "{x}"] },
            inputProperties: { x: { type: "string" } },
          },
        ],
      }),
    );
    const proc = Bun.spawnSync([
      "bun",
      join(import.meta.dir, "..", "plugins", "plexus-ext", "lib", "cli.ts"),
      "generate",
      specPath,
      out,
    ]);
    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toMatch(/refused|absolute_path/i);
    // And nothing was written for the refused source.
    expect(existsSync(join(out, "plexus-extensions", "danger"))).toBe(false);
  });
});
