/**
 * Apple Contacts FIRST-PARTY source — scan/health/read-only unit + END-TO-END through
 * the gateway. Hermetic under `PLEXUS_FAKE_APPLE=1` (fake provider — no macOS, no TCC).
 *
 * Asserts:
 *   - the source registers as FIRST-PARTY; `scan()` yields the two read caps + skill;
 *   - STRICTLY READ-ONLY: every capability's grants are exactly ["read"] — NO write/
 *     execute verb exists anywhere in the module, and no id carries a mutating verb;
 *   - health() reflects provider.available() (ok under fake; unavailable + the precise
 *     System Settings ▸ Privacy & Security ▸ Automation onboarding reason when denied);
 *   - validation: query required, limit clamped (default 20, hard cap 50), id required;
 *   - through the real pipeline: contacts.search by name/email/phone-digits with the
 *     bound respected + truncated flag; contacts.read returns the full card.
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
  AppleContactsSource,
  APPLE_CONTACTS_SOURCE_ID,
  CONTACTS_SEARCH_ID,
  CONTACTS_READ_ID,
  CONTACTS_SKILL_ID,
  appleContactsEntries,
} from "@plexus/runtime/sources/index.ts";
import { AppleContactsBridge } from "@plexus/runtime/sources/apple-contacts/bridge.ts";
import {
  FakeContactsProvider,
  CONTACTS_SEARCH_LIMIT_DEFAULT,
  CONTACTS_SEARCH_LIMIT_MAX,
  clampContactsLimit,
  validateContactsSearchInput,
  validateContactsReadInput,
  ContactsInputError,
  fakeContactCards,
} from "@plexus/runtime/sources/apple-contacts/provider.ts";

/** A minimal BridgeDeps stub (the bridge serves the read ops in-process). */
function stubDeps(): { deps: BridgeDeps; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  const byId = new Map(appleContactsEntries().map((e) => [e.id, e]));
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
  const dir = mkdtempSync(join(tmpdir(), "plexus-applecontacts-"));
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
  // AUTHORIZED SUBSET (ADR-023, fail-closed): an agent-bound session sees/grants only
  // what the owner authorized. Declare agent-1's subset = this source's capabilities so
  // these tests keep exercising the SOURCE e2e semantics, not the subset gate.
  state.agentSubsets.set("agent-1", [CONTACTS_SEARCH_ID, CONTACTS_READ_ID]);
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
describe("apple-contacts: first-party provenance + read-only scan/health", () => {
  it("is reserved as a FIRST-PARTY source id", () => {
    expect(provenanceFor(APPLE_CONTACTS_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields EXACTLY the two read capabilities + the how-to-use skill", async () => {
    const source = new AppleContactsSource({ provider: new FakeContactsProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const search = byId.get(CONTACTS_SEARCH_ID)!;
    const read = byId.get(CONTACTS_READ_ID)!;
    const skill = byId.get(CONTACTS_SKILL_ID)!;

    expect(search.kind).toBe("capability");
    expect(search.grants).toEqual(["read"]);
    expect(read.grants).toEqual(["read"]);
    expect(skill.kind).toBe("skill");
    expect(skill.body?.markdown).toContain("read-only");

    // The skill is attached to BOTH capabilities.
    expect(search.skills?.some((s) => s.id === CONTACTS_SKILL_ID)).toBe(true);
    expect(read.skills?.some((s) => s.id === CONTACTS_SKILL_ID)).toBe(true);
    expect(entries.filter((e) => e.kind === "capability").length).toBe(2);
  });

  it("NO write-verb capability exists: grants are exactly ['read'] (skill: []) and no id carries a mutating verb", async () => {
    const source = new AppleContactsSource({ provider: new FakeContactsProvider() });
    const entries = await source.scan();
    for (const e of entries) {
      if (e.kind === "capability") expect(e.grants).toEqual(["read"]);
      else expect(e.grants).toEqual([]);
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
      expect(e.id).not.toMatch(/create|update|delete|merge|write|add|edit/i);
    }
  });

  it("health() reflects provider.available(): ok under fake; unavailable + the precise Automation onboarding reason when denied", async () => {
    const okSource = new AppleContactsSource({ provider: new FakeContactsProvider() });
    expect(await okSource.health()).toEqual({ status: "ok" });

    const denied = new AppleContactsSource({ provider: new FakeContactsProvider({ notAuthorized: true }) });
    const h = await denied.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("Contacts access not granted");
    expect(h.detail).toContain("Privacy & Security");
    expect(h.detail).toContain("Automation");
  });
});

// ── Validation bounds (pure) ──────────────────────────────────────────────────
describe("apple-contacts: input validation + bounds", () => {
  it("limit clamps: default 20, hard cap 50, floor 1", () => {
    expect(clampContactsLimit(undefined)).toBe(CONTACTS_SEARCH_LIMIT_DEFAULT);
    expect(clampContactsLimit(9999)).toBe(CONTACTS_SEARCH_LIMIT_MAX);
    expect(clampContactsLimit(0)).toBe(1);
    expect(validateContactsSearchInput({ query: "x" }).limit).toBe(CONTACTS_SEARCH_LIMIT_DEFAULT);
    expect(validateContactsSearchInput({ query: "x", limit: 500 }).limit).toBe(CONTACTS_SEARCH_LIMIT_MAX);
  });

  it("query and id are required and length-capped", () => {
    expect(() => validateContactsSearchInput({})).toThrow(ContactsInputError);
    expect(() => validateContactsSearchInput({ query: "  " })).toThrow(ContactsInputError);
    expect(() => validateContactsSearchInput({ query: "x".repeat(200) })).toThrow(/too long/);
    expect(() => validateContactsReadInput({})).toThrow(ContactsInputError);
    expect(() => validateContactsReadInput({ id: "" })).toThrow(ContactsInputError);
    expect(validateContactsReadInput({ id: " person-1 " }).id).toBe("person-1");
  });
});

// ── End-to-end through the gateway pipeline (fake provider via env) ────────────
describe("apple-contacts: end-to-end through the gateway (PLEXUS_FAKE_APPLE=1)", () => {
  it("boots first-party, appears in the handshake manifest read-only", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();

    const hs = await handshake(app, state);
    const entries = hs.manifest.entries.filter((e) => e.source === APPLE_CONTACTS_SOURCE_ID);
    const search = entries.find((e) => e.id === CONTACTS_SEARCH_ID);

    expect(search?.provenance).toBe("first-party");
    expect(search?.grants).toEqual(["read"]);
    for (const e of entries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    expect(entries.filter((e) => e.kind === "capability").length).toBe(2);
    expect(entries.some((e) => e.id === CONTACTS_SKILL_ID && e.kind === "skill")).toBe(true);
  });

  it("contacts.search matches by name, email, and phone digits", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, CONTACTS_SEARCH_ID);

    const byName = await invoke(app, token.token, CONTACTS_SEARCH_ID, { query: "dana" });
    expect(byName.ok).toBe(true);
    expect((byName.output as { contacts: { id: string }[] }).contacts.map((c) => c.id)).toEqual(["person-1"]);

    const byEmail = await invoke(app, token.token, CONTACTS_SEARCH_ID, { query: "work.example" });
    expect(byEmail.ok).toBe(true);
    expect((byEmail.output as { contacts: { name: string }[] }).contacts.map((c) => c.name)).toEqual(["Maya Ortiz"]);

    const byPhone = await invoke(app, token.token, CONTACTS_SEARCH_ID, { query: "555-0134" });
    expect(byPhone.ok).toBe(true);
    expect((byPhone.output as { contacts: { id: string }[] }).contacts.map((c) => c.id)).toEqual(["person-1"]);
  });

  it("contacts.search RESPECTS the limit bound and reports truncated", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, CONTACTS_SEARCH_ID);

    // "example" hits all three fixture cards (emails) — limit 2 truncates.
    const out = await invoke(app, token.token, CONTACTS_SEARCH_ID, { query: "example", limit: 2 });
    expect(out.ok).toBe(true);
    const res = out.output as { contacts: unknown[]; total: number; truncated: boolean };
    expect(res.contacts.length).toBe(2);
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it("contacts.read returns the FULL card (name, org, birthday, labeled emails/phones/addresses)", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, CONTACTS_READ_ID);

    const out = await invoke(app, token.token, CONTACTS_READ_ID, { id: "person-1" });
    expect(out.ok).toBe(true);
    const card = (
      out.output as {
        contact: {
          name: string;
          firstName: string | null;
          organization: string | null;
          birthday: string | null;
          emails: { label: string | null; value: string }[];
          phones: { label: string | null; value: string }[];
          addresses: { label: string | null; value: string }[];
        };
      }
    ).contact;
    expect(card.name).toBe("Dana Chen");
    expect(card.firstName).toBe("Dana");
    expect(card.organization).toBe("Chen Design Co");
    expect(card.birthday).toBe("1990-03-14");
    expect(card.emails).toEqual([
      { label: "Home", value: "dana@example.com" },
      { label: "Work", value: "dana@chendesign.example" },
    ]);
    expect(card.phones[0]!.value).toContain("555-0134");
    expect(card.addresses[0]!.value).toContain("San Francisco");
    // Matches the fixture exactly (nothing invented, nothing dropped).
    expect(card).toEqual(fakeContactCards()[0]! as typeof card);
  });

  it("bad input is rejected (invalid_input) BEFORE the provider; unknown id is a clear error", async () => {
    let searched = false;
    const provider = new FakeContactsProvider();
    const tracking = new Proxy(provider, {
      get(target, prop, recv) {
        if (prop === "searchContacts") {
          return (...args: Parameters<typeof target.searchContacts>) => {
            searched = true;
            return target.searchContacts(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const { deps } = stubDeps();
    const bridge = new AppleContactsBridge(deps, "s1", appleContactsEntries(), tracking);
    const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

    const bad = await bridge.invoke({ id: CONTACTS_SEARCH_ID, input: {} }, ctx);
    expect(bad.ok).toBe(false);
    expect((bad.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
    expect(searched).toBe(false);

    const missing = await bridge.invoke({ id: CONTACTS_READ_ID, input: { id: "nope" } }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toContain("no contact with id");
  });

  it("an Automation/TCC denial surfaces GRACEFULLY (clear onboarding message, not a crash)", async () => {
    const { deps } = stubDeps();
    const bridge = new AppleContactsBridge(
      deps,
      "s1",
      appleContactsEntries(),
      new FakeContactsProvider({ notAuthorized: true }),
    );
    const ctx: InvokeContext = { jti: "jti-2", sessionId: "s1", agentId: "agentX", scopes: [] };

    const out = await bridge.invoke({ id: CONTACTS_SEARCH_ID, input: { query: "dana" } }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("transport_error");
    expect(out.error?.message).toContain("Contacts access not granted");
    expect(out.error?.message).toContain("Automation");
    expect((out.error?.detail as { reason?: string })?.reason).toBe("not_authorized");
  });
});
