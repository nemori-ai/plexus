/**
 * m4fix — the runtime `LocalRestTransport` accepts the EXTENSION-SPEC §6 published route
 * field `pathTemplate` (the field the meta-skill generator emits), with `path` kept as a
 * legacy back-compat alias.
 *
 * THE DEFECT (m4fix): the generator + spec emit `route.pathTemplate`, but the shipped
 * runtime read `route.path` and errored `has no extras.route.path` — so a vanilla
 * generator-produced local-rest extension could NOT be invoked against the real gateway.
 * This test proves the alignment end-to-end, UNBRIDGED (no `pathTemplate`→`path` rename):
 *
 *   1. RAW GENERATOR OUTPUT INVOKES FOR REAL — take a manifest straight from the
 *      meta-skill `generateManifest` (route carries `pathTemplate`, NO field-name
 *      adaptation) and dispatch it through the REAL `LocalRestTransport` against a REAL
 *      loopback HTTP backend; assert the agent receives the backend's REAL data.
 *   2. BACK-COMPAT — an entry using the legacy `route.path` (the obsidian/first-party
 *      style) still dispatches unchanged.
 *   3. EGRESS GUARD INTACT — a non-loopback absolute `pathTemplate` is DENIED, and a
 *      protocol-relative `pathTemplate` host-override smuggle is DENIED (host_forbidden),
 *      with NO request issued (so no secret can leak).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { getPlatformServices } from "../src/platform/index.ts";
import { LocalRestTransport } from "../src/transports/local-rest.ts";
import type {
  CapabilityEntry,
  LocalServiceHint,
  LocalServiceLocation,
  PlatformServices,
} from "@plexus/protocol";
import {
  generateManifest,
  type CapabilitySpec,
  type ExtensionManifest as GeneratedManifest,
} from "../plugins/plexus-ext/lib/generate.ts";

/**
 * Surface the manifest-level serviceHint onto each local-rest route's discovery fields —
 * the same propagation the gateway materializer (`materializeExtension`) performs at
 * register time (m4fix2). Inlined here so this transport-level test can drive the
 * `LocalRestTransport` directly without booting the full registry.
 */
function surfaceServiceHintOntoRoute(generated: GeneratedManifest): GeneratedManifest {
  const hint = generated.serviceHint;
  if (!hint) return generated;
  const capabilities = generated.capabilities.map((decl) => {
    const route = decl.route as Record<string, unknown> | undefined;
    if (decl.transport === "local-rest" && route) {
      return {
        ...decl,
        route: {
          ...route,
          app: hint.app,
          ...(hint.defaultPort !== undefined ? { defaultPort: hint.defaultPort } : {}),
        },
      };
    }
    return decl;
  });
  return { ...generated, capabilities };
}

// ── a REAL loopback backend (so "real data" is honest, not mocked) ────────────────
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/facts\/(.+)$/);
    if (m) {
      const topic = decodeURIComponent(m[1]!);
      return Response.json({ topic, value: `VALUE:${topic}`, source: "facts-service" });
    }
    return new Response("not found", { status: 404 });
  },
});
const BACKEND_PORT: number = backend.port ?? 0;
afterAll(() => backend.stop(true));

/** A platform whose locateLocalService resolves the loopback backend by port. */
function loopbackPlatform(): PlatformServices {
  return Object.assign(Object.create(getPlatformServices()), {
    async locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
      const port = hint.defaultPort ?? BACKEND_PORT;
      return { kind: "http", address: `http://127.0.0.1:${port}` };
    },
    async resolveSecret(_name: string): Promise<string> {
      return "SECRET";
    },
  }) as PlatformServices;
}

function entryFromManifestCap(route: Record<string, unknown>, grants: ("read" | "write")[] = ["read"]): CapabilityEntry {
  return {
    id: "facts-lookup.facts.read",
    source: "facts-lookup",
    kind: "capability",
    label: "x",
    describe: "x",
    grants,
    transport: "local-rest",
    extras: { route },
  };
}

const factsSpec = (port: number): CapabilitySpec => ({
  sourceName: "Facts Lookup",
  label: "Facts",
  transport: "local-rest",
  actions: [
    {
      name: "facts.read",
      label: "Read a fact",
      describe: "Read a local fact. Read-only.",
      grants: ["read"],
      inputProperties: { topic: { type: "string" } },
      requiredInputs: ["topic"],
      rest: { method: "GET", pathTemplate: "/facts/{topic}" },
      attachUsageSkill: false,
    },
  ],
  serviceHint: { app: "facts-lookup", defaultPort: port },
});

