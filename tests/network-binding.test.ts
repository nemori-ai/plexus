/**
 * FEAT configurable-binding — the network-binding relaxation + its SECURITY re-gating.
 *
 * Plexus has been strictly loopback-only (the trust boundary). This makes the bind
 * CONFIGURABLE: default = loopback (127.0.0.1) UNCHANGED; the user may scan the
 * machine's interfaces and ALSO bind a chosen IP, or bind all (0.0.0.0). Opening the
 * network makes the CONNECTION-KEY the trust boundary, so this suite proves BOTH the
 * relaxation AND the re-gating that ships with it:
 *
 *   1. CONFIG — default config binds loopback only (unchanged); validate/persist the
 *      bind-address choice (loopback / a real local IP / 0.0.0.0; bogus → rejected).
 *   2. GUARD — with ONLY loopback bound the Host guard still REJECTS a LAN-IP Host;
 *      with a LAN IP configured the guard ACCEPTS that Host (and only that); loopback
 *      is always accepted; the DNS-rebinding defense for the default case is intact.
 *   3. LISTEN SEAM — a single loopback bind behaves exactly as before; a multi-address
 *      bind on an ephemeral port shares ONE port + stop() stops them all.
 *   4. RE-GATING — every /admin/api/* DATA read now → 401 WITHOUT the key, 200 WITH it
 *      (capabilities/health/sources/audit); the SPA HTML catch-all still serves WITHOUT
 *      a key; the public agent surface (.well-known/handshake) is unaffected.
 *   5. ENDPOINTS — GET /admin/api/interfaces returns the scan; GET /admin/api/network
 *      reports config+active+port; POST /admin/api/network validates + persists +
 *      rejects a bogus address (all key-gated).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import {
  loadConfig,
  expectedHost,
  scanNetworkInterfaces,
  validateBindAddresses,
  validatePublicHostnames,
  writeNetworkConfig,
  loadNetworkConfig,
} from "@plexus/runtime/config.ts";
import {
  buildHostOriginPolicy,
  checkHostOrigin,
  buildBoundHostSet,
} from "@plexus/runtime/core/index.ts";
import { listen } from "@plexus/runtime/runtime/listen.ts";

const baseConfig = loadConfig();
const LOOPBACK_HOST = expectedHost(baseConfig); // "127.0.0.1:7077"
const dirs: string[] = [];

/** Build an app under a throwaway PLEXUS_HOME, optionally with network overrides. */
function freshApp(bindAddresses?: string[], publicHostnames?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "plexus-netbind-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  const config = {
    ...baseConfig,
    ...(bindAddresses ? { bindAddresses } : {}),
    ...(publicHostnames ? { publicHostnames } : {}),
  };
  const built = createAppWithState(config);
  return { ...built, config, key: built.state.connectionKey.current(), dir };
}

