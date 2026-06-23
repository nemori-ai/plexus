/**
 * tfix1 — Host/Origin guard accepts ANY loopback authority (any port), not just
 * the configured port. Motivation: an ephemeral-port bind (`Bun.serve({ port: 0 })`)
 * reads an OS-assigned port (e.g. 127.0.0.1:54321) that diverges from `config.port`;
 * the old guard pinned the Host to the configured authority and rejected every such
 * request `host_forbidden`. The security property is "loopback only" (an attacker on
 * loopback can reach any local port anyway), so any-port loopback is safe — while the
 * DNS-rebinding / non-loopback rejection MUST stay intact.
 */

import { describe, it, expect } from "bun:test";
import { createApp, buildHostOriginPolicy, checkHostOrigin } from "../src/core/index.ts";
import { loadConfig, expectedHost, baseUrl } from "../src/config.ts";

const config = loadConfig(); // port 7077 by default
const policy = buildHostOriginPolicy(config);
const CONFIGURED_HOST = expectedHost(config); // "127.0.0.1:7077"
// An ephemeral port DIFFERENT from the configured one — the t12 deployment scenario.
const EPHEMERAL_PORT = config.port === 54321 ? 54322 : 54321;

describe("tfix1: checkHostOrigin accepts any loopback authority", () => {
  it("allows a loopback Host on a DIFFERENT port than configured", () => {
    expect(checkHostOrigin(policy, `127.0.0.1:${EPHEMERAL_PORT}`, null).ok).toBe(true);
    expect(checkHostOrigin(policy, `localhost:${EPHEMERAL_PORT}`, null).ok).toBe(true);
  });

  it("still allows the exact configured authority (subset preserved)", () => {
    expect(checkHostOrigin(policy, CONFIGURED_HOST, null).ok).toBe(true);
  });

  it("accepts 127.0.0.1 / localhost / [::1] loopback hostnames", () => {
    expect(checkHostOrigin(policy, "127.0.0.1:9999", null).ok).toBe(true);
    expect(checkHostOrigin(policy, "localhost:9999", null).ok).toBe(true);
    expect(checkHostOrigin(policy, "[::1]:9999", null).ok).toBe(true);
    // bare hostname with no explicit port is also loopback
    expect(checkHostOrigin(policy, "localhost", null).ok).toBe(true);
    expect(checkHostOrigin(policy, "[::1]", null).ok).toBe(true);
  });

  it("REJECTS non-loopback Host (DNS-rebinding hostname) → host_forbidden", () => {
    expect(checkHostOrigin(policy, "evil.example.com", null).ok).toBe(false);
    expect(checkHostOrigin(policy, "evil.example.com:7077", null).ok).toBe(false);
  });

  it("REJECTS a LAN IP Host", () => {
    expect(checkHostOrigin(policy, "192.168.1.50:7077", null).ok).toBe(false);
    expect(checkHostOrigin(policy, "10.0.0.5:7077", null).ok).toBe(false);
    expect(checkHostOrigin(policy, "0.0.0.0:7077", null).ok).toBe(false);
  });

  it("REJECTS a hostname that merely contains a loopback substring", () => {
    expect(checkHostOrigin(policy, "127.0.0.1.evil.com:7077", null).ok).toBe(false);
    expect(checkHostOrigin(policy, "localhost.evil.com:7077", null).ok).toBe(false);
    expect(checkHostOrigin(policy, "notlocalhost:7077", null).ok).toBe(false);
  });

  it("REJECTS a missing Host", () => {
    expect(checkHostOrigin(policy, null, null).ok).toBe(false);
  });
});

describe("tfix1: checkHostOrigin Origin handling stays loopback-only", () => {
  it("allows a same-origin loopback Origin on a different port", () => {
    const r = checkHostOrigin(policy, `127.0.0.1:${EPHEMERAL_PORT}`, `http://127.0.0.1:${EPHEMERAL_PORT}`);
    expect(r.ok).toBe(true);
    expect(checkHostOrigin(policy, CONFIGURED_HOST, "http://localhost:65000").ok).toBe(true);
  });

  it("allows the configured allow-listed Origin (subset preserved)", () => {
    expect(checkHostOrigin(policy, CONFIGURED_HOST, baseUrl(config)).ok).toBe(true);
  });

  it("REJECTS a cross-origin NON-loopback Origin → host_forbidden", () => {
    const r = checkHostOrigin(policy, CONFIGURED_HOST, "http://evil.example.com");
    expect(r.ok).toBe(false);
  });

  it("REJECTS an https loopback Origin (scheme mismatch, not same-origin)", () => {
    expect(checkHostOrigin(policy, CONFIGURED_HOST, "https://127.0.0.1:7077").ok).toBe(false);
  });
});

describe("tfix1: full app on an ephemeral (non-configured) port", () => {
  it("serves .well-known for a loopback Host on a different port (ALLOWED)", async () => {
    const app = createApp(config);
    const ephemeralHost = `127.0.0.1:${EPHEMERAL_PORT}`;
    const res = await app.request("http://" + ephemeralHost + "/.well-known/plexus", {
      headers: { host: ephemeralHost },
    });
    expect(res.status).toBe(200);
  });

  it("still rejects a non-loopback Host (host_forbidden) through the real guard", async () => {
    const app = createApp(config);
    const res = await app.request("http://evil.example.com/.well-known/plexus", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it("still rejects a cross-origin non-loopback Origin (host_forbidden)", async () => {
    const app = createApp(config);
    const ephemeralHost = `127.0.0.1:${EPHEMERAL_PORT}`;
    const res = await app.request("http://" + ephemeralHost + "/.well-known/plexus", {
      headers: { host: ephemeralHost, origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });
});
