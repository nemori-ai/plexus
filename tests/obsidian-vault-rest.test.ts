/**
 * rwapi — "open an Obsidian vault READ-WRITE via the Local REST API" end-to-end.
 *
 * Boots a MOCK Obsidian Local REST API server (a tiny in-test HTTPS server with a
 * self-signed cert, exposing `GET /vault/`, `GET /vault/{path}`, `PUT /vault/{path}`,
 * Bearer-authenticated) and drives Plexus's REAL `local-rest` transport + REAL gateway
 * pipeline (handshake → grant → invoke) against it. Asserts:
 *   - read returns the mock note content (Bearer secret IS attached over HTTPS-loopback);
 *   - write PUTs content and a subsequent read returns it (round-trip, real);
 *   - the self-signed HTTPS cert is accepted ONLY because the host is loopback;
 *   - a non-loopback baseUrl is STILL denied `host_forbidden` and the secret NOT leaked;
 *   - the write capability requires the `write` grant (pends under the user-confirm
 *     authorizer, never auto-granted).
 *
 * The secret is a THROWAWAY value placed into a temp `~/.plexus/secrets/` — never the
 * user's real store, never hardcoded into the transport.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { LocalRestTransport } from "@plexus/runtime/transports/local-rest.ts";
import {
  openVaultRestExtension,
  openVaultRestManifest,
  REST_VAULT_LIST_ID,
  REST_VAULT_READ_ID,
  REST_VAULT_WRITE_ID,
  REST_VAULT_SKILL_ID,
} from "@plexus/runtime/sources/obsidian/open-vault-rest.ts";
import type {
  CapabilityEntry,
  HandshakeResponse,
  InvokeResponse,
  ScopedToken,
} from "@plexus/protocol";

const config = loadConfig();
const HOST = expectedHost(config);
const API_KEY = "THROWAWAY-REST-KEY-rwapi-test"; // throwaway; never the real key
const SECRET_NAME = "obsidian-local-rest-api-key";

const tmpDirs: string[] = [];

// ── MOCK Obsidian Local REST API (HTTPS, self-signed, Bearer-auth) ───────────────
// An in-memory vault keyed by note path; supports GET /vault/, GET/PUT /vault/{path}.
const mockVault = new Map<string, string>([
  ["Index.md", "# Index\nWelcome to the REST vault.\n"],
  ["Daily/2026-06-23.md", "# 2026-06-23\nMet with the Plexus team via REST.\n"],
]);
let lastAuthSeen: string | null = null;

function makeCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "plexus-rest-cert-"));
  tmpDirs.push(dir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

let server: ReturnType<typeof Bun.serve>;
let REST_URL = "";

beforeAll(() => {
  const { key, cert } = makeCert();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key, cert },
    fetch(req) {
      // Bearer auth gate — the mock REST plugin requires the API key.
      lastAuthSeen = req.headers.get("authorization");
      if (lastAuthSeen !== `Bearer ${API_KEY}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/vault/" && req.method === "GET") {
        return Response.json({ files: [...mockVault.keys()].sort() });
      }
      const m = path.match(/^\/vault\/(.+)$/);
      if (m) {
        const note = decodeURIComponent(m[1]!);
        if (req.method === "GET") {
          const content = mockVault.get(note);
          if (content === undefined) return new Response("not found", { status: 404 });
          return new Response(content, { status: 200, headers: { "content-type": "text/markdown" } });
        }
        if (req.method === "PUT") {
          // The Obsidian REST API write semantics: body = the raw markdown content.
          return req.text().then((body) => {
            mockVault.set(note, body);
            return new Response(null, { status: 204 });
          });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  REST_URL = `https://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

/** Fresh gateway with a temp PLEXUS_HOME + the throwaway secret provisioned. */
function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-rest-home-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  // Provision the THROWAWAY secret into the temp store (never the user's real ~/.plexus).
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(join(dir, "secrets", SECRET_NAME), API_KEY);
  _resetSecretCacheForTests();

  const platform = getPlatformServices();
  const sources = createSourceRegistry(platform);
  const capabilities = createCapabilityRegistry(sources);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  return { app, state };
}

