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
import {
  buildConnectBody,
  explainSkipped,
  enrollmentBadge,
  enrollmentStatusFor,
  AGENT_TYPES,
  capGroupKey,
  humanizeGroupKey,
  groupCapabilities,
  triStateFor,
  cascadeSelection,
} from "./connect.ts";
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

describe("connect.ts enrollment status helpers", () => {
  it("enrollmentBadge distinguishes pending (amber) from active/connected and revoked", () => {
    const pending = enrollmentBadge("pending");
    expect(pending?.label).toBe("Pending");
    expect(pending?.className).toBe("badge-enroll-pending");
    expect(pending?.title).toMatch(/awaiting install|not yet enrolled/i);

    const active = enrollmentBadge("active");
    expect(active?.label).toBe("Connected");
    expect(active?.className).toBe("badge-enroll-active");

    expect(enrollmentBadge("revoked")?.className).toBe("badge-enroll-revoked");
  });

  it("enrollmentBadge returns null with no enrollment record (grants-only fallback)", () => {
    expect(enrollmentBadge(undefined)).toBeNull();
  });

  it("enrollmentStatusFor merges an agent's status by id, else undefined", () => {
    const rows = [
      { agentId: "research-bot", status: "pending" as const },
      { agentId: "ci-bot", status: "active" as const },
    ];
    expect(enrollmentStatusFor("research-bot", rows)).toBe("pending");
    expect(enrollmentStatusFor("ci-bot", rows)).toBe("active");
    // No enrollment record ⇒ undefined (older / grants-only agent).
    expect(enrollmentStatusFor("legacy", rows)).toBeUndefined();
  });
});

describe("connect.ts step-2 grouping helpers", () => {
  it("capGroupKey prefers the source field, else the first dotted id segment", () => {
    expect(capGroupKey(entry({ id: "obsidian-rest.vault.read", source: "obsidian-rest" }))).toBe(
      "obsidian-rest",
    );
    // No source → fall back to the first dotted segment of the id.
    expect(capGroupKey(entry({ id: "apple-reminders.reminders.list", source: "" }))).toBe(
      "apple-reminders",
    );
    // Un-dotted id with no source → the id itself.
    expect(capGroupKey(entry({ id: "codex", source: "" }))).toBe("codex");
  });

  it("humanizeGroupKey title-cases across -, _ and .", () => {
    expect(humanizeGroupKey("obsidian-rest")).toBe("Obsidian Rest");
    expect(humanizeGroupKey("apple_reminders")).toBe("Apple Reminders");
    expect(humanizeGroupKey("cc-master")).toBe("Cc Master");
    expect(humanizeGroupKey("codex")).toBe("Codex");
  });

  it("groupCapabilities groups by source and sorts groups by label", () => {
    const entries = [
      entry({ id: "obsidian-rest.vault.write", source: "obsidian-rest" }),
      entry({ id: "codex.run", source: "codex" }),
      entry({ id: "obsidian-rest.vault.read", source: "obsidian-rest" }),
      entry({ id: "apple-reminders.reminders.list", source: "apple-reminders" }),
    ];
    const groups = groupCapabilities(entries);
    // Sorted by label: Apple Reminders, Codex, Obsidian Rest.
    expect(groups.map((g) => g.key)).toEqual(["apple-reminders", "codex", "obsidian-rest"]);
    expect(groups.map((g) => g.label)).toEqual(["Apple Reminders", "Codex", "Obsidian Rest"]);
    // Members preserved in arrival order within a group.
    const obsidian = groups.find((g) => g.key === "obsidian-rest")!;
    expect(obsidian.entries.map((e) => e.id)).toEqual([
      "obsidian-rest.vault.write",
      "obsidian-rest.vault.read",
    ]);
  });

  it("triStateFor derives checked / unchecked / indeterminate from the selected-set", () => {
    const ids = ["a", "b", "c"];
    expect(triStateFor(ids, new Set())).toBe("unchecked");
    expect(triStateFor(ids, new Set(["a", "b", "c"]))).toBe("checked");
    expect(triStateFor(ids, new Set(["a"]))).toBe("indeterminate");
    expect(triStateFor(ids, new Set(["a", "b"]))).toBe("indeterminate");
    // Empty id-list reads as unchecked (no group to be "all selected").
    expect(triStateFor([], new Set(["a"]))).toBe("unchecked");
  });

  it("cascadeSelection adds/removes just the given ids, returning a new set", () => {
    const before = new Set(["x", "a"]);
    const added = cascadeSelection(before, ["a", "b", "c"], true);
    expect([...added].sort()).toEqual(["a", "b", "c", "x"]);
    // Original untouched (source of truth stays authoritative).
    expect([...before].sort()).toEqual(["a", "x"]);

    const removed = cascadeSelection(before, ["a", "b", "c"], false);
    expect([...removed]).toEqual(["x"]);
  });

  it("cascade round-trips a group between unchecked and checked", () => {
    const ids = ["g.read", "g.write", "g.list"];
    const all = cascadeSelection(new Set(), ids, true);
    expect(triStateFor(ids, all)).toBe("checked");
    const none = cascadeSelection(all, ids, false);
    expect(triStateFor(ids, none)).toBe("unchecked");
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
