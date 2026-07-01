/**
 * D2-CONSOLE — focused unit test for the "Connect an agent" flow. No DOM: the web-admin
 * has no jsdom/happy-dom/testing-library wired (and the repo's Playwright deps are
 * tolerated-missing), so instead of rendering the React wizard we test the two seams the
 * flow hangs on:
 *   (1) the pure request-shaping + "why skipped" helpers (connect.ts), and
 *   (2) the api client actually calling `POST /admin/api/agents/connect` and
 *       `GET /integration/:agentId` with the management key attached, and returning the
 *       copy-able `installCommand`.
 * Together these exercise form-state → API call → installCommand without a browser.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { CapabilityEntry } from "@plexus/protocol";
import { buildConnectBody, explainSkipped, AGENT_TYPES } from "./connect.ts";
import { api, rememberManagementKey, forgetManagementKey } from "./api.ts";

// A minimal CapabilityEntry factory — only the fields the helpers read.
function entry(partial: Partial<CapabilityEntry> & { id: string }): CapabilityEntry {
  return {
    source: "test",
    kind: "capability",
    label: partial.id,
    describe: "",
    grants: [],
    transport: "local-rest",
    ...partial,
  } as CapabilityEntry;
}

describe("connect.ts pure helpers", () => {
  it("buildConnectBody trims the id, de-dupes + sorts caps, threads the trust-window", () => {
    const body = buildConnectBody(
      "  research-bot  ",
      "claude-code",
      ["b.cap", "a.cap", "b.cap"],
      { kind: "7d" },
    );
    expect(body).toEqual({
      agentId: "research-bot",
      agentType: "claude-code",
      capabilities: ["a.cap", "b.cap"],
      trustWindow: { kind: "7d" },
    });
  });

  it("buildConnectBody omits trustWindow when none is given", () => {
    const body = buildConnectBody("agent-x", "generic", []);
    expect(body).toEqual({ agentId: "agent-x", agentType: "generic", capabilities: [] });
    expect("trustWindow" in body).toBe(false);
  });

  it("explainSkipped explains execute + high-sensitivity + unknown caps distinctly", () => {
    expect(explainSkipped("x", entry({ id: "x", grants: ["execute"] }))).toMatch(/execute/i);
    expect(explainSkipped("y", entry({ id: "y", grants: ["write"], sensitivity: "high" }))).toMatch(
      /high-sensitivity/i,
    );
    expect(explainSkipped("z", entry({ id: "z", grants: ["read"] }))).toMatch(/per-use/i);
    expect(explainSkipped("gone", undefined)).toMatch(/no longer exposed/i);
  });

  it("exposes the two agent-types (Claude Code bespoke + generic)", () => {
    expect(AGENT_TYPES.map((t) => t.value)).toEqual(["claude-code", "generic"]);
  });
});

describe("api client — connect + integration wire calls", () => {
  const KEY = "test-connection-key";
  let calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    rememberManagementKey(KEY);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      const body =
        url.startsWith("/integration/")
          ? {
              ok: true,
              agentId: "research-bot",
              dirName: "plexus@research-bot",
              version: "1",
              installCommand:
                "curl -fsSL http://127.0.0.1:7077/... | PLEXUS_ENROLL_CODE=abc123 bash",
              files: [],
              capabilities: ["a.cap"],
              codeExpiresAt: "2026-01-01T00:00:00.000Z",
            }
          : {
              ok: true,
              agentId: "research-bot",
              agentType: "claude-code",
              code: "abc123",
              expiresAt: "2026-01-01T00:00:00.000Z",
              enrollUrl: "http://127.0.0.1:7077/link/enroll",
              handshakeUrl: "http://127.0.0.1:7077/link/handshake",
              granted: [],
              skipped: ["exec.cap"],
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    forgetManagementKey();
  });

  it("connectAgent POSTs /admin/api/agents/connect with the mgmt key + body", async () => {
    const res = await api.connectAgent(
      buildConnectBody("research-bot", "claude-code", ["a.cap"], { kind: "7d" }),
    );
    expect(res.ok).toBe(true);
    expect(res.skipped).toEqual(["exec.cap"]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("/admin/api/agents/connect");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("X-Plexus-Connection-Key")).toBe(KEY);
    expect(JSON.parse(call.init.body as string)).toEqual({
      agentId: "research-bot",
      capabilities: ["a.cap"],
      agentType: "claude-code",
      trustWindow: { kind: "7d" },
    });
  });

  it("integration GETs /integration/:agentId (mgmt-key gated) and returns installCommand", async () => {
    const res = await api.integration("research-bot");
    expect(res.installCommand).toContain("PLEXUS_ENROLL_CODE=");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("/integration/research-bot");
    const headers = new Headers(call.init.headers);
    expect(headers.get("X-Plexus-Connection-Key")).toBe(KEY);
  });

  it("revokeAgent POSTs /admin/api/agents/revoke with the agentId", async () => {
    await api.revokeAgent("research-bot");
    const call = calls[0]!;
    expect(call.url).toBe("/admin/api/agents/revoke");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual({ agentId: "research-bot" });
  });
});
