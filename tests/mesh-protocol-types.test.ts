/**
 * T1 — Protocol types & contract surface (federated mesh).
 *
 * Guards the ADDITIVE-ONLY contract (mesh domain model §7 Q8, strict-superset /
 * backward-compat invariant):
 *
 *   (a) every existing wire shape still parses UNCHANGED — a v0.1.2 object with no
 *       mesh fields is still a valid value AND JSON round-trips byte-for-byte (no
 *       new field is serialized unless the producer set it);
 *   (b) every NEW mesh field is OPTIONAL — omitting it type-checks, so a v0.1.2
 *       client that neither sets nor reads it is unaffected;
 *   (c) the new mesh value objects / Frame union round-trip through JSON.
 *
 * Mostly a COMPILE-TIME contract test (the type annotations are the assertions);
 * the runtime `expect`s pin the JSON wire behavior.
 */

import { describe, it, expect } from "bun:test";
import type {
  // existing wire shapes (must remain unchanged)
  AuditEvent,
  AuditEventInput,
  ErrorBody,
  ErrorCode,
  InvokeResponse,
  CapabilityEntry,
  // new mesh contract surface
  GatewayMode,
  TenantId,
  WorkloadName,
  CapabilityAddress,
  MeshUpstream,
  EnrollmentStatus,
  EnrollmentRecord,
  Attribution,
  Frame,
  EnrollFrame,
  CatalogFrame,
  InvokeFrame,
  InvokeResultFrame,
  AuditFrame,
  PingFrame,
} from "@plexus/protocol";

/** Compile-time assertion that `T` is assignable to `Expected` (and a no-op at runtime). */
function expectAssignable<Expected>(_value: Expected): void {
  /* type-level only */
}

describe("mesh protocol types — backward-compat (Q8 strict-superset)", () => {
  it("(a) a v0.1.2 AuditEvent with NO mesh fields still type-checks and round-trips byte-for-byte", () => {
    // Exactly the pre-mesh shape — no attribution/correlationId/tier.
    const legacy: AuditEvent = {
      type: "invoke",
      id: "evt-1",
      at: "2026-06-30T10:00:00.000Z",
      agentId: "claude-code",
      jti: "tok-1",
      capabilityId: "mcp.github.create_issue",
      verbs: ["write"],
      outcome: "ok",
    };
    // JSON round-trip must be IDENTICAL — no mesh key leaks in when unset.
    const round = JSON.parse(JSON.stringify(legacy)) as AuditEvent;
    expect(round).toEqual(legacy);
    expect(Object.keys(round).sort()).toEqual(
      ["agentId", "at", "capabilityId", "id", "jti", "outcome", "type", "verbs"].sort(),
    );
    // None of the new fields materialized.
    expect("attribution" in round).toBe(false);
    expect("correlationId" in round).toBe(false);
    expect("tier" in round).toBe(false);
  });

  it("(a) a v0.1.2 ErrorBody with NO unavailableSince still type-checks and round-trips unchanged", () => {
    const legacy: ErrorBody = {
      code: "source_unavailable",
      message: "Obsidian Local REST API not reachable",
      capabilityId: "obsidian.note.read",
    };
    const round = JSON.parse(JSON.stringify(legacy)) as ErrorBody;
    expect(round).toEqual(legacy);
    expect("unavailableSince" in round).toBe(false);
  });

  it("(a) every frozen ErrorCode value still assigns (closed-union unchanged, only extended)", () => {
    const frozen: ErrorCode[] = [
      "token_expired",
      "token_revoked",
      "grant_required",
      "grant_pending_user",
      "session_expired",
      "unknown_capability",
      "capability_unexposed",
      "schema_validation_failed",
      "source_unavailable",
      "mcp_tool_error",
      "transport_error",
      "host_forbidden",
      "rate_limited",
      "internal_error",
    ];
    expect(frozen).toHaveLength(14);
  });
});

describe("mesh protocol types — new fields are OPTIONAL (additive)", () => {
  it("(b) AuditEventInput accepts the mesh fields but does not require them", () => {
    // Without mesh fields — proves optionality.
    const bare: AuditEventInput = { type: "invoke" };
    expectAssignable<AuditEventInput>(bare);

    // With every mesh field set — proves acceptance.
    const enriched: AuditEventInput = {
      type: "invoke",
      attribution: {
        agent: "claude-code",
        principal: "alice@acme.com",
        grantRef: "grant-7",
        policyRef: "policy-3",
      },
      correlationId: "corr-abc",
      tier: "proxy",
    };
    expect(enriched.tier).toBe("proxy");
    expect(enriched.attribution?.agent).toBe("claude-code");
  });

  it("(b) ErrorBody accepts capability_unavailable + unavailableSince (Invariant E)", () => {
    const unavailable: ErrorBody = {
      code: "capability_unavailable",
      message: "capability home is down",
      capabilityId: "local/laptop/mcp.github.create_issue",
      unavailableSince: "2026-06-30T09:55:00.000Z",
    };
    const code: ErrorCode = "capability_unavailable";
    expect(unavailable.code).toBe(code);
    expect(unavailable.unavailableSince).toBe("2026-06-30T09:55:00.000Z");
  });
});

