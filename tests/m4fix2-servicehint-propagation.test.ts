/**
 * m4fix2 — the gateway materializer propagates a manifest-level `serviceHint`
 * (`app`/`defaultPort`) onto each local-rest entry's `route`, so a 100%-VERBATIM
 * meta-skill-generated local-rest extension invokes end-to-end with ZERO demo-side
 * bridging.
 *
 * THE DEFECT (m4fix2): `LocalRestTransport` resolves its loopback baseUrl from
 * `route.app`/`route.defaultPort` (→ the loopback-enforced `platform.locateLocalService`),
 * but the generator emits the service-discovery info as a MANIFEST-LEVEL `serviceHint` and
 * does NOT put `app`/`defaultPort` on the route. Before the fix, `materializeExtension` did
 * not propagate the serviceHint, so a verbatim generated manifest had no route discovery
 * fields and the transport errored `route needs baseUrl or app`. The capstone papered over
 * this with a demo-side `surfaceServiceHintOntoRoute` bridge — now REMOVED.
 *
 * This test proves the gap is CLOSED, the honest way:
 *
 *   1. FULLY VERBATIM GENERATED MANIFEST INVOKES FOR REAL — take a manifest straight from
 *      the meta-skill `generateManifest` (route carries `pathTemplate` + NO app/defaultPort;
 *      discovery lives in manifest.serviceHint), register it VERBATIM into a REAL gateway,
 *      handshake + grant + invoke over the wire, and assert the agent receives the REAL
 *      loopback backend's data. The transport resolves its baseUrl via `locateLocalService`.
 *   2. THE PROPAGATION HAPPENS IN THE MATERIALIZER — the registry-scanned entry carries
 *      `route.app`/`route.defaultPort` (surfaced from the manifest serviceHint), even though
 *      the generated manifest's route carries neither.
 *   3. EGRESS GUARD STILL HOLDS — serviceHint can ONLY drive the loopback-enforced
 *      discovery path; it is never an SSRF lever. A `locateLocalService` that resolves a
 *      NON-loopback address is DENIED by the transport's egress guard (host_forbidden), with
 *      NO request issued and NO secret assembled — serviceHint cannot reach a foreign host.
 *   4. EXISTING DISCOVERY FIELDS ARE NEVER CLOBBERED — an entry that already carries its own
 *      route.app keeps it; the propagation only FILLS IN missing discovery fields.
 */

import { describe, it, expect, afterAll } from "bun:test";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { LocalRestTransport } from "@plexus/runtime/transports/local-rest.ts";
import { materializeExtension, withServiceHint } from "@plexus/runtime/sources/extension.ts";
import type {
  CapabilityEntry,
  ExtensionManifest,
  HandshakeResponse,
  InvokeResponse,
  LocalServiceHint,
  LocalServiceLocation,
  PlatformServices,
  ScopedToken,
} from "@plexus/protocol";
import {
  generateManifest,
  type CapabilitySpec,
} from "../plugins/plexus-ext/lib/generate.ts";

const config = loadConfig();
const HOST = expectedHost(config);

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

const SOURCE = "facts-lookup";
const READ_ID = "facts-lookup.facts.read";

/** The interview spec a user hands the meta-skill for a read-only local facts lookup. */
const factsSpec = (port: number): CapabilitySpec => ({
  sourceName: "Facts Lookup",
  label: "Facts",
  transport: "local-rest",
  actions: [
    {
      name: "facts.read",
      label: "Read a fact",
      describe: "Read a local fact by topic. Read-only.",
      grants: ["read"],
      inputProperties: { topic: { type: "string" } },
      requiredInputs: ["topic"],
      // EXTENSION-SPEC §6 published route field: a {token}-interpolated path.
      rest: { method: "GET", pathTemplate: "/facts/{topic}" },
      attachUsageSkill: false,
    },
  ],
  // Service discovery lives at the MANIFEST level (NOT on the route).
  serviceHint: { app: SOURCE, defaultPort: port },
});

/**
 * A platform whose `locateLocalService` resolves to a chosen loopback (or, for the egress
 * test, NON-loopback) address by the discovery hint — exercising the SAME loopback-enforced
 * discovery seam the real darwin platform uses, but pointed at our test backend.
 */
function platformResolving(address: (hint: LocalServiceHint) => string): PlatformServices {
  return Object.assign(Object.create(getPlatformServices()), {
    async locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
      return { kind: "http", address: address(hint) };
    },
    async resolveSecret(_name: string): Promise<string> {
      return "SECRET";
    },
  }) as PlatformServices;
}

