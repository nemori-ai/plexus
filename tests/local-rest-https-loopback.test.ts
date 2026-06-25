/**
 * TRACKED HTTPS SMOKE — `local-rest` over a SELF-SIGNED HTTPS LOOPBACK server.
 *
 * The acceptance write-path (`examples/acceptance/scenario.ts`) uses a PLAIN-http loopback
 * stand-in for the user's write daemon. This smoke exercises the REAL-shaped path the
 * Obsidian Local REST API actually uses: HTTPS on 127.0.0.1 with a SELF-SIGNED certificate.
 *
 * `local-rest.ts` relaxes TLS verification (`{ tls: { rejectUnauthorized: false } }`) for a
 * hop ONLY when that hop's already-egress-validated destination is BOTH `https:` AND loopback
 * (see local-rest.ts step 5). That loopback-only TLS-relaxation branch is what makes the real
 * Obsidian REST plugin reachable while a public HTTPS host still gets FULL cert verification.
 * This test drives `LocalRestTransport.dispatch` DIRECTLY (no gateway) against an ephemeral
 * self-signed HTTPS `Bun.serve` and asserts:
 *
 *   - a WRITE (PUT, raw body) over `https://127.0.0.1:<port>` with a self-signed cert SUCCEEDS
 *     — i.e. the loopback TLS relaxation kicked in (a normal fetch would fail cert verify);
 *   - a subsequent READ (GET) returns exactly what the write PUT stored (real round-trip);
 *   - the Bearer secret IS attached over the HTTPS loopback hop (loopback-only attach);
 *   - the SAME route pointed at a NON-loopback HTTPS host is DENIED `host_forbidden` and the
 *     secret is NEVER attached — proving the TLS relaxation is loopback-gated, not global.
 *
 * HERMETIC / CI-SAFE: an ephemeral `Bun.serve` HTTPS listener on 127.0.0.1:0 with a freshly
 * generated self-signed cert; the throwaway Bearer secret lives in a temp PLEXUS_HOME. No
 * network, no real Obsidian, never binds :7077. TLS verification is relaxed PER-REQUEST by the
 * transport (Bun's `tls` fetch option) — never globally (no NODE_TLS_REJECT_UNAUTHORIZED).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { LocalRestTransport } from "@plexus/runtime/transports/local-rest.ts";
import type { CapabilityEntry } from "@plexus/protocol";

const API_KEY = "THROWAWAY-HTTPS-LOOPBACK-KEY"; // throwaway; never a real key
const SECRET_NAME = "https-loopback-api-key";

const tmpDirs: string[] = [];

/** Generate a fresh self-signed cert for CN/SAN 127.0.0.1 (the loopback host). */
function makeCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "plexus-https-cert-"));
  tmpDirs.push(dir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

// ── Self-signed HTTPS loopback "REST" server: GET/PUT /vault/{path}, Bearer-auth ─────
const vault = new Map<string, string>([["Index.md", "# Index\nself-signed HTTPS loopback.\n"]]);
let lastAuthSeen: string | null = null;
let server: ReturnType<typeof Bun.serve>;
let HTTPS_URL = "";

beforeAll(() => {
  const { key, cert } = makeCert();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key, cert },
    async fetch(req) {
      lastAuthSeen = req.headers.get("authorization");
      if (lastAuthSeen !== `Bearer ${API_KEY}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/vault\/(.+)$/);
      if (m) {
        const note = decodeURIComponent(m[1]!);
        if (req.method === "PUT") {
          vault.set(note, await req.text());
          return new Response(null, { status: 204 });
        }
        if (req.method === "GET") {
          const c = vault.get(note);
          if (c === undefined) return new Response("not found", { status: 404 });
          return new Response(c, { status: 200, headers: { "content-type": "text/markdown" } });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  HTTPS_URL = `https://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

/** Provision the throwaway secret into a temp PLEXUS_HOME (never the user's real store). */
function provisionSecret(): void {
  const dir = mkdtempSync(join(tmpdir(), "plexus-https-home-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(join(dir, "secrets", SECRET_NAME), API_KEY);
  _resetSecretCacheForTests();
}

/** A local-rest entry for the Obsidian-shaped `/vault/{path}` route over `baseUrl`. */
function entry(baseUrl: string, grant: "read" | "write"): CapabilityEntry {
  return {
    id: `https-loopback.${grant}`,
    source: "https-loopback",
    kind: "capability",
    label: "x",
    describe: "x",
    grants: [grant],
    transport: "local-rest",
    extras: {
      route: {
        baseUrl,
        method: grant === "write" ? "PUT" : "GET",
        pathTemplate: "/vault/{path}",
        pathTokens: ["path"],
        ...(grant === "write" ? { bodyFrom: "content" } : {}),
        secret: { name: SECRET_NAME, attach: "bearer" },
      },
    },
  };
}

describe("TRACKED HTTPS SMOKE — local-rest over a self-signed HTTPS loopback (TLS relaxation)", () => {
  it("WRITE + READ round-trip over https://127.0.0.1 with a self-signed cert succeeds (loopback TLS relaxed, Bearer attached)", async () => {
    provisionSecret();
    const transport = new LocalRestTransport(getPlatformServices());

    const NEW_PATH = "Inbox/From HTTPS.md";
    const NEW_BODY = "# From HTTPS\n\nWritten over a self-signed HTTPS loopback hop.\n";

    // WRITE (PUT, raw body) — a self-signed HTTPS cert would FAIL a normal fetch; success here
    // proves the loopback-only TLS relaxation branch fired.
    const wrote = await transport.dispatch(entry(HTTPS_URL, "write"), { path: NEW_PATH, content: NEW_BODY });
    expect(wrote.ok).toBe(true);
    // The Bearer secret reached the loopback HTTPS server (loopback-only attach).
    expect(lastAuthSeen).toBe(`Bearer ${API_KEY}`);
    // The write really landed in the mock vault.
    expect(vault.get(NEW_PATH)).toBe(NEW_BODY);

    // READ (GET) back over the same self-signed HTTPS loopback — real round-trip.
    const read = await transport.dispatch(entry(HTTPS_URL, "read"), { path: NEW_PATH });
    expect(read.ok).toBe(true);
    expect(String(read.data)).toBe(NEW_BODY);
  });

  it("the SAME route at a NON-loopback HTTPS host is DENIED host_forbidden and the secret is never attached", async () => {
    provisionSecret();
    // Hard-fail if the transport ever attempts the network: it must be refused by the egress
    // gate BEFORE any fetch, so the self-signed TLS relaxation can never apply off-loopback.
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const transport = new LocalRestTransport(getPlatformServices());
      const r = await transport.dispatch(entry("https://attacker.example", "read"), { path: "Index.md" });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("host_forbidden");
      // No request was made ⇒ the Bearer was never assembled/sent to a non-loopback host.
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