/** A request with an explicit Host. `key` controls the management header. */
function req(
  app: ReturnType<typeof freshApp>["app"],
  path: string,
  opts: { method?: string; body?: unknown; key?: string | null; host?: string } = {},
) {
  const host = opts.host ?? LOOPBACK_HOST;
  const headers: Record<string, string> = { host };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key) headers["X-Plexus-Connection-Key"] = opts.key;
  return app.request("http://" + host + path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** The first NON-internal IPv4 interface address on this machine, if any (for LAN tests). */
function firstLanIPv4(): string | undefined {
  return scanNetworkInterfaces().find((i) => i.family === "IPv4" && !i.internal)?.address;
}

afterAll(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 1. CONFIG — default loopback-only + validate/persist
// ════════════════════════════════════════════════════════════════════════════
describe("netbind 1: config defaults to loopback only + validates a chosen bind set", () => {
  it("default config binds ONLY loopback (unchanged behavior)", () => {
    expect([...baseConfig.bindAddresses]).toEqual(["127.0.0.1"]);
  });

  it("loadNetworkConfig with no file → loopback-only default", () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-netcfg-"));
    dirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    expect(loadNetworkConfig().bindAddresses).toEqual(["127.0.0.1"]);
  });

  it("validateBindAddresses ACCEPTS loopback / 0.0.0.0 / a real local IP", () => {
    const local = new Set(["10.1.2.3"]);
    expect(validateBindAddresses(["127.0.0.1"], local)).toMatchObject({ ok: true, bindAddresses: ["127.0.0.1"] });
    expect(validateBindAddresses(["0.0.0.0"], local)).toMatchObject({ ok: true, bindAddresses: ["0.0.0.0"] });
    expect(validateBindAddresses(["127.0.0.1", "10.1.2.3"], local)).toMatchObject({
      ok: true,
      bindAddresses: ["127.0.0.1", "10.1.2.3"],
    });
  });

  it("REJECTS a bogus / non-local address (not a real interface)", () => {
    const r = validateBindAddresses(["8.8.8.8"], new Set(["10.1.2.3"]));
    expect(r.ok).toBe(false);
    expect(r.rejected).toContain("8.8.8.8");
    // Fail-safe: never silently widens — falls back to loopback-only.
    expect(r.bindAddresses).toEqual(["127.0.0.1"]);
  });

  it("REJECTS 0.0.0.0 mixed with a specific IP (ambiguous)", () => {
    const r = validateBindAddresses(["0.0.0.0", "10.1.2.3"], new Set(["10.1.2.3"]));
    expect(r.ok).toBe(false);
  });

  it("writeNetworkConfig persists a valid choice to network.json (and reloads it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-netpersist-"));
    dirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    const lan = firstLanIPv4();
    const choice = lan ? ["127.0.0.1", lan] : ["127.0.0.1"];
    const res = writeNetworkConfig(choice);
    expect(res.ok).toBe(true);
    expect(res.bindAddresses).toEqual(choice);
    const file = join(dir, "network.json");
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; bindAddresses: string[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.bindAddresses).toEqual(choice);
    expect(loadNetworkConfig().bindAddresses).toEqual(choice);
  });

  it("writeNetworkConfig does NOT persist a bogus address (nothing written)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-netbad-"));
    dirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    const res = writeNetworkConfig(["8.8.8.8"]);
    expect(res.ok).toBe(false);
    expect(existsSync(join(dir, "network.json"))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. GUARD — accept configured binds, reject everything else; loopback always ok
// ════════════════════════════════════════════════════════════════════════════
describe("netbind 2: Host guard matches the configured/active bind set", () => {
  const policy = buildHostOriginPolicy(baseConfig);

  it("loopback-only config: a LAN-IP Host is REJECTED (default DNS-rebinding defense intact)", () => {
    const bound = buildBoundHostSet(["127.0.0.1"]); // default = no extra hosts
    expect(checkHostOrigin(policy, "192.168.1.50:7077", null, bound).ok).toBe(false);
    expect(checkHostOrigin(policy, "10.0.0.5:7077", null, bound).ok).toBe(false);
    expect(checkHostOrigin(policy, "evil.example.com:7077", null, bound).ok).toBe(false);
    // ...but loopback is still always accepted.
    expect(checkHostOrigin(policy, "127.0.0.1:7077", null, bound).ok).toBe(true);
  });

  it("with a LAN IP configured: the guard ACCEPTS that Host (and only that one)", () => {
    const bound = buildBoundHostSet(["127.0.0.1", "10.0.0.5"]);
    expect(checkHostOrigin(policy, "10.0.0.5:7077", null, bound).ok).toBe(true);
    expect(checkHostOrigin(policy, "10.0.0.5", null, bound).ok).toBe(true); // bare host
    // A DIFFERENT LAN IP is still rejected (not configured) — not an open bypass.
    expect(checkHostOrigin(policy, "10.0.0.6:7077", null, bound).ok).toBe(false);
    expect(checkHostOrigin(policy, "192.168.1.50:7077", null, bound).ok).toBe(false);
    // Loopback still accepted.
    expect(checkHostOrigin(policy, "localhost:7077", null, bound).ok).toBe(true);
  });

  it("0.0.0.0 (bind-all) accepts any of THIS machine's interface IPs but not a foreign host", () => {
    const bound = buildBoundHostSet(["0.0.0.0"]);
    const lan = firstLanIPv4();
    if (lan) expect(checkHostOrigin(policy, `${lan}:7077`, null, bound).ok).toBe(true);
    // A made-up address the machine does not own is still rejected.
    expect(checkHostOrigin(policy, "203.0.113.1:7077", null, bound).ok).toBe(false);
    expect(checkHostOrigin(policy, "evil.example.com:7077", null, bound).ok).toBe(false);
    // Loopback still accepted.
    expect(checkHostOrigin(policy, "127.0.0.1:7077", null, bound).ok).toBe(true);
  });

  it("no bound set passed ⇒ loopback-only (backward-compatible default)", () => {
    expect(checkHostOrigin(policy, "127.0.0.1:7077", null).ok).toBe(true);
    expect(checkHostOrigin(policy, "10.0.0.5:7077", null).ok).toBe(false);
  });

  it("full app, loopback-only bind: a LAN-IP Host is host_forbidden (403) through the real guard", async () => {
    const lan = firstLanIPv4() ?? "10.0.0.5";
    const { app } = freshApp(); // default loopback-only
    const res = await req(app, "/.well-known/plexus", { host: `${lan}:7077` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it("full app, LAN-IP configured: that Host is ACCEPTED through the real guard", async () => {
    const lan = firstLanIPv4();
    if (!lan) return; // no non-internal interface on this host — skip
    const { app } = freshApp(["127.0.0.1", lan]);
    const res = await req(app, "/.well-known/plexus", { host: `${lan}:7077` });
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. LISTEN SEAM — single loopback unchanged; multi-bind shares a port + stops all
// ════════════════════════════════════════════════════════════════════════════
describe("netbind 3: the multi-address listen seam (ephemeral ports only)", () => {
  const ok = () => new Response("ok");

  it("a single loopback bind behaves as before (one address, concrete port)", () => {
    const h = listen({ fetch: ok, hostnames: ["127.0.0.1"], port: 0 });
    try {
      expect(h.port).toBeGreaterThan(0);
      expect(h.addresses).toEqual(["127.0.0.1"]);
    } finally {
      h.stop();
    }
  });

  it("the legacy single `hostname` path still works", () => {
    const h = listen({ fetch: ok, hostname: "127.0.0.1", port: 0 });
    try {
      expect(h.port).toBeGreaterThan(0);
      expect(h.addresses).toEqual(["127.0.0.1"]);
    } finally {
      h.stop();
    }
  });

  it("multiple addresses share ONE ephemeral port and stop() stops them all", () => {
    const lan = firstLanIPv4();
    const addrs = lan ? ["127.0.0.1", lan] : ["127.0.0.1", "::1"];
    const h = listen({ fetch: ok, hostnames: addrs, port: 0 });
    try {
      expect(h.port).toBeGreaterThan(0);
      // Every requested address bound on the SAME port.
      expect(h.addresses).toEqual(addrs);
    } finally {
      h.stop(); // must not throw — stops every underlying server
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. RE-GATING — every /admin/api/* DATA read key-gated; SPA + agent surface free
// ════════════════════════════════════════════════════════════════════════════
describe("netbind 4: every /admin/api/* DATA read is now management-key gated", () => {
  const READS = [
    "/admin/api/capabilities",
    "/admin/api/health",
    "/admin/api/sources",
    "/admin/api/audit",
    "/admin/api/tokens",
    "/admin/api/pending",
    "/admin/api/grants",
    "/admin/api/connectors",
    "/admin/api/interfaces",
    "/admin/api/network",
    "/admin/api/cc-master/config",
    "/admin/api/sources/detect",
    "/admin/api/extensions",
    "/admin/api/extensions/authoring-guide",
  ];

  it("each read → 401 WITHOUT the key", async () => {
    const { app } = freshApp();
    for (const path of READS) {
      const res = await req(app, path);
      expect(res.status).toBe(401);
    }
  });

  it("each read → 200 WITH the key", async () => {
    const { app, key } = freshApp();
    for (const path of READS) {
      const res = await req(app, path, { key });
      expect(res.status).toBe(200);
    }
  });

  it("the SPA HTML catch-all STILL serves WITHOUT a key (so the page can load)", async () => {
    const { app } = freshApp();
    // `/admin` and any non-/api path serve the SPA (index.html / NOT_BUILT fallback) —
    // always 200, never 401 (the page must load to then resolve the key out-of-band).
    for (const path of ["/admin", "/admin/", "/admin/settings"]) {
      const res = await req(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("html");
    }
  });

  it("an unknown /admin/api/* path is still NOT served the SPA (F2 — no key → 401)", async () => {
    const { app, key } = freshApp();
    // Without a key the blanket gate answers 401; with the key it's a real 404 (no route).
    expect((await req(app, "/admin/api/connection-key")).status).toBe(401);
    expect((await req(app, "/admin/api/connection-key", { key })).status).toBe(404);
  });

  it("the PUBLIC agent protocol surface is UNAFFECTED (no admin key needed)", async () => {
    const { app } = freshApp();
    // .well-known is public (unauthenticated, summary tier).
    expect((await req(app, "/.well-known/plexus")).status).toBe(200);
    // handshake takes the CONNECTION-KEY in its body (its own auth), not the admin header.
    const hs = await req(app, "/link/handshake", {
      method: "POST",
      body: { connectionKey: "wrong-key", client: { name: "t" } },
    });
    // It reaches the handshake handler (NOT the admin 401 gate) — a wrong key is the
    // handshake's OWN rejection, proving the route isn't behind the /admin/api gate.
    expect(hs.status).not.toBe(404);
    const body = (await hs.json()) as { error?: { code?: string } };
    // The admin gate would say "unauthorized"; the handshake says its own code.
    expect(body.error?.code).not.toBe("unauthorized");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. ENDPOINTS — interfaces scan + network get/set (all key-gated)
// ════════════════════════════════════════════════════════════════════════════
describe("netbind 5: interfaces + network admin endpoints", () => {
  it("GET /admin/api/interfaces returns the network scan (IPv4 + IPv6, internal flag)", async () => {
    const { app, key } = freshApp();
    const res = await req(app, "/admin/api/interfaces", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { interfaces: { name: string; address: string; family: string; internal: boolean }[] };
    expect(Array.isArray(body.interfaces)).toBe(true);
    // The loopback interface is always present and marked internal.
    expect(body.interfaces.some((i) => i.address === "127.0.0.1" && i.internal)).toBe(true);
    for (const i of body.interfaces) {
      expect(typeof i.name).toBe("string");
      expect(["IPv4", "IPv6"]).toContain(i.family);
    }
  });

  it("GET /admin/api/network reports config + active + boundPort", async () => {
    const { app, key } = freshApp();
    const res = await req(app, "/admin/api/network", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindAddresses: string[]; active: string[]; boundPort: number };
    expect(body.bindAddresses).toEqual(["127.0.0.1"]);
    // No real socket bound in this in-process app test → active falls back to config.
    expect(body.active).toEqual(["127.0.0.1"]);
    expect(typeof body.boundPort).toBe("number");
  });

  it("POST /admin/api/network validates + persists + says restartRequired", async () => {
    const { app, key, dir } = freshApp();
    const lan = firstLanIPv4();
    const choice = lan ? ["127.0.0.1", lan] : ["127.0.0.1"];
    const res = await req(app, "/admin/api/network", { method: "POST", key, body: { bindAddresses: choice } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bindAddresses: string[]; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.bindAddresses).toEqual(choice);
    expect(body.restartRequired).toBe(true);
    // Persisted to network.json under the throwaway home.
    expect(existsSync(join(dir, "network.json"))).toBe(true);
  });

  it("POST /admin/api/network REJECTS a bogus address (400, nothing persisted)", async () => {
    const { app, key, dir } = freshApp();
    const res = await req(app, "/admin/api/network", { method: "POST", key, body: { bindAddresses: ["8.8.8.8"] } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string }; rejected?: string[] };
    expect(body.rejected).toContain("8.8.8.8");
    expect(existsSync(join(dir, "network.json"))).toBe(false);
  });

  it("POST /admin/api/network with NO key → 401 (re-gated like every admin route)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/network", { method: "POST", body: { bindAddresses: ["127.0.0.1"] } });
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. PUBLIC HOSTNAMES (FEAT public-hostname) — publish the gateway behind an edge
//    (e.g. a Cloudflare Tunnel): the guard accepts the published Host + https
//    Origin, and the advertised base becomes https://<hostname> so a REMOTE agent
//    reads reachable endpoint URLs. Default (none configured) is byte-for-byte
//    unchanged.
// ════════════════════════════════════════════════════════════════════════════
describe("netbind 6: public hostnames — validation, persistence, guard, advertised base", () => {
  it("validatePublicHostnames ACCEPTS DNS names (lowercased, deduped); REJECTS IPs/schemes/ports/single labels", () => {
    const ok = validatePublicHostnames(["GW.Example.COM", "gw.example.com", "mesh.example.com"]);
    expect(ok.ok).toBe(true);
    expect(ok.publicHostnames).toEqual(["gw.example.com", "mesh.example.com"]);
    for (const bad of [
      "8.8.8.8",
      "https://gw.example.com",
      "gw.example.com:443",
      "localhost",
      "gw",
      "-x.example.com",
      // IP SPELLINGS the "never IPs" guard must reject — canonical, shorthand, and hex/octal
      // all resolve to a loopback/routable authority the DNS-rebinding defense exists to bar.
      "127.1",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "10.0.0.1",
    ]) {
      const r = validatePublicHostnames([bad]);
      expect(r.ok).toBe(false);
      expect(r.publicHostnames).toEqual([]);
    }
  });

  it("writeNetworkConfig persists publicHostnames; a bind-only write PRESERVES them; [] clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-netbind-"));
    dirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    const w = writeNetworkConfig(["127.0.0.1"], ["gw.example.com"]);
    expect(w.ok).toBe(true);
    expect(loadNetworkConfig().publicHostnames).toEqual(["gw.example.com"]);
    // Bind-only write (hostnames omitted) must not clobber the persisted exposure.
    writeNetworkConfig(["127.0.0.1"]);
    expect(loadNetworkConfig().publicHostnames).toEqual(["gw.example.com"]);
    // Explicit [] clears it.
    writeNetworkConfig(["127.0.0.1"], []);
    expect(loadNetworkConfig().publicHostnames).toEqual([]);
    // An invalid hostname writes NOTHING (fail-safe).
    const bad = writeNetworkConfig(["127.0.0.1"], ["8.8.8.8"]);
    expect(bad.ok).toBe(false);
    expect(loadNetworkConfig().publicHostnames).toEqual([]);
  });

  it("guard: the published hostname is ACCEPTED (any port form); a foreign host is still 403", async () => {
    const { app } = freshApp(undefined, ["gw.example.com"]);
    // Published Host (as cloudflared forwards it) → accepted on the public agent surface.
    // Host is case-insensitive and tolerant of a trailing FQDN dot (both RFC-legal), so an
    // intermediary that preserves the user-typed case or appends the root dot still works.
    for (const host of ["gw.example.com", "gw.example.com:443", "GW.Example.Com", "gw.example.com."]) {
      const res = await req(app, "/.well-known/plexus", { host });
      expect(res.status).toBe(200);
    }
    // A hostname the owner did NOT publish stays rejected (DNS-rebinding defense intact).
    const evil = await req(app, "/.well-known/plexus", { host: "evil.example.com" });
    expect(evil.status).toBe(403);
    // Loopback unchanged.
    const loop = await req(app, "/.well-known/plexus");
    expect(loop.status).toBe(200);
  });

  it("guard: https origin of the published hostname is allowed; http (and foreign https) are not", () => {
    const config = { ...baseConfig, publicHostnames: ["gw.example.com"] };
    const policy = buildHostOriginPolicy(config);
    const bound = buildBoundHostSet(config.bindAddresses, config.publicHostnames);
    expect(checkHostOrigin(policy, "gw.example.com", "https://gw.example.com", bound).ok).toBe(true);
    expect(checkHostOrigin(policy, "gw.example.com", "http://gw.example.com", bound).ok).toBe(false);
    expect(checkHostOrigin(policy, "gw.example.com", "https://evil.example.com", bound).ok).toBe(false);
  });

  it("advertised base: .well-known + install command carry https://<hostname> (loopback otherwise)", async () => {
    const { app } = freshApp(undefined, ["gw.example.com"]);
    const res = await req(app, "/.well-known/plexus", { host: "gw.example.com" });
    const doc = (await res.json()) as {
      gateway: { baseUrl: string };
      auth: { handshakeUrl: string; enrollmentUrl?: string };
    };
    expect(doc.gateway.baseUrl).toBe("https://gw.example.com");
    expect(doc.auth.handshakeUrl).toBe("https://gw.example.com/link/handshake");
    // Default config (no public hostname) stays loopback — byte-for-byte unchanged.
    const { app: plainApp } = freshApp();
    const plain = (await (await req(plainApp, "/.well-known/plexus")).json()) as {
      gateway: { baseUrl: string };
    };
    expect(plain.gateway.baseUrl).toBe(`http://${LOOPBACK_HOST}`);
  });

  it("PLEXUS_PUBLIC_HOSTNAME env merges (env first = canonical); invalid env entries drop", () => {
    process.env.PLEXUS_PUBLIC_HOSTNAME = "GW.Example.com, 8.8.8.8";
    try {
      const config = loadConfig();
      expect(config.publicHostnames).toEqual(["gw.example.com"]);
    } finally {
      delete process.env.PLEXUS_PUBLIC_HOSTNAME;
    }
  });

  it("admin API: GET reports publicHostnames; POST persists them (and 400s an IP)", async () => {
    const { app, key, dir } = freshApp();
    const set = await req(app, "/admin/api/network", {
      method: "POST",
      key,
      body: { bindAddresses: ["127.0.0.1"], publicHostnames: ["gw.example.com"] },
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { ok: boolean; publicHostnames: string[] };
    expect(setBody.publicHostnames).toEqual(["gw.example.com"]);
    expect(existsSync(join(dir, "network.json"))).toBe(true);
    expect(readFileSync(join(dir, "network.json"), "utf8")).toContain("gw.example.com");
    const bad = await req(app, "/admin/api/network", {
      method: "POST",
      key,
      body: { bindAddresses: ["127.0.0.1"], publicHostnames: ["8.8.8.8"] },
    });
    expect(bad.status).toBe(400);
  });
});
