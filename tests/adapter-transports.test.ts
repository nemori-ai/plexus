/**
 * t7 ADAPTER — leaf transport smoke tests (cli over the real platform seam).
 *
 * Proves the cli transport genuinely spawns a binary via the platform seam and
 * captures stdout, and that the bridge normalizes a real transport result into an
 * InvokeResponse with an audit id.
 */

import { describe, it, expect } from "bun:test";
import { getPlatformServices } from "../src/platform/index.ts";
import { CliTransport } from "../src/transports/cli.ts";
import { BaseCapabilityBridge, normalizeResult } from "../src/sources/base.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityEntry,
  InvokeContext,
  Transport,
  TransportKind,
} from "@plexus/protocol";

const ctx: InvokeContext = { jti: "j", sessionId: "s", scopes: [] };

describe("adapter: cli transport (real spawn via platform seam)", () => {
  it("spawns echo and captures stdout", async () => {
    const cli = new CliTransport(getPlatformServices());
    const entry: CapabilityEntry = {
      id: "mock.echo.run",
      source: "mock",
      kind: "capability",
      label: "Echo",
      describe: "Echo",
      grants: ["read"],
      transport: "cli",
      extras: { route: { bin: "echo", args: ["{text}"] } },
    };
    const r = await cli.dispatch(entry, { text: "plexus-ok" });
    expect(r.ok).toBe(true);
    expect(String(r.data).trim()).toBe("plexus-ok");
  });

  it("normalizeResult maps a failed transport result to ok:false", () => {
    const norm = normalizeResult(
      "x.y.z",
      { ok: false, error: { code: "transport_error", message: "boom" } },
      "aud-1",
    );
    expect(norm.ok).toBe(false);
    expect(norm.error?.code).toBe("transport_error");
    expect(norm.auditId).toBe("aud-1");
  });

  it("bridge.invoke routes cli + emits exactly one audit event", async () => {
    const events: AuditEventInput[] = [];
    const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a${events.length}`, at: new Date().toISOString() };
    };
    const cli = new CliTransport(getPlatformServices());
    const entry: CapabilityEntry = {
      id: "mock.echo.run",
      source: "mock",
      kind: "capability",
      label: "Echo",
      describe: "Echo",
      grants: ["read"],
      transport: "cli",
      extras: { route: { bin: "echo", args: ["hi"] } },
    };
    const deps: BridgeDeps = {
      audit,
      getTransport: (k: TransportKind): Transport => (k === "cli" ? cli : (undefined as never)),
      getEntry: (id) => (id === entry.id ? entry : undefined),
      invokeById: async (req) => ({ id: req.id, ok: true, auditId: "x" }),
    };
    const bridge = new BaseCapabilityBridge("mock", deps, "s", [entry]);
    const res = await bridge.invoke({ id: "mock.echo.run" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.auditId).toBe("a1");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("invoke");
    // Redaction discipline: detail carries shapes/ids, never raw input values.
    expect(JSON.stringify(events[0]!.detail ?? {})).not.toContain("hi");
  });
});
