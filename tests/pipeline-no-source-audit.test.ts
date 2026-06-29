/**
 * Fix #6 — the "no source registered" denial must be AUDITED.
 *
 * In the pipeline, the no-source path (`bridgeFor` returns undefined because no
 * `SourceModule` is registered for the entry's source) threw a RAW `PipelineError`
 * WITHOUT going through `denyAudit`, so — unlike every other pre-dispatch denial —
 * it left no `denied` audit event and the thrown error carried no `auditId`.
 *
 * Here a token/grant is VALID for a capability whose backing source is NOT in the
 * registry. We assert the `/invoke` response carries a non-empty `auditId` AND the
 * audit JSONL on disk contains a `denied` event for it. Sandboxes state into a
 * fresh PLEXUS_HOME per app (mirrors tp2-invoke-shape.test.ts).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  CapabilityId,
  SourceRegistry,
  Transport,
  TransportKind,
  InvokeResponse,
  HandshakeResponse,
  ScopedToken,
  AuditEvent,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";

// A capability whose `source` ("ghost") is NEVER registered as a SourceModule, so
// `bridgeFor` returns undefined → the no-source denial fires. The token/grant for it
// is otherwise perfectly valid.
const GHOST_ENTRY: CapabilityEntry = {
  id: "ghost.note.read",
  source: "ghost",
  kind: "capability",
  label: "A capability whose backing source is unregistered",
  describe: "Read a ghost note. Use to prove the no-source denial is audited.",
  grants: ["read"],
  transport: "local-rest",
};

// An EMPTY source registry: it knows about no modules, so `sources.get('ghost')`
// returns undefined and no bridge can be built.
function emptyRegistry(): SourceRegistry {
  const transports: Partial<Record<TransportKind, Transport>> = {};
  return {
    all: () => [],
    get: () => undefined,
    getTransport: (kind) => {
      const t = transports[kind];
      if (t) return t;
      return { kind, dispatch: async () => ({ ok: true }) } as Transport;
    },
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-nosource-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = emptyRegistry();
  const capabilities = createCapabilityRegistry(sources);
  // Inject the ghost entry directly so it is discoverable/grantable even though its
  // source has no module.
  (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(
    GHOST_ENTRY.id,
    GHOST_ENTRY,
  );
  // Auto-approve so the grant mints a token immediately — the human-approval/pending
  // flow is unrelated to the no-source denial under test (the codebase's documented
  // pattern: inject AutoApproveAuthorizer when exercising unrelated mechanics).
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    authorizer: new AutoApproveAuthorizer(),
  });
  return { app, state, dir };
}

async function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

describe("fix #6 — the no-source denial is audited", () => {
  it("valid token, unregistered source → source_unavailable WITH auditId + a denied audit event", async () => {
    const { app, state, dir } = freshApp();

    // Handshake + grant the ghost capability (valid token, valid scope).
    const hsRes = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({
        connectionKey: state.connectionKey.current(),
        client: { name: "nosrc", agentId: "agent-nosrc" },
      }),
    });
    const hs = (await hsRes.json()) as HandshakeResponse;
    const grantRes = await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [GHOST_ENTRY.id]: "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;

    // Invoke: passes auth + scope + schema, then hits the no-source path.
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: GHOST_ENTRY.id as CapabilityId, input: {} }),
    });

    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.id).toBe(GHOST_ENTRY.id);
    expect(body.error?.code).toBe("source_unavailable");
    // The crux of the fix: the denial is now audited, so it carries a real auditId.
    expect(typeof body.auditId).toBe("string");
    expect(body.auditId.length).toBeGreaterThan(0);

    // ...and the audit JSONL on disk holds a matching `denied` event.
    const auditDir = join(dir, "audit");
    expect(existsSync(auditDir)).toBe(true);
    const lines = readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").trim().split("\n"))
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditEvent);
    const denied = lines.find((e) => e.id === body.auditId);
    expect(denied).toBeDefined();
    expect(denied?.outcome).toBe("denied");
    expect(denied?.capabilityId).toBe(GHOST_ENTRY.id);
    expect((denied?.detail as { code?: string } | undefined)?.code).toBe("source_unavailable");
  });
});
