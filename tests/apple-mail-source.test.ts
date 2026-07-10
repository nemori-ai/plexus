/**
 * Apple Mail FIRST-PARTY source — scan/health/read-only unit + END-TO-END through the
 * gateway. Hermetic under `PLEXUS_FAKE_APPLE=1` (fake provider — no macOS, no TCC).
 *
 * Asserts:
 *   - the source registers as FIRST-PARTY; `scan()` yields the three read caps + skill;
 *   - STRICTLY READ-ONLY: every entry's grants are exactly ["read"] (skill: []) — NO
 *     write/execute verb exists anywhere in the module, and no capability id contains a
 *     mutating verb (send/draft/create/delete/move/...);
 *   - health() reflects provider.available() (ok under fake; unavailable + the precise
 *     System Settings ▸ Privacy & Security ▸ Automation onboarding reason when denied);
 *   - validation: limit clamps (default 20, hard cap 50), bad dates / reversed range /
 *     bad ids are rejected BEFORE the provider is touched;
 *   - through the real pipeline (handshake → grant read → invoke): mailboxes.list,
 *     bounded messages.search (newest-first + truncated flag), message.read with body
 *     truncation, and a graceful not-authorized error.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  HandshakeResponse,
  InvokeContext,
  InvokeResponse,
  ScopedToken,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { provenanceFor } from "@plexus/runtime/core/capability-registry.ts";
import {
  AppleMailSource,
  APPLE_MAIL_SOURCE_ID,
  MAIL_MAILBOXES_LIST_ID,
  MAIL_MESSAGES_SEARCH_ID,
  MAIL_MESSAGE_READ_ID,
  MAIL_SKILL_ID,
  appleMailEntries,
} from "@plexus/runtime/sources/index.ts";
import { AppleMailBridge } from "@plexus/runtime/sources/apple-mail/bridge.ts";
import {
  FakeMailProvider,
  MAIL_SEARCH_LIMIT_DEFAULT,
  MAIL_SEARCH_LIMIT_MAX,
  MAIL_CONTENT_MAX_CHARS,
  clampSearchLimit,
  validateSearchInput,
  validateReadInput,
  MailInputError,
} from "@plexus/runtime/sources/apple-mail/provider.ts";

/** A minimal BridgeDeps stub (the bridge serves the read ops in-process). */
function stubDeps(): { deps: BridgeDeps; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  const byId = new Map(appleMailEntries().map((e) => [e.id, e]));
  const deps: BridgeDeps = {
    audit: async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
    },
    getTransport: () => {
      throw new Error("not used by the in-process read handlers");
    },
    getEntry: (id) => byId.get(id),
    invokeById: async (req) => ({ id: req.id, ok: true, output: {}, auditId: "x" }),
  };
  return { deps, events };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-applemail-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const { app, state } = createAppWithState(config);
  return { app, state };
}

async function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId: "agent-1" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grant(app: ReturnType<typeof freshApp>["app"], sessionId: string, id: string): Promise<ScopedToken> {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

async function invoke(
  app: ReturnType<typeof freshApp>["app"],
  token: string,
  id: string,
  input: Record<string, unknown>,
): Promise<InvokeResponse> {
  const res = await req(app, "/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, input }),
  });
  return (await res.json()) as InvokeResponse;
}

beforeEach(() => {
  _resetSecretCacheForTests();
  process.env.PLEXUS_FAKE_APPLE = "1";
});

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
  delete process.env.PLEXUS_FAKE_APPLE;
});

