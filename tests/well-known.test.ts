/**
 * Endpoint gate test: `GET /.well-known/plexus` returns a structurally-valid
 * `WellKnownDocument` that honors the frozen contract (§2, ADR-008).
 */

import { describe, it, expect } from "bun:test";
import type { WellKnownDocument } from "@plexus/protocol";
import { PLEXUS_PROTOCOL_VERSION } from "@plexus/protocol";
import { createApp } from "@plexus/runtime/core/index.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";

const config = loadConfig();
const app = createApp(config);
const HOST = expectedHost(config);

describe("GET /.well-known/plexus", () => {
  it("returns a structurally-valid WellKnownDocument", async () => {
    const res = await app.request("http://" + HOST + "/.well-known/plexus", {
      headers: { host: HOST },
    });
    expect(res.status).toBe(200);

    const doc = (await res.json()) as WellKnownDocument;

    // gateway identity block
    expect(doc.gateway.name).toBe("plexus");
    expect(typeof doc.gateway.version).toBe("string");
    expect(typeof doc.gateway.protocol).toBe("string");
    expect(doc.gateway.baseUrl).toContain("127.0.0.1");

    // protocol version (bumped to 0.1.3 — enrollment/PAT self-description reconciliation, ADR-4/ADR-5)
    expect(PLEXUS_PROTOCOL_VERSION).toBe("0.1.3");
    expect(doc.gateway.protocol).toBe("0.1");

    // capabilities is the SUMMARY tier — an array (empty in M0, structurally valid)
    expect(Array.isArray(doc.capabilities)).toBe(true);

    // auth advertisement carries every session-scoped endpoint URL (ADR-016)
    expect(doc.auth.handshakeUrl).toContain("/link/handshake");
    expect(doc.auth.grantsUrl).toContain("/grants");
    expect(doc.auth.refreshUrl).toContain("/grants/refresh");
    expect(doc.auth.revokeUrl).toContain("/grants/revoke");
    expect(doc.auth.grantStatusUrl).toContain("/grants/status");
    expect(doc.auth.invokeUrl).toContain("/invoke");
    expect(doc.auth.manifestUrl).toContain("/manifest");
    expect(doc.auth.eventsUrl).toContain("/events");
    expect(doc.auth.connectionKeyDelivery).toBe("user-paste");
    expect(doc.auth.tokenScheme).toBe("plexus-scoped-jwt");
  });

  it("rejects a request whose Host is not the bound loopback authority (host_forbidden)", async () => {
    const res = await app.request("http://evil.example/.well-known/plexus", {
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("host_forbidden");
  });
});