async function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(app: ReturnType<typeof freshApp>["app"], state: ReturnType<typeof freshApp>["state"]) {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: state.connectionKey.current(), client: { name: "rwapi", agentId: "agent-1" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

/** Resolve a PUT /grants response into a minted token, polling /grants/status if it pended. */
async function resolveToken(
  app: ReturnType<typeof freshApp>["app"],
  grantRes: ScopedToken & { status?: string; pendingId?: string },
): Promise<ScopedToken> {
  if (Array.isArray(grantRes.scopes) && grantRes.token) return grantRes;
  const pendingId = grantRes.pendingId;
  if (!pendingId) throw new Error(`grant did not pend nor mint: ${JSON.stringify(grantRes)}`);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = (await (await req(app, `/grants/status?pendingId=${pendingId}`)).json()) as {
      state: string;
      token?: ScopedToken;
    };
    if (status.state === "approved" && status.token) return status.token;
    if (status.state === "denied" || status.state === "expired") throw new Error(`pending grant ${status.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("pending grant never resolved");
}

/** Grant + (auto-approve any pending) → minted token for `id`. */
async function grant(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  sessionId: string,
  id: string,
): Promise<ScopedToken> {
  const approver = new GrantService(state, defaultAuthorizer());
  let approving = true;
  const loop = (async () => {
    while (approving) {
      for (const p of approver.listPending()) await approver.approve(p.pendingId);
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  try {
    const grantRes = (await (await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
    })).json()) as ScopedToken & { status?: string; pendingId?: string };
    return await resolveToken(app, grantRes);
  } finally {
    approving = false;
    await loop;
  }
}

// ── Manifest shape ───────────────────────────────────────────────────────────────
describe("rwapi — REST vault manifest", () => {
  it("declares list(read) / read(read) / write(write) over local-rest + a usage skill + secretRef", () => {
    const m = openVaultRestManifest({ baseUrl: "https://127.0.0.1:27124", secretName: SECRET_NAME });
    expect(m.transport).toBe("local-rest");
    expect(m.secrets?.[0]).toEqual({ name: SECRET_NAME, attach: "bearer" });

    const byName = new Map(m.capabilities.map((c) => [c.name, c]));
    expect(byName.get("vault.list")?.grants).toEqual(["read"]);
    expect(byName.get("vault.read")?.grants).toEqual(["read"]);
    expect(byName.get("vault.write")?.grants).toEqual(["write"]);
    // No secret VALUE anywhere in the serialized manifest.
    expect(JSON.stringify(m)).not.toContain(API_KEY);

    const writeRoute = byName.get("vault.write")?.route as Record<string, unknown>;
    expect(writeRoute.method).toBe("PUT");
    expect(writeRoute.pathTemplate).toBe("/vault/{path}");
    expect(writeRoute.bodyFrom).toBe("content");
    const skill = byName.get("vault.how-to-use");
    expect(skill?.kind).toBe("skill");
    expect((skill?.body?.markdown ?? "")).toContain("read-write");
  });
});

// ── End-to-end through the real gateway + real local-rest transport ───────────────
describe("rwapi — read/write round-trip through the real gateway", () => {
  it("read returns mock note content (Bearer attached over HTTPS-loopback)", async () => {
    const { app, state } = freshApp();
    const reg = await state.capabilities.registerExtension(
      openVaultRestExtension({ baseUrl: REST_URL, secretName: SECRET_NAME }).manifest,
    );
    expect(reg.ok).toBe(true);
    expect(reg.registered).toContain(REST_VAULT_READ_ID);
    expect(reg.registered).toContain(REST_VAULT_SKILL_ID);

    const hs = await handshake(app, state);
    // The skill is discoverable + attached to read.
    const readEntry = hs.manifest.entries.find((e) => e.id === REST_VAULT_READ_ID);
    expect(readEntry?.grants).toEqual(["read"]);
    expect(readEntry?.skills?.some((s) => s.id === REST_VAULT_SKILL_ID)).toBe(true);

    const token = await grant(app, state, hs.sessionId, REST_VAULT_READ_ID);
    const out = (await (await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: REST_VAULT_READ_ID, input: { path: "Daily/2026-06-23.md" } }),
    })).json()) as InvokeResponse;

    expect(out.ok).toBe(true);
    expect(String(out.output)).toContain("Met with the Plexus team via REST");
    // The mock REST server saw the Bearer key (attached only to loopback HTTPS).
    expect(lastAuthSeen).toBe(`Bearer ${API_KEY}`);
  });

  it("list enumerates the vault notes", async () => {
    const { app, state } = freshApp();
    await state.capabilities.registerExtension(
      openVaultRestExtension({ baseUrl: REST_URL, secretName: SECRET_NAME }).manifest,
    );
    const hs = await handshake(app, state);
    const token = await grant(app, state, hs.sessionId, REST_VAULT_LIST_ID);
    const out = (await (await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: REST_VAULT_LIST_ID, input: {} }),
    })).json()) as InvokeResponse;
    expect(out.ok).toBe(true);
    const data = out.output as { files: string[] };
    expect(data.files).toContain("Index.md");
  });

  it("write PUTs content, then a subsequent read returns it (round-trip)", async () => {
    const { app, state } = freshApp();
    await state.capabilities.registerExtension(
      openVaultRestExtension({ baseUrl: REST_URL, secretName: SECRET_NAME }).manifest,
    );
    const hs = await handshake(app, state);

    const NEW_PATH = "Inbox/From Plexus.md";
    const NEW_BODY = "# From Plexus\n\nWritten through the REST API round-trip.\n";

    // WRITE — requires the write grant (pends → approved by the modeled human).
    const writeToken = await grant(app, state, hs.sessionId, REST_VAULT_WRITE_ID);
    expect(writeToken.scopes.find((s) => s.id === REST_VAULT_WRITE_ID)?.verbs).toContain("write");
    const wrote = (await (await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: JSON.stringify({ id: REST_VAULT_WRITE_ID, input: { path: NEW_PATH, content: NEW_BODY } }),
    })).json()) as InvokeResponse;
    expect(wrote.ok).toBe(true);

    // READ BACK — the content the write PUT actually landed in the mock vault.
    const readToken = await grant(app, state, hs.sessionId, REST_VAULT_READ_ID);
    const readBack = (await (await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken.token}` },
      body: JSON.stringify({ id: REST_VAULT_READ_ID, input: { path: NEW_PATH } }),
    })).json()) as InvokeResponse;
    expect(readBack.ok).toBe(true);
    expect(String(readBack.output)).toBe(NEW_BODY); // real round-trip
    // The mock vault really holds it.
    expect(mockVault.get(NEW_PATH)).toBe(NEW_BODY);
  });

  it("the write capability REQUIRES the write grant — granting it PENDS for a human", async () => {
    const { app, state } = freshApp();
    await state.capabilities.registerExtension(
      openVaultRestExtension({ baseUrl: REST_URL, secretName: SECRET_NAME }).manifest,
    );
    const hs = await handshake(app, state);
    // A raw PUT /grants for the write capability must PEND (no token minted up front) —
    // the user-confirm authorizer is not bypassed for a mutating, extension-sourced grant.
    const grantRes = (await (await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [REST_VAULT_WRITE_ID]: "allow" } }),
    })).json()) as ScopedToken & { status?: string; pendingId?: string };
    expect(grantRes.token).toBeUndefined();
    expect(grantRes.pendingId).toBeDefined();
  });
});

