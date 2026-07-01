/**
 * A1 — `plexus mesh mint` CLI, unit-tested against a STUB admin server.
 *
 * Drives `runMesh()` directly (not a subprocess) against a throwaway Bun.serve that
 * mimics `POST /admin/api/mesh/join-token` + `GET /admin/api/mesh`, asserting:
 *
 *   1. mint prints the token + the copy-paste upstream env block (URL / pubkey / workload).
 *   2. --json emits the raw mint result.
 *   3. SINGLE-USE — each `mint` yields a DISTINCT token (the stub never reissues), and
 *      it forwards the management key the gateway gate requires.
 *   4. a primary-less stub (409) surfaces as a non-zero CLI error.
 *   5. --ttl is parsed to ttlMs and forwarded.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

import { runMesh, MeshCliError } from "../packages/cli/src/mesh-commands.ts";

const KEY = "plx_live_stub_key";
const PUBKEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAstubkeystubkeystubkeystubkeystubkeystubke=\n-----END PUBLIC KEY-----\n";

interface StubState {
  /** Force every join-token mint to 409 (a proxy / not-started primary). */
  notPrimary: boolean;
  /** Tokens handed out so far (proves single-use: each mint is fresh). */
  issued: string[];
  /** The ttlMs the last mint received (or undefined). */
  lastTtlMs?: number;
  /** Whether the last request presented the management key. */
  lastKeyPresented?: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const stub: StubState = { notPrimary: false, issued: [] };
let counter = 0;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(reqObj) {
      const url = new URL(reqObj.url);
      stub.lastKeyPresented = reqObj.headers.get("x-plexus-connection-key");
      // The blanket management-key gate the real admin surface enforces.
      if (!stub.lastKeyPresented || stub.lastKeyPresented !== KEY) {
        return Response.json({ error: { code: "unauthorized", message: "bad key" } }, { status: 401 });
      }
      if (url.pathname === "/admin/api/mesh" && reqObj.method === "GET") {
        return Response.json({
          mode: stub.notPrimary ? "proxy" : "primary",
          tunnelPort: stub.notPrimary ? 0 : 7099,
          primaryPubKey: stub.notPrimary ? undefined : PUBKEY,
        });
      }
      if (url.pathname === "/admin/api/mesh/join-token" && reqObj.method === "POST") {
        if (stub.notPrimary) {
          return Response.json(
            { error: { code: "mesh_not_primary", message: "this gateway is a proxy" } },
            { status: 409 },
          );
        }
        let body: { ttlMs?: number } = {};
        try {
          body = (await reqObj.json()) as { ttlMs?: number };
        } catch {
          /* empty body */
        }
        stub.lastTtlMs = body.ttlMs;
        const token = `jointok-${++counter}`;
        stub.issued.push(token);
        return Response.json({
          token,
          tunnelPort: 7099,
          primaryPubKey: PUBKEY,
          ...(body.ttlMs ? { expiresAt: new Date(Date.now() + body.ttlMs).toISOString() } : {}),
        });
      }
      return Response.json({ error: { code: "unknown_capability", message: "no route" } }, { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
});

/** Capture stdout while `fn` runs (runMesh writes to process.stdout.write). */
async function capture(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  return chunks.join("");
}

beforeEach(() => {
  stub.notPrimary = false;
  stub.issued = [];
  stub.lastTtlMs = undefined;
});

describe("A1 CLI: plexus mesh mint", () => {
  it("prints the token + the upstream env block", async () => {
    const out = await capture(() => runMesh(["mint", "--url", baseUrl, "--key", KEY, "--workload", "laptop"]));
    expect(stub.issued.length).toBe(1);
    const token = stub.issued[0]!;
    expect(out).toContain(token);
    expect(out).toContain("PLEXUS_UPSTREAM_URL=ws://127.0.0.1:7099");
    expect(out).toContain("PLEXUS_UPSTREAM_PUBKEY=");
    expect(out).toContain("PLEXUS_WORKLOAD=laptop");
    // The management key the admin gate requires WAS presented.
    expect(stub.lastKeyPresented).toBe(KEY);
  });

  it("defaults the workload to <name> when --workload is omitted", async () => {
    const out = await capture(() => runMesh(["mint", "--url", baseUrl, "--key", KEY]));
    expect(out).toContain("PLEXUS_WORKLOAD=<name>");
  });

  it("--json emits the raw mint result", async () => {
    const out = await capture(() => runMesh(["mint", "--url", baseUrl, "--key", KEY, "--json"]));
    const doc = JSON.parse(out) as { token: string; tunnelPort: number; primaryPubKey: string };
    expect(doc.token).toBe(stub.issued[0]!);
    expect(doc.tunnelPort).toBe(7099);
    expect(doc.primaryPubKey).toBe(PUBKEY);
  });

  it("each mint yields a DISTINCT single-use token (never reissued)", async () => {
    await capture(() => runMesh(["mint", "--url", baseUrl, "--key", KEY]));
    await capture(() => runMesh(["mint", "--url", baseUrl, "--key", KEY]));
    expect(stub.issued.length).toBe(2);
    expect(stub.issued[0]).not.toBe(stub.issued[1]);
  });

  it("--ttl is parsed to ttlMs and forwarded", async () => {
    await capture(() => runMesh(["mint", "--url", baseUrl, "--key", KEY, "--ttl", "1h"]));
    expect(stub.lastTtlMs).toBe(3_600_000);
  });

  it("a bad --ttl is a usage error (exit 2), no request sent", async () => {
    stub.issued = [];
    await expect(runMesh(["mint", "--url", baseUrl, "--key", KEY, "--ttl", "nope"])).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(stub.issued.length).toBe(0);
  });

  it("a proxy gateway (409) surfaces as a CLI error (exit 5)", async () => {
    stub.notPrimary = true;
    await expect(runMesh(["mint", "--url", baseUrl, "--key", KEY])).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it("a wrong key (401) surfaces as a CLI error", async () => {
    await expect(runMesh(["mint", "--url", baseUrl, "--key", "wrong"])).rejects.toBeInstanceOf(MeshCliError);
  });
});

describe("A1 CLI: plexus mesh status", () => {
  it("reports the mesh posture", async () => {
    const out = await capture(() => runMesh(["status", "--url", baseUrl, "--key", KEY]));
    expect(out).toContain("mode:");
    expect(out).toContain("primary");
    expect(out).toContain("7099");
  });
});