describe("mesh protocol types — new value objects round-trip", () => {
  it("GatewayMode / Tenant / Workload / CapabilityAddress are flat string-ish wire values", () => {
    const mode: GatewayMode = "primary";
    const proxyMode: GatewayMode = "proxy";
    const tenant: TenantId = "local";
    const workload: WorkloadName = "laptop";
    // URN grammar: tenant / <workload-path…> / source.capability
    const address: CapabilityAddress = `${tenant}/${workload}/mcp.github.create_issue`;
    expect([mode, proxyMode]).toEqual(["primary", "proxy"]);
    expect(address).toBe("local/laptop/mcp.github.create_issue");
  });

  it("MeshUpstream + EnrollmentRecord round-trip through JSON", () => {
    const upstream: MeshUpstream = {
      url: "wss://primary.acme.internal/tunnel",
      primaryPubKey: "ed25519:AAAA",
    };
    const status: EnrollmentStatus = "active";
    const record: EnrollmentRecord = {
      workload: "laptop",
      pinnedProxyPubKey: "ed25519:BBBB",
      joinTokenHash: "sha256:deadbeef",
      claimedAt: "2026-06-30T10:00:00.000Z",
      status,
    };
    expect(JSON.parse(JSON.stringify(upstream))).toEqual(upstream);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("Attribution generalizes agentId-only 'who' (principal/grantRef/policyRef optional)", () => {
    const minimal: Attribution = { agent: "codex" };
    expectAssignable<Attribution>(minimal);
    expect("principal" in minimal).toBe(false);
  });
});

describe("mesh Frame union — published tunnel language", () => {
  const entry: CapabilityEntry = {
    id: "mcp.github.create_issue",
    source: "mcp:github",
    kind: "capability",
    label: "Create GitHub issue",
    describe: "Open an issue. Use when filing a bug.",
    grants: ["write"],
    transport: "mcp",
  };

  const invokeResult: InvokeResponse = {
    id: "mcp.github.create_issue",
    ok: true,
    output: { number: 42 },
    auditId: "evt-9",
  };

  it("every Frame variant carries { t, corr, payload } and round-trips through JSON", () => {
    const frames: Frame[] = [
      {
        t: "enroll",
        corr: "c1",
        payload: {
          workload: "laptop",
          mode: "proxy",
          proxyPubKey: "ed25519:BBBB",
          joinToken: "jt-once",
          upstream: { url: "wss://p/tunnel", primaryPubKey: "ed25519:AAAA" },
        },
      } satisfies EnrollFrame,
      {
        t: "catalog",
        corr: "c2",
        payload: { workload: "laptop", entries: [entry], revision: 1, withdrawn: [] },
      } satisfies CatalogFrame,
      {
        t: "invoke",
        corr: "c3",
        payload: {
          address: "local/laptop/mcp.github.create_issue",
          id: "mcp.github.create_issue",
          input: { title: "bug" },
          idempotencyKey: "idem-1",
        },
      } satisfies InvokeFrame,
      {
        t: "invoke-result",
        corr: "c3",
        payload: invokeResult,
      } satisfies InvokeResultFrame,
      {
        t: "audit",
        corr: "c3",
        payload: {
          type: "invoke",
          id: "evt-9",
          at: "2026-06-30T10:00:01.000Z",
          tier: "proxy",
          correlationId: "c3",
        },
      } satisfies AuditFrame,
      { t: "ping", corr: "c4", payload: { at: "2026-06-30T10:00:02.000Z" } } satisfies PingFrame,
    ];

    const round = JSON.parse(JSON.stringify(frames)) as Frame[];
    expect(round).toEqual(frames);
    expect(round.map((f) => f.t)).toEqual([
      "enroll",
      "catalog",
      "invoke",
      "invoke-result",
      "audit",
      "ping",
    ]);
    // Discriminated-union narrowing on `t` works as the wire contract intends.
    const inv = round.find((f) => f.t === "invoke");
    if (inv && inv.t === "invoke") {
      expect(inv.payload.address).toBe("local/laptop/mcp.github.create_issue");
    } else {
      throw new Error("invoke frame missing");
    }
    // invoke-result pairs with its invoke by `corr`.
    const res = round.find((f) => f.t === "invoke-result");
    expect(res?.corr).toBe("c3");
  });
});
