/**
 * T2 — Gateway Mode in config/boot (mesh §0, Invariant A; §7 Q8 backward-compat).
 *
 * The authority MODE is boot-fixed: read ONCE in `loadConfig()` from `PLEXUS_MODE`,
 * never mutated. This suite pins:
 *
 *   1. ENV MATRIX — no-env → `primary` (today's default, zero mesh leakage);
 *      `proxy` + an upstream URL → ok (mode + upstream materialized);
 *      `proxy` WITHOUT an upstream URL → FAIL FAST (clear, actionable throw);
 *      an unknown `PLEXUS_MODE` value → throws; tenant/workload pass through.
 *   2. Q8 REGRESSION (boot-smoke) — a no-env gateway is a `primary` with ZERO
 *      behavior change: its `.well-known` carries NONE of the mesh slice
 *      (mode/upstream/tenant/workload never leak onto the agent-facing surface),
 *      i.e. byte-for-byte today's document.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { WellKnownDocument } from "@plexus/protocol";
import { loadConfig, expectedHost, DEFAULT_GATEWAY_MODE } from "@plexus/runtime/config.ts";
import { createApp } from "@plexus/runtime/core/index.ts";

/** The mesh env keys this task introduces — cleared around every case for isolation. */
const MESH_ENV_KEYS = [
  "PLEXUS_MODE",
  "PLEXUS_UPSTREAM_URL",
  "PLEXUS_WORKLOAD",
  "PLEXUS_TENANT",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of MESH_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MESH_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig() — boot-fixed authority mode (Invariant A)", () => {
  it("defaults to primary with no mesh slice when no env is set (Q8)", () => {
    const config = loadConfig();
    expect(config.mode).toBe("primary");
    expect(DEFAULT_GATEWAY_MODE).toBe("primary");
    expect(config.upstream).toBeUndefined();
    expect(config.tenant).toBeUndefined();
    expect(config.workload).toBeUndefined();
  });

  it("resolves proxy + upstream when PLEXUS_MODE=proxy and PLEXUS_UPSTREAM_URL is set", () => {
    process.env.PLEXUS_MODE = "proxy";
    process.env.PLEXUS_UPSTREAM_URL = "wss://primary.example/tunnel";
    const config = loadConfig();
    expect(config.mode).toBe("proxy");
    expect(config.upstream).toEqual({
      url: "wss://primary.example/tunnel",
      primaryPubKey: "",
    });
  });

  it("FAILS FAST when PLEXUS_MODE=proxy without an upstream URL", () => {
    process.env.PLEXUS_MODE = "proxy";
    expect(() => loadConfig()).toThrow(/PLEXUS_UPSTREAM_URL/);
  });

  it("rejects an unknown PLEXUS_MODE value loudly", () => {
    process.env.PLEXUS_MODE = "secondary";
    expect(() => loadConfig()).toThrow(/invalid PLEXUS_MODE/);
  });

  it("treats an explicit PLEXUS_MODE=primary as the default (no upstream required)", () => {
    process.env.PLEXUS_MODE = "primary";
    const config = loadConfig();
    expect(config.mode).toBe("primary");
    expect(config.upstream).toBeUndefined();
  });

  it("ignores a stray upstream URL on a primary (a primary dials no one)", () => {
    process.env.PLEXUS_MODE = "primary";
    process.env.PLEXUS_UPSTREAM_URL = "wss://primary.example/tunnel";
    const config = loadConfig();
    expect(config.mode).toBe("primary");
    expect(config.upstream).toBeUndefined();
  });

  it("passes tenant + workload through from env", () => {
    process.env.PLEXUS_TENANT = "acme";
    process.env.PLEXUS_WORKLOAD = "laptop";
    const config = loadConfig();
    expect(config.tenant).toBe("acme");
    expect(config.workload).toBe("laptop");
  });

  it("treats blank tenant/workload as absent (trimmed → undefined)", () => {
    process.env.PLEXUS_TENANT = "   ";
    process.env.PLEXUS_WORKLOAD = "";
    const config = loadConfig();
    expect(config.tenant).toBeUndefined();
    expect(config.workload).toBeUndefined();
  });
});

describe("Q8 boot-smoke — no-env primary `.well-known` is unchanged", () => {
  it("never leaks the mesh slice onto the agent-facing surface", async () => {
    const config = loadConfig();
    expect(config.mode).toBe("primary");
    const app = createApp(config);
    const host = expectedHost(config);

    const res = await app.request("http://" + host + "/.well-known/plexus", {
      headers: { host },
    });
    expect(res.status).toBe(200);

    const raw = await res.text();
    // The mesh boot config is invisible on the agent wire (additive, Q8). None of the
    // T2 keys may appear anywhere in the served document.
    expect(raw).not.toContain("upstream");
    expect(raw).not.toContain("proxy");
    expect(raw).not.toContain("workload");
    expect(raw).not.toContain("tenant");
    expect(raw).not.toMatch(/"mode"/);

    const doc = JSON.parse(raw) as WellKnownDocument & Record<string, unknown>;
    expect(doc.gateway.name).toBe("plexus");
    expect((doc as Record<string, unknown>).mode).toBeUndefined();
    expect((doc as Record<string, unknown>).upstream).toBeUndefined();
  });
});