// ── First-party provenance + STRICT read-only shape ───────────────────────────
describe("apple-mail: first-party provenance + read-only scan/health", () => {
  it("is reserved as a FIRST-PARTY source id", () => {
    expect(provenanceFor(APPLE_MAIL_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields EXACTLY the three read capabilities + the how-to-use skill", async () => {
    const source = new AppleMailSource({ provider: new FakeMailProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const boxes = byId.get(MAIL_MAILBOXES_LIST_ID)!;
    const search = byId.get(MAIL_MESSAGES_SEARCH_ID)!;
    const read = byId.get(MAIL_MESSAGE_READ_ID)!;
    const skill = byId.get(MAIL_SKILL_ID)!;

    expect(boxes.kind).toBe("capability");
    expect(boxes.grants).toEqual(["read"]);
    expect(search.grants).toEqual(["read"]);
    expect(read.grants).toEqual(["read"]);
    expect(skill.kind).toBe("skill");

    // The skill is attached to ALL THREE capabilities and states the safety story.
    for (const cap of [boxes, search, read]) {
      expect(cap.skills?.some((s) => s.id === MAIL_SKILL_ID)).toBe(true);
    }
    expect(skill.body?.markdown).toContain("read-only");
    expect(skill.body?.markdown?.toLowerCase()).toContain("no drafting");
    expect(skill.body?.markdown?.toLowerCase()).toContain("bounded");
    expect(entries.filter((e) => e.kind === "capability").length).toBe(3);
  });

  it("NO write-verb capability exists: every grant set is exactly ['read'] (skill: []) and no id carries a mutating verb", async () => {
    const source = new AppleMailSource({ provider: new FakeMailProvider() });
    const entries = await source.scan();
    for (const e of entries) {
      if (e.kind === "capability") expect(e.grants).toEqual(["read"]);
      else expect(e.grants).toEqual([]);
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
      // No mutating verb anywhere in the capability surface.
      expect(e.id).not.toMatch(/send|draft|create|delete|move|flag|reply|forward|write|update/i);
    }
  });

  it("health() reflects provider.available(): ok under fake; unavailable + the precise Automation onboarding reason when denied", async () => {
    const okSource = new AppleMailSource({ provider: new FakeMailProvider() });
    expect(await okSource.health()).toEqual({ status: "ok" });

    const denied = new AppleMailSource({ provider: new FakeMailProvider({ notAuthorized: true }) });
    const h = await denied.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("Mail access not granted");
    expect(h.detail).toContain("Privacy & Security");
    expect(h.detail).toContain("Automation");

    const reqs = await denied.checkRequirements();
    expect(reqs.ok).toBe(false);
  });
});

// ── Validation bounds (pure) ──────────────────────────────────────────────────
describe("apple-mail: input validation + bounds", () => {
  it("limit clamps: default 20, hard cap 50, floor 1", () => {
    expect(clampSearchLimit(undefined)).toBe(MAIL_SEARCH_LIMIT_DEFAULT);
    expect(clampSearchLimit(9999)).toBe(MAIL_SEARCH_LIMIT_MAX);
    expect(clampSearchLimit(-5)).toBe(1);
    expect(clampSearchLimit("not a number")).toBe(MAIL_SEARCH_LIMIT_DEFAULT);
    expect(validateSearchInput({}).limit).toBe(MAIL_SEARCH_LIMIT_DEFAULT);
    expect(validateSearchInput({ limit: 500 }).limit).toBe(MAIL_SEARCH_LIMIT_MAX);
  });

  it("mailbox defaults to INBOX; bad dates / reversed range / long strings are rejected", () => {
    expect(validateSearchInput({}).mailbox).toBe("INBOX");
    expect(() => validateSearchInput({ since: "not-a-date" })).toThrow(MailInputError);
    expect(() =>
      validateSearchInput({ since: "2026-07-01T00:00:00Z", before: "2026-06-01T00:00:00Z" }),
    ).toThrow(/after `since`/);
    expect(() => validateSearchInput({ sender: "x".repeat(300) })).toThrow(/too long/);
    expect(() => validateSearchInput({ mailbox: "" })).toThrow(MailInputError);
  });

  it("read args: id required (positive int), maxChars clamped into [200, 20000]", () => {
    expect(() => validateReadInput({})).toThrow(MailInputError);
    expect(() => validateReadInput({ id: "abc" })).toThrow(MailInputError);
    expect(validateReadInput({ id: "101" }).id).toBe(101);
    expect(validateReadInput({ id: 101 }).maxChars).toBe(MAIL_CONTENT_MAX_CHARS);
    expect(validateReadInput({ id: 101, maxChars: 5 }).maxChars).toBe(200);
    expect(validateReadInput({ id: 101, maxChars: 999999 }).maxChars).toBe(MAIL_CONTENT_MAX_CHARS);
  });
});

// ── End-to-end through the gateway pipeline (fake provider via env) ────────────
describe("apple-mail: end-to-end through the gateway (PLEXUS_FAKE_APPLE=1)", () => {
  it("boots first-party, appears in the handshake manifest read-only", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();

    const hs = await handshake(app, state);
    const mailEntries = hs.manifest.entries.filter((e) => e.source === APPLE_MAIL_SOURCE_ID);
    const search = mailEntries.find((e) => e.id === MAIL_MESSAGES_SEARCH_ID);

    expect(search?.provenance).toBe("first-party");
    expect(search?.grants).toEqual(["read"]);
    for (const e of mailEntries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    expect(mailEntries.filter((e) => e.kind === "capability").length).toBe(3);
    expect(mailEntries.some((e) => e.id === MAIL_SKILL_ID && e.kind === "skill")).toBe(true);
  });

  it("mailboxes.list returns accounts + mailboxes with unread counts", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, MAIL_MAILBOXES_LIST_ID);

    const out = await invoke(app, token.token, MAIL_MAILBOXES_LIST_ID, {});
    expect(out.ok).toBe(true);
    const accounts = (out.output as { accounts: { account: string; mailboxes: { name: string; unreadCount: number }[] }[] }).accounts;
    expect(accounts.map((a) => a.account)).toEqual(["iCloud", "Work"]);
    const icloudInbox = accounts[0]!.mailboxes.find((m) => m.name === "INBOX");
    expect(icloudInbox?.unreadCount).toBe(2);
  });

  it("messages.search: sender filter within the unified INBOX, newest-first", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, MAIL_MESSAGES_SEARCH_ID);

    const out = await invoke(app, token.token, MAIL_MESSAGES_SEARCH_ID, { sender: "dana" });
    expect(out.ok).toBe(true);
    const res = out.output as { messages: { id: string; subject: string; snippet: string }[]; total: number; truncated: boolean };
    // Only the INBOX message from Dana (the Archive one is out of scope).
    expect(res.messages.map((m) => m.id)).toEqual(["101"]);
    expect(res.truncated).toBe(false);
    expect(res.messages[0]!.snippet.length).toBeLessThanOrEqual(200);
    expect(res.messages[0]!.snippet).toContain("lunch");
  });

  it("messages.search: date-range + subject filters and the newest-first ordering across accounts", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, MAIL_MESSAGES_SEARCH_ID);

    // The unified INBOX holds 101/102/103 — newest-first is 102, 101, 103.
    const all = await invoke(app, token.token, MAIL_MESSAGES_SEARCH_ID, {});
    expect(all.ok).toBe(true);
    expect((all.output as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(["102", "101", "103"]);

    const ranged = await invoke(app, token.token, MAIL_MESSAGES_SEARCH_ID, {
      since: "2026-06-24T00:00:00Z",
      subject: "build",
    });
    expect(ranged.ok).toBe(true);
    expect((ranged.output as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(["102"]);
  });

  it("messages.search RESPECTS the limit bound and reports truncated", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, MAIL_MESSAGES_SEARCH_ID);

    const out = await invoke(app, token.token, MAIL_MESSAGES_SEARCH_ID, { limit: 1 });
    expect(out.ok).toBe(true);
    const res = out.output as { messages: { id: string }[]; total: number; truncated: boolean };
    expect(res.messages.length).toBe(1);
    expect(res.messages[0]!.id).toBe("102"); // newest
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it("message.read returns the plain-text body and NOTES truncation when capped", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, MAIL_MESSAGE_READ_ID);

    // Full read (fits the default cap).
    const full = await invoke(app, token.token, MAIL_MESSAGE_READ_ID, { id: "101" });
    expect(full.ok).toBe(true);
    const fullRes = full.output as { content: string; truncated: boolean; sender: string };
    expect(fullRes.truncated).toBe(false);
    expect(fullRes.content).toContain("lunch tomorrow");
    expect(fullRes.sender).toContain("Dana Chen");

    // Long body + small maxChars ⇒ truncated with the full length reported.
    const cut = await invoke(app, token.token, MAIL_MESSAGE_READ_ID, {
      id: "103",
      account: "Work",
      mailbox: "INBOX",
      maxChars: 250,
    });
    expect(cut.ok).toBe(true);
    const cutRes = cut.output as { content: string; truncated: boolean; totalChars: number };
    expect(cutRes.truncated).toBe(true);
    expect(cutRes.content.length).toBe(250);
    expect(cutRes.totalChars).toBeGreaterThan(250);
  });

  it("bad input is rejected (invalid_input) BEFORE the provider is touched", async () => {
    let searched = false;
    const provider = new FakeMailProvider();
    const tracking = new Proxy(provider, {
      get(target, prop, recv) {
        if (prop === "searchMessages") {
          return (...args: Parameters<typeof target.searchMessages>) => {
            searched = true;
            return target.searchMessages(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const { deps } = stubDeps();
    const bridge = new AppleMailBridge(deps, "s1", appleMailEntries(), tracking);
    const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

    const bad = await bridge.invoke(
      { id: MAIL_MESSAGES_SEARCH_ID, input: { since: "garbage" } },
      ctx,
    );
    expect(bad.ok).toBe(false);
    expect((bad.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
    expect(searched).toBe(false);

    const ok = await bridge.invoke({ id: MAIL_MESSAGES_SEARCH_ID, input: { sender: "ci" } }, ctx);
    expect(ok.ok).toBe(true);
    expect(searched).toBe(true);
  });

  it("an Automation/TCC denial surfaces GRACEFULLY (clear onboarding message, not a crash)", async () => {
    const { deps } = stubDeps();
    const bridge = new AppleMailBridge(
      deps,
      "s1",
      appleMailEntries(),
      new FakeMailProvider({ notAuthorized: true }),
    );
    const ctx: InvokeContext = { jti: "jti-2", sessionId: "s1", agentId: "agentX", scopes: [] };

    const out = await bridge.invoke({ id: MAIL_MAILBOXES_LIST_ID, input: {} }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("transport_error");
    expect(out.error?.message).toContain("Mail access not granted");
    expect(out.error?.message).toContain("Automation");
    expect((out.error?.detail as { reason?: string })?.reason).toBe("not_authorized");
  });
});
