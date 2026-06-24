/**
 * SECURITY #1 — local-rest transport redirect egress re-gating.
 *
 * Before the fix, `fetch()` ran with the default `redirect:"follow"`, so a loopback
 * `local-rest` listener the extension controls (passes `isAllowedHost`, gets the Bearer
 * attached) could answer `302 Location: http://<non-loopback>/…` and `fetch` would replay
 * the request — Authorization header included — to that host (SSRF + Bearer exfil).
 *
 * The fix issues the request with `redirect:"manual"` and re-runs the SAME `isAllowedHost`
 * gate on the resolved `Location` before following it. These tests drive the REAL
 * `LocalRestTransport` against hermetic loopback `Bun.serve` mocks and assert:
 *   (a) a 302 → a NON-allowed host is DENIED (host_forbidden) and the secret is NEVER sent
 *       to the redirect target;
 *   (b) a 302 → an allowed loopback host is FOLLOWED and succeeds (secret re-attached);
 *   (c) a redirect loop exceeding the hop limit fails cleanly (no hang, no leak).
 *
 * Hermetic: loopback `Bun.serve` only; the throwaway secret lives in a temp PLEXUS_HOME.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { LocalRestTransport } from "@plexus/runtime/transports/local-rest.ts";
import type { CapabilityEntry } from "@plexus/protocol";

const API_KEY = "THROWAWAY-REDIRECT-KEY";
const SECRET_NAME = "redirect-test-api-key";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function provisionSecret() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-redirect-home-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(join(dir, "secrets", SECRET_NAME), API_KEY);
  _resetSecretCacheForTests();
}

beforeEach(provisionSecret);
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  delete process.env.PLEXUS_HOME;
});
afterAll(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** A loopback entry whose READ capability targets `baseUrl`/path, Bearer-authenticated. */
function readEntry(baseUrl: string): CapabilityEntry {
  return {
    id: "redirect-test.read",
    source: "redirect-test",
    kind: "capability",
    label: "x",
    describe: "x",
    grants: ["read"],
    transport: "local-rest",
    extras: {
      route: {
        baseUrl,
        pathTemplate: "/go",
        secret: { name: SECRET_NAME, attach: "bearer" },
      },
    },
  };
}

describe("local-rest redirect re-gating (SECURITY #1)", () => {
  it("(a) DENIES a 302 → a non-allowed host and never sends the secret to the redirect target", async () => {
    // The "evil" target stands in for a non-loopback/metadata host. We make it reachable on
    // loopback to PROVE the deny is from the egress gate, not from unreachability — and we
    // record whether it ever saw the Authorization header (it must NOT).
    let evilHit = false;
    let evilAuth: string | null = "UNSET";
    const evil = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        evilHit = true;
        evilAuth = req.headers.get("authorization");
        return Response.json({ pwned: true });
      },
    });
    servers.push(evil);

    // The loopback listener the extension "controls": it 302s to a host the gate will reject.
    // We force a non-loopback hostname via the Location so `isAllowedHost` denies it; the
    // redirect target host ("attacker.example") is unresolvable but must never be contacted.
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: "http://attacker.example/secret-sink" },
        });
      },
    });
    servers.push(redirector);

    const transport = new LocalRestTransport(getPlatformServices());
    const r = await transport.dispatch(readEntry(`http://127.0.0.1:${redirector.port}`), {});

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("host_forbidden");
    // The secret was never replayed to the redirect target.
    expect(evilHit).toBe(false);
    expect(evilAuth).toBe("UNSET");
  });

  it("(b) FOLLOWS a 302 → an allowed loopback host and succeeds (secret re-attached)", async () => {
    // Final loopback destination: requires the Bearer key, returns the payload.
    let finalAuth: string | null = "UNSET";
    const final = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        finalAuth = req.headers.get("authorization");
        if (finalAuth !== `Bearer ${API_KEY}`) {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ ok: true, where: "final" });
      },
    });
    servers.push(final);

    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${final.port}/landed` },
        });
      },
    });
    servers.push(redirector);

    const transport = new LocalRestTransport(getPlatformServices());
    const r = await transport.dispatch(readEntry(`http://127.0.0.1:${redirector.port}`), {});

    expect(r.ok).toBe(true);
    expect((r.data as { where?: string }).where).toBe("final");
    // The Bearer was re-attached to the followed loopback hop.
    expect(finalAuth).toBe(`Bearer ${API_KEY}`);
  });

  it("(c) fails cleanly on a redirect loop that exceeds the hop limit", async () => {
    let hits = 0;
    let loopLocation = "";
    const looper = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(): Response {
        hits++;
        // Always redirect back to itself (a loop) — must be bounded, not infinite.
        return new Response(null, { status: 302, headers: { location: loopLocation } });
      },
    });
    servers.push(looper);
    loopLocation = `http://127.0.0.1:${looper.port}/again`;

    const transport = new LocalRestTransport(getPlatformServices());
    const r = await transport.dispatch(readEntry(`http://127.0.0.1:${looper.port}`), {});

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("transport_error");
    expect(String(r.error?.message)).toContain("too many redirects");
    // Bounded: initial hop + MAX_REDIRECT_HOPS(=3) follows = 4 requests, not an unbounded loop.
    expect(hits).toBeLessThanOrEqual(4);
  });
});
