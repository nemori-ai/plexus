/**
 * t7 ADAPTER — workflow re-entrant fan-out (ADR-013/ADR-012, review #3/#6).
 *
 * Proves:
 *   1. The workflow transport's dispatch RE-ENTERS the pipeline via ctx.invokeById
 *      per member — the core never branches on kind:"workflow"; fan-out is "just a
 *      transport" calling back through the SAME invoke path.
 *   2. A mid-fan-out revocation halts subsequent members (fail-fast): once
 *      invokeById returns token_revoked for a member, later members are NOT called.
 */

import { describe, it, expect } from "bun:test";
import { getPlatformServices } from "../src/platform/index.ts";
import { buildTransports } from "../src/transports/index.ts";
import { BaseCapabilityBridge } from "../src/sources/base.ts";
import { mockEntries } from "../src/sources/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityEntry,
  CapabilityId,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  Transport,
  TransportKind,
} from "@plexus/protocol";

function makeAudit() {
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `audit-${events.length}`, at: new Date().toISOString() };
  };
  return { audit, events };
}

const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

describe("adapter: workflow transport re-enters the invoke pipeline", () => {
  it("fans out to each member via invokeById (core does not branch on kind)", async () => {
    const platform = getPlatformServices();
    const transports = buildTransports(platform);
    const entries = mockEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const { audit, events } = makeAudit();
    const invokedMembers: CapabilityId[] = [];

    // Stubbed invokeById: the re-entrant pipeline. Records each member dispatch and
    // returns ok — proving the workflow transport calls back through this seam.
    const invokeById = async (req: InvokeRequest, _c: InvokeContext): Promise<InvokeResponse> => {
      invokedMembers.push(req.id);
      return { id: req.id, ok: true, output: { ran: req.id }, auditId: "member-audit" };
    };

    const deps: BridgeDeps = {
      audit,
      getTransport: (k: TransportKind): Transport => transports[k],
      getEntry: (id) => byId.get(id),
      invokeById,
    };

    const bridge = new BaseCapabilityBridge("mock", deps, "s1", entries);
    const workflow = byId.get("mock.pipeline.run") as CapabilityEntry;
    expect(workflow.kind).toBe("workflow");
    expect(workflow.transport).toBe("workflow");

    // The bridge's UNIFORM invoke() resolves the workflow transport (no kind branch)
    // and the transport re-enters via invokeById per member.
    const res = await bridge.invoke({ id: "mock.pipeline.run" }, ctx);

    expect(res.ok).toBe(true);
    // Members fanned out IN ORDER through the re-entrant pipeline.
    expect(invokedMembers).toEqual(["mock.echo.run", "mock.note.write"]);
    // The workflow invocation itself was audited exactly once at the bridge level.
    expect(events.filter((e) => e.capabilityId === "mock.pipeline.run").length).toBe(1);
  });

  it("halts the fan-out when a member dispatch comes back token_revoked", async () => {
    const platform = getPlatformServices();
    const transports = buildTransports(platform);
    const entries = mockEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const { audit } = makeAudit();

    const invokedMembers: CapabilityId[] = [];
    // Simulate a mid-fan-out revoke: the FIRST member dispatch fails with
    // token_revoked (as the core pipeline would, re-checking the originating jti
    // before each member). The workflow transport must NOT call the second member.
    const invokeById = async (req: InvokeRequest): Promise<InvokeResponse> => {
      invokedMembers.push(req.id);
      if (req.id === "mock.echo.run") {
        return {
          id: req.id,
          ok: false,
          error: { code: "token_revoked", message: "revoked mid-fan-out", capabilityId: req.id },
          auditId: "member-audit",
        };
      }
      return { id: req.id, ok: true, auditId: "member-audit" };
    };

    const deps: BridgeDeps = {
      audit,
      getTransport: (k: TransportKind): Transport => transports[k],
      getEntry: (id) => byId.get(id),
      invokeById,
    };

    const bridge = new BaseCapabilityBridge("mock", deps, "s1", entries);
    const res = await bridge.invoke({ id: "mock.pipeline.run" }, ctx);

    expect(res.ok).toBe(false);
    // FAIL-FAST: only the first member was attempted; the rest were halted.
    expect(invokedMembers).toEqual(["mock.echo.run"]);
    // The originating revocation surfaces back to the caller.
    expect(res.error?.code).toBe("token_revoked");
  });

  it("a skill entry is read-as-context and is not invoked over a wire", async () => {
    const platform = getPlatformServices();
    const transports = buildTransports(platform);
    const entries = mockEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const { audit } = makeAudit();

    const deps: BridgeDeps = {
      audit,
      getTransport: (k: TransportKind): Transport => transports[k],
      getEntry: (id) => byId.get(id),
      invokeById: async (req) => ({ id: req.id, ok: true, auditId: "x" }),
    };
    const bridge = new BaseCapabilityBridge("mock", deps, "s1", entries);
    const res = await bridge.invoke({ id: "mock.echo.howto" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("read-as-context");
  });
});
