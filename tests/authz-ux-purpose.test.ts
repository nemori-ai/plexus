/**
 * AUTHZ-UX Phase 1 — N1 (agent purpose) + N2 (transparent card data).
 *
 * Asserts the additive transparency layer (frozen wire 0.1.2 — every change is a new
 * OPTIONAL field):
 *   - the agent's declared `purpose` threads agent → PendingView.agentPurpose + audit
 *     detail.agentPurpose (truncated/sanitized);
 *   - `purpose` >280 chars is truncated server-side; control chars are stripped;
 *   - an absent purpose renders gracefully (field simply absent → UI shows fallback);
 *   - the gateway-authored `PendingNarration.summary` is UNCHANGED and NEVER contains
 *     the agent's purpose text (anti-injection — the human sees them separately);
 *   - the gateway-authored `notificationLine` is built + capped, quoting the purpose;
 *   - `PendingView.client` carries the handshake client name/version for the UI chip.
 *
 * Driven through the published wire + the admin pending channel — no fake-green.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  CapabilityId,
  SourceRegistry,
  SourceModule,
  Transport,
  TransportKind,
  CapabilityBridge,
  BridgeDeps,
  InvokeRequest,
  InvokeContext,
  InvokeResponse,
  HandshakeResponse,
  GrantResponse,
  GrantPendingResponse,
  AuditEvent,
} from "@plexus/protocol";
import { createAppWithState } from "../src/core/server.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import { loadConfig, expectedHost } from "../src/config.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "../src/auth/index.ts";
import {
  sanitizePurpose,
  MAX_AGENT_PURPOSE_CHARS,
  type PendingView,
} from "../src/core/grant-service.ts";

// A managed-source WRITE — always pends under the default authorizer (the human surface).
const MANAGED_WRITE: CapabilityEntry = {
  id: "obsidian-rest.vault.write",
  source: "obsidian-rest",
  kind: "capability",
  label: "Write the Obsidian vault (REST)",
  describe: "Write a vault note over the local REST API.",
  grants: ["write"],
  transport: "local-rest",
};
const ALL_ENTRIES = [MANAGED_WRITE];

class MockBridge implements CapabilityBridge {
  readonly source = "mock";
  getCapabilities(): CapabilityEntry[] {
    return ALL_ENTRIES;
  }
  route(id: CapabilityId) {
    return ALL_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
  }
  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    void ctx;
    return { id: req.id, ok: true, output: { ran: req.id }, auditId: "evt_x" };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => ({
      id: "mock",
      label: "Mock",
      transport: "local-rest" as const,
      checkRequirements: async () => ({ ok: true }),
      scan: async () => ALL_ENTRIES,
      start: async () => {},
      stop: async () => {},
    }),
    createBridge: (_deps: BridgeDeps, _sid: string) => new MockBridge(),
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind: TransportKind) => ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-purpose-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of ALL_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  const authorizer = defaultAuthorizer({
    managedSources: () => new Set(["obsidian-rest"]),
    defaultTrustWindows: config.auth.defaultTrustWindows,
  });
  const { app, state } = createAppWithState(config, { sources, capabilities, authorizer });
  capabilities.setPostureInputs({
    managedSourceIds: () => new Set(["obsidian-rest"]),
    defaultTrustWindows: config.auth.defaultTrustWindows,
  });
  return { app, state, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  client: Record<string, unknown>,
) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client }),
  });
  return (await res.json()) as HandshakeResponse;
}
async function putGrants(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  grants: Record<string, unknown>,
) {
  const res = await req(app, "/grants", { method: "PUT", body: JSON.stringify({ sessionId, grants }) });
  return (await res.json()) as GrantResponse;
}
async function listPending(app: ReturnType<typeof freshApp>["app"]): Promise<PendingView[]> {
  const res = await req(app, "/admin/api/pending");
  const body = (await res.json()) as { pending: PendingView[] };
  return body.pending;
}
async function auditEvents(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
): Promise<AuditEvent[]> {
  const key = state.connectionKey.current();
  const res = await req(app, "/admin/api/audit?limit=200", {
    headers: { "X-Plexus-Connection-Key": key },
  });
  const body = (await res.json()) as { events: AuditEvent[] };
  return body.events;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

// ════════════════════════════════════════════════════════════════════════════
// sanitizePurpose — the server-side anti-abuse pass (NEVER trust client length)
// ════════════════════════════════════════════════════════════════════════════
describe("AUTHZ-UX N1: sanitizePurpose (server-side cap + render-safe)", () => {
  it("truncates a >280-char purpose to exactly 280 chars", () => {
    const long = "x".repeat(500);
    const out = sanitizePurpose(long);
    expect(out).toBeDefined();
    expect(out!.length).toBe(MAX_AGENT_PURPOSE_CHARS);
  });

  it("strips control chars (newlines/tabs/escapes) — anti-injection", () => {
    const raw = "line one\nline\ttwo\u0007\u001b[31mred\u001b[0m";
    const out = sanitizePurpose(raw)!;
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\t");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    // The visible text survives (collapsed to single spaces).
    expect(out).toContain("line one");
    expect(out).toContain("red");
  });

  it("empty / whitespace-only / non-string ⇒ undefined (absent stays absent)", () => {
    expect(sanitizePurpose("")).toBeUndefined();
    expect(sanitizePurpose("   \n\t  ")).toBeUndefined();
    expect(sanitizePurpose(undefined)).toBeUndefined();
    expect(sanitizePurpose(42)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// purpose threads to PendingView + audit; narration stays gateway-only
// ════════════════════════════════════════════════════════════════════════════
describe("AUTHZ-UX N1/N2: purpose → pending view + audit; narration separation", () => {
  it("agent purpose appears on PendingView.agentPurpose, NEVER in the gateway summary", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, { name: "claude-code", version: "1.2.3", agentId: "agent-p" });
    const purpose = "Organize my NAS Inbox folder into dated subfolders.";
    const res = (await putGrants(app, hs.sessionId, {
      "obsidian-rest.vault.write": { decision: "allow", purpose },
    })) as GrantPendingResponse;
    expect(res.status).toBe("grant_pending_user");

    const pending = await listPending(app);
    const item = pending.find((p) => p.capabilities?.includes("obsidian-rest.vault.write"))!;
    expect(item).toBeDefined();
    // (1) purpose surfaced, labeled-and-separate (admin-facing projection).
    expect(item.agentPurpose).toBe(purpose);
    // client chip data carried from the handshake Session.
    expect(item.client).toEqual({ name: "claude-code", version: "1.2.3" });
    // (2) the gateway-authored summary is unchanged AND does NOT contain agent text.
    const n = item.pendingNarration!.find((x) => x.id === "obsidian-rest.vault.write")!;
    expect(n.summary).toContain("agent-p"); // gateway narration mentions the agent id
    expect(n.summary).toContain("revoke");
    expect(n.summary).not.toContain("Inbox"); // agent purpose text never merged in
    // (N2 / D7) the gateway-authored notificationLine quotes the purpose, capped.
    expect(n.notificationLine).toBeDefined();
    expect(n.notificationLine!).toContain("agent-p");
    expect(n.notificationLine!).toContain("WRITE");
    expect(n.notificationLine!.length).toBeLessThanOrEqual(120);
  });

  it("the grant.pending audit detail carries a (truncated) agentPurpose copy", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, { name: "cli", agentId: "agent-audit" });
    const long = "Reason: " + "y".repeat(400);
    await putGrants(app, hs.sessionId, {
      "obsidian-rest.vault.write": { decision: "allow", purpose: long },
    });
    const events = await auditEvents(app, state);
    const pendEvt = events.find(
      (e) => e.type === "grant.pending" && e.capabilityId === "obsidian-rest.vault.write",
    )!;
    expect(pendEvt).toBeDefined();
    const recorded = (pendEvt.detail as Record<string, unknown>).agentPurpose as string;
    expect(recorded).toBeDefined();
    expect(recorded.length).toBe(MAX_AGENT_PURPOSE_CHARS); // truncated in the audit too
  });

  it("absent purpose ⇒ PendingView.agentPurpose is undefined (UI shows fallback)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, { name: "cli", agentId: "agent-noreason" });
    await putGrants(app, hs.sessionId, { "obsidian-rest.vault.write": "allow" });
    const pending = await listPending(app);
    const item = pending.find((p) => p.agentId === "agent-noreason")!;
    expect(item).toBeDefined();
    expect(item.agentPurpose).toBeUndefined();
    // narration + notificationLine still present (gateway-authored, no purpose clause).
    const n = item.pendingNarration!.find((x) => x.id === "obsidian-rest.vault.write")!;
    expect(n.notificationLine).toBeDefined();
    expect(n.notificationLine!).not.toContain("\u201c"); // no quoted purpose clause
  });
});