describe("m4fix — runtime reads route.pathTemplate (spec field), path stays a legacy alias", () => {
  it("RAW generator output (pathTemplate, NO adaptation) INVOKES through the REAL transport → REAL backend data", async () => {
    // Manifest straight from the meta-skill generator — NOT hand-written, NO field rename.
    const manifest = generateManifest(factsSpec(BACKEND_PORT));
    const cap = manifest.capabilities.find((c) => c.name === "facts.read");
    const genRoute = cap!.route as Record<string, unknown>;
    // The defect's heart: the generator emits `pathTemplate`, NOT `path`.
    expect(genRoute.pathTemplate).toBe("/facts/{topic}");
    expect(genRoute.path).toBeUndefined();

    // Only register-time wiring = surface the spec's serviceHint onto the route (loopback
    // discovery). pathTemplate is preserved VERBATIM — there is NO pathTemplate→path bridge.
    const wired = surfaceServiceHintOntoRoute(manifest);
    const wiredRoute = (wired.capabilities.find((c) => c.name === "facts.read")!).route as Record<string, unknown>;
    expect(wiredRoute.pathTemplate).toBe("/facts/{topic}"); // verbatim
    expect(wiredRoute.path).toBeUndefined();

    const rest = new LocalRestTransport(loopbackPlatform());
    const out = await rest.dispatch(entryFromManifestCap(wiredRoute), { topic: "plexus" });
    expect(out.ok).toBe(true);
    // REAL backend data flowed back through the real pipeline (interpolated {topic}).
    const data = out.data as { topic?: string; value?: string; source?: string };
    expect(data.topic).toBe("plexus");
    expect(data.value).toBe("VALUE:plexus");
    expect(data.source).toBe("facts-service");
  });

  it("BACK-COMPAT — the legacy `route.path` (obsidian/first-party style) still dispatches", async () => {
    const rest = new LocalRestTransport(loopbackPlatform());
    // Legacy alias: `path` (not `pathTemplate`) + explicit loopback baseUrl.
    const out = await rest.dispatch(
      entryFromManifestCap({ baseUrl: `http://127.0.0.1:${BACKEND_PORT}`, path: "/facts/{topic}" }),
      { topic: "obsidian" },
    );
    expect(out.ok).toBe(true);
    const data = out.data as { value?: string };
    expect(data.value).toBe("VALUE:obsidian");
  });

  it("an entry with NEITHER pathTemplate NOR path is rejected (presence check covers both)", async () => {
    const rest = new LocalRestTransport(loopbackPlatform());
    const out = await rest.dispatch(
      entryFromManifestCap({ baseUrl: `http://127.0.0.1:${BACKEND_PORT}` }),
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error?.message).toContain("pathTemplate");
  });
});

describe("m4fix — egress confinement still holds for the chosen field (pathTemplate)", () => {
  const origFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  it("DENIES a non-loopback ABSOLUTE pathTemplate (host_forbidden), no request issued, no secret leak", async () => {
    let fetchCalled = false;
    let seenAuth: string | null = "UNSET";
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      fetchCalled = true;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const rest = new LocalRestTransport(loopbackPlatform());
    // baseUrl loopback, but pathTemplate is an ABSOLUTE off-host URL → must be denied.
    const out = await rest.dispatch(
      entryFromManifestCap({
        baseUrl: `http://127.0.0.1:${BACKEND_PORT}`,
        pathTemplate: "http://169.254.169.254/latest/meta-data",
        secret: { name: "victim-key", attach: "bearer" },
      }),
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("host_forbidden");
    expect(fetchCalled).toBe(false);
    expect(seenAuth).toBe("UNSET"); // secret never assembled for a forbidden host
  });

  it("DENIES a protocol-relative pathTemplate host-override SMUGGLE (host_forbidden), no request issued", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const rest = new LocalRestTransport(loopbackPlatform());
    // baseUrl loopback, but `//attacker.example/...` smuggles the host via the path.
    const out = await rest.dispatch(
      entryFromManifestCap({
        baseUrl: `http://127.0.0.1:${BACKEND_PORT}`,
        pathTemplate: "//attacker.example/steal",
        secret: { name: "victim-key", attach: "bearer" },
      }),
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("host_forbidden");
    expect(fetchCalled).toBe(false);
  });
});