// ── Egress confinement still holds for the REST flow ─────────────────────────────
describe("rwapi — egress confinement: a non-loopback baseUrl is DENIED, secret not leaked", () => {
  const origFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  it("a non-loopback baseUrl is host_forbidden and no request/secret is assembled", async () => {
    let fetchCalled = false;
    let seenAuth: string | null = "UNSET";
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      fetchCalled = true;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // Build the WRITE entry but point it at an attacker host.
    const manifest = openVaultRestManifest({ baseUrl: "https://attacker.example", secretName: SECRET_NAME });
    const writeDecl = manifest.capabilities.find((c) => c.name === "vault.write")!;
    const entry: CapabilityEntry = {
      id: REST_VAULT_WRITE_ID,
      source: "obsidian-rest",
      kind: "capability",
      label: "x",
      describe: "x",
      grants: ["write"],
      transport: "local-rest",
      extras: { route: writeDecl.route as Record<string, unknown> },
    };

    // Provision the throwaway secret so resolveSecret CAN find it (proving it still isn't sent).
    const dir = mkdtempSync(join(tmpdir(), "plexus-rest-home-"));
    tmpDirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", SECRET_NAME), API_KEY);

    const transport = new LocalRestTransport(getPlatformServices());
    const r = await transport.dispatch(entry, { path: "x.md", content: "evil" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("host_forbidden");
    expect(fetchCalled).toBe(false);
    expect(seenAuth).toBe("UNSET");
    delete process.env.PLEXUS_HOME;
  });
});