async function req(app: ReturnType<typeof createAppWithState>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("m4fix2 — materializer propagates manifest serviceHint onto local-rest routes", () => {
  it("a FULLY VERBATIM generated manifest registers + INVOKES through the real gateway → REAL backend data", async () => {
    const dir = `/private/tmp/claude-501/m4fix2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.PLEXUS_HOME = dir;
    _resetSecretCacheForTests();

    // Generate the manifest straight from the meta-skill — NOT hand-written, NO bridging.
    const generated = generateManifest(factsSpec(BACKEND_PORT));
    const genCap = generated.capabilities.find((c) => c.name === "facts.read")!;
    const genRoute = genCap.route as Record<string, unknown>;
    // The defect's heart: the route carries pathTemplate but NO app/defaultPort — those
    // live ONLY in the manifest-level serviceHint.
    expect(genRoute.pathTemplate).toBe("/facts/{topic}");
    expect(genRoute.app).toBeUndefined();
    expect(genRoute.defaultPort).toBeUndefined();
    expect(generated.serviceHint?.app).toBe(SOURCE);
    expect(generated.serviceHint?.defaultPort).toBe(BACKEND_PORT);

    // Boot a REAL gateway whose transports use a platform that discovers our loopback
    // backend (the SAME loopback-enforced locateLocalService seam, pointed at the test svc).
    const platform = platformResolving((h) => `http://127.0.0.1:${h.defaultPort ?? BACKEND_PORT}`);
    const sources = createSourceRegistry(platform);
    const capabilities = createCapabilityRegistry(sources);
    const { app, state } = createAppWithState(config, { sources, capabilities });

    // Register the manifest 100% VERBATIM — ZERO demo-side adaptation.
    const verbatim = generated as unknown as ExtensionManifest;
    const reg = await state.capabilities.registerExtension(verbatim);
    expect(reg.ok).toBe(true);
    expect(reg.registered).toContain(READ_ID);

    // THE PROPAGATION: the registry-scanned entry now carries the discovery fields the
    // transport needs, surfaced from the manifest serviceHint by `materializeExtension`.
    const entry = state.capabilities.getEntry(READ_ID)!;
    const route = entry.extras?.route as Record<string, unknown>;
    expect(route.pathTemplate).toBe("/facts/{topic}"); // verbatim — never renamed
    expect(route.app).toBe(SOURCE); // surfaced from serviceHint
    expect(route.defaultPort).toBe(BACKEND_PORT); // surfaced from serviceHint
    expect(route.baseUrl).toBeUndefined(); // NEVER set from serviceHint (no SSRF lever)

    // HUMAN-IN-THE-LOOP: a transport-backed local-rest grant PENDS for a human. Model the
    // management user approving every pending item (the SAME flow the capstone uses).
    const approver = new GrantService(state, defaultAuthorizer());
    let approving = true;
    const approveLoop = (async () => {
      while (approving) {
        for (const p of approver.listPending()) await approver.approve(p.pendingId);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    try {
      // Drive the real pipeline over the wire: handshake → grant read → invoke.
      const hs = (await (await req(app, "/link/handshake", {
        method: "POST",
        body: JSON.stringify({
          connectionKey: state.connectionKey.current(),
          client: { name: "m4fix2", agentId: "agent-1" },
        }),
      })).json()) as HandshakeResponse;

      // PUT /grants pends; poll /grants/status until the token is minted (modeled approve).
      const grantRes = (await (await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({ sessionId: hs.sessionId, grants: { [READ_ID]: "allow" } }),
      })).json()) as ScopedToken & { status?: string; pendingId?: string };
      const token = await resolveToken(app, hs.sessionId, grantRes);
      expect(token.scopes).toEqual([{ id: READ_ID, verbs: ["read"] }]);

      const out = (await (await req(app, "/invoke", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ id: READ_ID, input: { topic: "plexus" } }),
      })).json()) as InvokeResponse;

      // THE HEADLINE PROOF: real data flowed back through the real gateway + LocalRestTransport,
      // whose baseUrl was resolved via locateLocalService (route.app/defaultPort from serviceHint).
      expect(out.ok).toBe(true);
      const data = out.output as { topic?: string; value?: string; source?: string };
      expect(data.topic).toBe("plexus");
      expect(data.value).toBe("VALUE:plexus");
      expect(data.source).toBe("facts-service");
    } finally {
      approving = false;
      await approveLoop;
      delete process.env.PLEXUS_HOME;
    }
  });

  it("EGRESS GUARD — serviceHint can ONLY drive loopback discovery; a non-loopback resolution is DENIED (no SSRF lever)", async () => {
    // A platform whose discovery resolves a NON-loopback address (simulating a compromised/
    // misbehaving adapter). The transport's egress guard must DENY it: serviceHint must never
    // become a way to reach a foreign host.
    let fetchCalled = false;
    let seenAuth: string | null = "UNSET";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      fetchCalled = true;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      const platform = platformResolving(() => "http://169.254.169.254"); // cloud metadata IP
      const transport = new LocalRestTransport(platform);

      // The materialized entry carries the serviceHint discovery fields + a secret. Even so,
      // the resolved (non-loopback) host is rejected BEFORE any request / secret assembly.
      const entry: CapabilityEntry = {
        id: READ_ID,
        source: SOURCE,
        kind: "capability",
        label: "x",
        describe: "x",
        grants: ["read"],
        transport: "local-rest",
        extras: {
          route: {
            app: SOURCE,
            defaultPort: 80,
            pathTemplate: "/latest/meta-data",
            secret: { name: "victim-key", attach: "bearer" },
          },
        },
      };

      const res = await transport.dispatch(entry, {});
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("host_forbidden");
      expect(fetchCalled).toBe(false); // no request issued
      expect(seenAuth).toBe("UNSET"); // secret never assembled for a forbidden host
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("propagation FILLS IN missing discovery fields but NEVER clobbers an entry's own route.app", () => {
    const hint: LocalServiceHint = { app: "from-hint", defaultPort: 9999 };
    const entries: CapabilityEntry[] = [
      // Carries NEITHER app NOR defaultPort → both surfaced from the hint.
      mkEntry({ pathTemplate: "/a" }),
      // Already carries its OWN app + defaultPort → left untouched.
      mkEntry({ pathTemplate: "/b", app: "own-app", defaultPort: 1234 }),
      // Carries an explicit baseUrl → app is NOT surfaced (baseUrl wins discovery).
      mkEntry({ pathTemplate: "/c", baseUrl: "http://127.0.0.1:5555" }),
    ];

    const out = withServiceHint(entries, hint);
    const r0 = out[0]!.extras!.route as Record<string, unknown>;
    expect(r0.app).toBe("from-hint");
    expect(r0.defaultPort).toBe(9999);

    const r1 = out[1]!.extras!.route as Record<string, unknown>;
    expect(r1.app).toBe("own-app"); // NOT clobbered
    expect(r1.defaultPort).toBe(1234); // NOT clobbered

    const r2 = out[2]!.extras!.route as Record<string, unknown>;
    expect(r2.app).toBeUndefined(); // an explicit baseUrl entry keeps using its baseUrl
    expect(r2.baseUrl).toBe("http://127.0.0.1:5555");
  });

  it("the materializer (materializeExtension) is the propagation home — bridge snapshot agrees with scan()", async () => {
    const generated = generateManifest(factsSpec(BACKEND_PORT)) as unknown as ExtensionManifest;
    const platform = platformResolving((h) => `http://127.0.0.1:${h.defaultPort ?? BACKEND_PORT}`);
    const module = materializeExtension(generated, platform);
    const source = module.createSource(platform);
    const scanned = await source.scan();
    const scannedCap = scanned.find((e) => e.id === READ_ID)!;
    const route = scannedCap.extras?.route as Record<string, unknown>;
    expect(route.app).toBe(SOURCE);
    expect(route.defaultPort).toBe(BACKEND_PORT);
    expect(route.pathTemplate).toBe("/facts/{topic}");
  });
});

/**
 * Resolve a PUT /grants response into a minted token: if it already carries scopes it is
 * the token; if it pended (`grant_pending_user`), poll `/grants/status` until the modeled
 * approver mints the token.
 */
async function resolveToken(
  app: ReturnType<typeof createAppWithState>["app"],
  sessionId: string,
  grantRes: ScopedToken & { status?: string; pendingId?: string },
): Promise<ScopedToken> {
  if (Array.isArray(grantRes.scopes) && grantRes.token) return grantRes;
  const pendingId = grantRes.pendingId;
  if (!pendingId) throw new Error(`grant did not pend nor mint: ${JSON.stringify(grantRes)}`);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = (await (await req(app, `/grants/status?pendingId=${pendingId}`, {
      headers: { "X-Plexus-Session": sessionId },
    })).json()) as {
      state: string;
      token?: ScopedToken;
    };
    if (status.state === "approved" && status.token) return status.token;
    if (status.state === "denied" || status.state === "expired") {
      throw new Error(`pending grant ${status.state}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("pending grant never resolved");
}

function mkEntry(route: Record<string, unknown>): CapabilityEntry {
  return {
    id: `${SOURCE}.x`,
    source: SOURCE,
    kind: "capability",
    label: "x",
    describe: "x",
    grants: ["read"],
    transport: "local-rest",
    extras: { route },
  };
}
